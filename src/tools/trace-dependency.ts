/**
 * trace_dependency Tool
 * 追踪特定依赖的完整路径和来源
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as path from "node:path";
import { readJsonFile, execCommand } from "../utils/index.js";
import {
  detectPackageManager,
  detectWorkspaces,
  getWorkspacePackages,
} from "../core/package-manager/index.js";
import type { PackageJson, WorkspaceInfo } from "../types/index.js";

// 输入参数 Schema
export const traceDependencySchema = z.object({
  projectPath: z.string().describe("项目根目录路径"),
  packageName: z.string().describe("要追踪的包名"),
  version: z.string().optional().describe("指定版本，不指定则追踪所有版本"),
});

export type TraceDependencyInput = z.infer<typeof traceDependencySchema>;

interface DependencyPath {
  chain: Array<{
    package: string;
    version: string;
    requirement: string;
  }>;
  depth: number;
  isDirectDependency: boolean;
  dependencyType: "prod" | "dev" | "peer" | "optional";
}

interface TraceDependencyOutput {
  package: string;
  installedVersions: Array<{
    version: string;
    location: string;
    usedBy: string[];
  }>;
  allPaths: DependencyPath[];
  impactAnalysis: {
    directDependents: string[];
    transitiveDepth: number;
    affectedWorkspaces: string[];
    estimatedImpact: "low" | "medium" | "high";
  };
  whyOutput: string;
  recommendation: string;
}

/**
 * 注册 trace_dependency tool
 */
export function registerTraceDependencyTool(server: McpServer): void {
  server.tool(
    "trace_dependency",
    "追踪特定依赖的完整路径，识别决策节点，分析影响范围。使用 npm why / pnpm why / yarn why 获取详细信息。",
    traceDependencySchema.shape,
    async (input: TraceDependencyInput) => {
      try {
        const result = await traceDependency(input);
        return {
          content: [
            {
              type: "text" as const,
              text: formatTraceReport(result),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `追踪依赖失败: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

/**
 * 追踪依赖
 */
async function traceDependency(
  input: TraceDependencyInput
): Promise<TraceDependencyOutput> {
  const { projectPath, packageName } = input;

  // 读取 package.json
  const packageJsonPath = path.join(projectPath, "package.json");
  const packageJson = await readJsonFile<PackageJson>(packageJsonPath);

  if (!packageJson) {
    throw new Error(`无法读取 package.json: ${packageJsonPath}`);
  }

  // 检测包管理器
  const pmInfo = await detectPackageManager(projectPath);

  // 检测 workspace
  const workspaceConfig = await detectWorkspaces(projectPath, pmInfo.name);
  const workspacePackages = await getWorkspacePackages(projectPath, workspaceConfig);

  // 执行 why 命令
  let whyCommand: string;
  switch (pmInfo.name) {
    case "npm":
      whyCommand = `npm why ${packageName}`;
      break;
    case "pnpm":
      whyCommand = `pnpm why ${packageName}`;
      break;
    case "yarn":
      whyCommand = `yarn why ${packageName}`;
      break;
    default:
      throw new Error(`不支持的包管理器: ${pmInfo.name}`);
  }

  const whyResult = await execCommand(whyCommand, projectPath);
  const whyOutput = whyResult.stdout || whyResult.stderr;

  // 解析 why 输出
  const paths = parseWhyOutput(whyOutput, pmInfo.name, packageName);

  // 检查是否是直接依赖
  const isDirectDep =
    packageJson.dependencies?.[packageName] !== undefined ||
    packageJson.devDependencies?.[packageName] !== undefined;

  // 获取安装的版本信息
  const installedVersions = await getInstalledVersions(
    projectPath,
    packageName,
    pmInfo.name
  );

  // 分析影响
  const directDependents = findDirectDependents(paths);
  const affectedWorkspaces = findAffectedWorkspaces(
    packageName,
    workspacePackages
  );

  // 计算影响级别
  let impact: "low" | "medium" | "high" = "low";
  if (installedVersions.length > 2 || directDependents.length > 5) {
    impact = "high";
  } else if (installedVersions.length > 1 || directDependents.length > 2) {
    impact = "medium";
  }

  // 生成建议
  const recommendation = generateRecommendation(
    packageName,
    isDirectDep,
    installedVersions,
    directDependents,
    impact
  );

  return {
    package: packageName,
    installedVersions,
    allPaths: paths,
    impactAnalysis: {
      directDependents,
      transitiveDepth: Math.max(...paths.map((p) => p.depth), 0),
      affectedWorkspaces,
      estimatedImpact: impact,
    },
    whyOutput,
    recommendation,
  };
}

/**
 * 解析 why 命令输出
 */
function parseWhyOutput(
  output: string,
  pm: string,
  packageName: string
): DependencyPath[] {
  const paths: DependencyPath[] = [];

  if (!output) return paths;

  const lines = output.split("\n").filter((l) => l.trim());

  if (pm === "npm") {
    // npm why 输出格式示例:
    // lodash@4.17.21
    // node_modules/lodash
    //   lodash@"^4.17.21" from the root project
    //   lodash@"^4.17.15" from express@4.18.2
    //   node_modules/express
    //     express@"^4.18.0" from the root project

    let currentPath: DependencyPath | null = null;

    for (const line of lines) {
      const fromMatch = line.match(/^\s+(.+?)@"(.+?)"\s+from\s+(.+)$/);
      if (fromMatch) {
        const [, dep, requirement, from] = fromMatch;
        const depth = (line.match(/^\s*/)?.[0].length || 0) / 2;

        if (!currentPath) {
          currentPath = {
            chain: [],
            depth: 0,
            isDirectDependency: from === "the root project",
            dependencyType: "prod",
          };
        }

        currentPath.chain.push({
          package: dep,
          version: "",
          requirement,
        });
        currentPath.depth = Math.max(currentPath.depth, depth);

        if (from === "the root project") {
          if (currentPath.chain.length > 0) {
            paths.push({ ...currentPath });
          }
          currentPath = null;
        }
      }
    }

    if (currentPath && currentPath.chain.length > 0) {
      paths.push(currentPath);
    }
  } else if (pm === "pnpm") {
    // pnpm why 输出格式
    let currentPath: DependencyPath | null = null;

    for (const line of lines) {
      if (line.includes(packageName)) {
        if (currentPath && currentPath.chain.length > 0) {
          paths.push(currentPath);
        }
        currentPath = {
          chain: [],
          depth: 0,
          isDirectDependency: false,
          dependencyType: "prod",
        };
      }

      if (currentPath) {
        const depMatch = line.match(/^\s*(.+?)\s+(\d+\.\d+\.\d+)/);
        if (depMatch) {
          currentPath.chain.push({
            package: depMatch[1],
            version: depMatch[2],
            requirement: "",
          });
          currentPath.depth = currentPath.chain.length;
        }
      }
    }

    if (currentPath && currentPath.chain.length > 0) {
      paths.push(currentPath);
    }
  } else if (pm === "yarn") {
    // yarn why 输出格式
    let currentPath: DependencyPath | null = null;

    for (const line of lines) {
      // yarn why 输出 "package@version" 形式
      const depMatch = line.match(/["'](.+?)@(.+?)["']/);
      if (depMatch) {
        if (!currentPath) {
          currentPath = {
            chain: [],
            depth: 0,
            isDirectDependency: false,
            dependencyType: "prod",
          };
        }

        currentPath.chain.push({
          package: depMatch[1],
          version: depMatch[2],
          requirement: "",
        });
      }

      if (line.includes("Reasons this module exists")) {
        if (currentPath && currentPath.chain.length > 0) {
          paths.push({ ...currentPath });
        }
        currentPath = null;
      }
    }

    if (currentPath && currentPath.chain.length > 0) {
      paths.push(currentPath);
    }
  }

  // 如果没有解析到路径，创建一个基本的
  if (paths.length === 0 && output.includes(packageName)) {
    paths.push({
      chain: [{ package: packageName, version: "", requirement: "" }],
      depth: 1,
      isDirectDependency: true,
      dependencyType: "prod",
    });
  }

  return paths;
}

/**
 * 获取安装的版本信息
 */
async function getInstalledVersions(
  projectPath: string,
  packageName: string,
  pm: string
): Promise<Array<{ version: string; location: string; usedBy: string[] }>> {
  const versions: Array<{ version: string; location: string; usedBy: string[] }> = [];

  let command: string;
  switch (pm) {
    case "npm":
      command = `npm ls ${packageName} --json --all`;
      break;
    case "pnpm":
      command = `pnpm list ${packageName} --json`;
      break;
    case "yarn":
      command = `yarn list --pattern "${packageName}" --json`;
      break;
    default:
      return versions;
  }

  const result = await execCommand(command, projectPath);

  try {
    if (pm === "npm" && result.stdout) {
      const data = JSON.parse(result.stdout);
      collectVersionsFromNpmLs(data, packageName, versions, "");
    }
  } catch {
    // 解析失败
  }

  // 去重
  const uniqueVersions = new Map<string, { version: string; location: string; usedBy: string[] }>();
  for (const v of versions) {
    if (!uniqueVersions.has(v.version)) {
      uniqueVersions.set(v.version, v);
    } else {
      const existing = uniqueVersions.get(v.version)!;
      existing.usedBy.push(...v.usedBy);
    }
  }

  return Array.from(uniqueVersions.values());
}

/**
 * 从 npm ls 输出收集版本
 */
function collectVersionsFromNpmLs(
  data: NpmLsData,
  targetPackage: string,
  versions: Array<{ version: string; location: string; usedBy: string[] }>,
  currentPath: string
): void {
  if (!data.dependencies) return;

  for (const [name, info] of Object.entries(data.dependencies)) {
    const path = currentPath ? `${currentPath} > ${name}` : name;

    if (name === targetPackage && info.version) {
      versions.push({
        version: info.version,
        location: info.path || path,
        usedBy: currentPath ? [currentPath.split(" > ").pop() || "root"] : ["root"],
      });
    }

    if (info.dependencies) {
      collectVersionsFromNpmLs(
        { dependencies: info.dependencies },
        targetPackage,
        versions,
        path
      );
    }
  }
}

interface NpmLsData {
  dependencies?: Record<string, {
    version?: string;
    path?: string;
    dependencies?: NpmLsData["dependencies"];
  }>;
}

/**
 * 查找直接依赖者
 */
function findDirectDependents(paths: DependencyPath[]): string[] {
  const dependents = new Set<string>();

  for (const p of paths) {
    if (p.chain.length >= 2) {
      // 倒数第二个是直接依赖者
      dependents.add(p.chain[p.chain.length - 2].package);
    }
  }

  return Array.from(dependents);
}

/**
 * 查找受影响的 workspace
 */
function findAffectedWorkspaces(
  packageName: string,
  workspaces: WorkspaceInfo[]
): string[] {
  const affected: string[] = [];

  for (const ws of workspaces) {
    const allDeps = {
      ...ws.packageJson.dependencies,
      ...ws.packageJson.devDependencies,
      ...ws.packageJson.peerDependencies,
    };

    if (allDeps[packageName]) {
      affected.push(ws.name);
    }
  }

  return affected;
}

/**
 * 生成建议
 */
function generateRecommendation(
  packageName: string,
  isDirectDep: boolean,
  installedVersions: Array<{ version: string }>,
  directDependents: string[],
  impact: "low" | "medium" | "high"
): string {
  const recommendations: string[] = [];

  if (installedVersions.length > 1) {
    recommendations.push(
      `${packageName} 存在 ${installedVersions.length} 个版本 (${installedVersions.map((v) => v.version).join(", ")})，` +
        "考虑使用 overrides/resolutions 统一版本"
    );
  }

  if (isDirectDep) {
    recommendations.push(
      `${packageName} 是直接依赖，可以直接在 package.json 中调整版本`
    );
  } else {
    recommendations.push(
      `${packageName} 是传递依赖，来自: ${directDependents.slice(0, 3).join(", ")}` +
        (directDependents.length > 3 ? ` 等 ${directDependents.length} 个包` : "")
    );
  }

  if (impact === "high") {
    recommendations.push(
      "⚠️ 该依赖影响范围较大，修改时需要充分测试"
    );
  }

  return recommendations.join("\n");
}

/**
 * 格式化追踪报告
 */
function formatTraceReport(output: TraceDependencyOutput): string {
  const lines: string[] = [];

  lines.push(`## 依赖追踪报告: ${output.package}\n`);

  // 安装的版本
  lines.push("### 已安装版本");
  if (output.installedVersions.length > 0) {
    lines.push("");
    lines.push("| 版本 | 位置 | 依赖者 |");
    lines.push("|------|------|--------|");
    for (const v of output.installedVersions) {
      lines.push(
        `| ${v.version} | ${v.location.slice(0, 50)} | ${v.usedBy.slice(0, 3).join(", ")} |`
      );
    }
  } else {
    lines.push("*未找到已安装版本*");
  }
  lines.push("");

  // 影响分析
  lines.push("### 影响分析");
  lines.push(`- **影响级别**: ${formatImpact(output.impactAnalysis.estimatedImpact)}`);
  lines.push(`- **传递深度**: ${output.impactAnalysis.transitiveDepth}`);
  lines.push(
    `- **直接依赖者**: ${output.impactAnalysis.directDependents.slice(0, 5).join(", ") || "无"}`
  );
  if (output.impactAnalysis.affectedWorkspaces.length > 0) {
    lines.push(
      `- **受影响 Workspace**: ${output.impactAnalysis.affectedWorkspaces.join(", ")}`
    );
  }
  lines.push("");

  // 依赖路径
  lines.push("### 依赖路径");
  if (output.allPaths.length > 0) {
    for (let i = 0; i < Math.min(output.allPaths.length, 5); i++) {
      const p = output.allPaths[i];
      const pathStr = p.chain
        .map((c) => `${c.package}${c.requirement ? `@${c.requirement}` : ""}`)
        .join(" → ");
      lines.push(`${i + 1}. ${pathStr}`);
    }
    if (output.allPaths.length > 5) {
      lines.push(`   *... 还有 ${output.allPaths.length - 5} 条路径*`);
    }
  } else {
    lines.push("*未找到依赖路径*");
  }
  lines.push("");

  // 原始 why 输出
  if (output.whyOutput) {
    lines.push("### 原始 Why 输出");
    lines.push("```");
    lines.push(output.whyOutput.slice(0, 1500));
    if (output.whyOutput.length > 1500) {
      lines.push("... (输出已截断)");
    }
    lines.push("```");
    lines.push("");
  }

  // 建议
  lines.push("### 建议");
  lines.push(output.recommendation);

  return lines.join("\n");
}

/**
 * 格式化影响级别
 */
function formatImpact(impact: "low" | "medium" | "high"): string {
  switch (impact) {
    case "low":
      return "🟢 低";
    case "medium":
      return "🟡 中";
    case "high":
      return "🔴 高";
  }
}
