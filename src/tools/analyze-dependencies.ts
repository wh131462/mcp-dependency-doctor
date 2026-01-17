/**
 * analyze_dependencies Tool
 * 解析项目的 package.json 和 lock 文件，构建完整依赖树
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
import type {
  PackageJson,
  DependencyNode,
  DependencyStats,
  FlatDependency,
  WorkspaceInfo,
} from "../types/index.js";

// 输入参数 Schema
export const analyzeDependenciesSchema = z.object({
  projectPath: z.string().describe("项目根目录路径"),
  depth: z.number().optional().default(10).describe("依赖树深度限制"),
  includeDevDependencies: z.boolean().optional().default(true),
  packageName: z.string().optional().describe("指定分析某个包的依赖"),
  workspace: z.string().optional().describe("指定分析某个 workspace"),
});

export type AnalyzeDependenciesInput = z.infer<typeof analyzeDependenciesSchema>;

interface AnalyzeDependenciesOutput {
  root: {
    name: string;
    version: string;
    path: string;
  };
  tree: DependencyNode[];
  flatList: FlatDependency[];
  stats: DependencyStats;
  workspacePackages: WorkspaceInfo[];
  rawOutput?: string;
}

/**
 * 注册 analyze_dependencies tool
 */
export function registerAnalyzeDependenciesTool(server: McpServer): void {
  server.tool(
    "analyze_dependencies",
    "解析项目的 package.json 和 lock 文件，构建完整依赖树，识别 hoist 行为和重复依赖。支持 npm/pnpm/yarn。",
    analyzeDependenciesSchema.shape,
    async (input: AnalyzeDependenciesInput) => {
      try {
        const result = await analyzeDependencies(input);
        return {
          content: [
            {
              type: "text" as const,
              text: formatDependencyReport(result),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `分析依赖失败: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

/**
 * 分析依赖
 */
async function analyzeDependencies(
  input: AnalyzeDependenciesInput
): Promise<AnalyzeDependenciesOutput> {
  const { projectPath, depth, includeDevDependencies, packageName, workspace } = input;

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

  // 构建依赖列表命令
  let command: string;
  let targetPath = projectPath;

  // 如果指定了 workspace，调整目标路径
  if (workspace) {
    const ws = workspacePackages.find(
      (w) => w.name === workspace || w.relativePath === workspace
    );
    if (ws) {
      targetPath = ws.path;
    }
  }

  switch (pmInfo.name) {
    case "npm":
      command = `npm ls --json --all --depth=${depth}`;
      if (packageName) {
        command += ` ${packageName}`;
      }
      if (!includeDevDependencies) {
        command += " --omit=dev";
      }
      break;
    case "pnpm":
      command = `pnpm list --json --depth=${depth}`;
      if (packageName) {
        command += ` ${packageName}`;
      }
      if (!includeDevDependencies) {
        command += " --prod";
      }
      break;
    case "yarn":
      // yarn 1.x 使用 yarn list
      command = `yarn list --json --depth=${depth}`;
      if (packageName) {
        command += ` --pattern "${packageName}"`;
      }
      if (!includeDevDependencies) {
        command += " --prod";
      }
      break;
    default:
      throw new Error(`不支持的包管理器: ${pmInfo.name}`);
  }

  const result = await execCommand(command, targetPath);

  // 解析输出
  const { tree, flatList, stats } = parseListOutput(
    result.stdout,
    result.stderr,
    pmInfo.name
  );

  return {
    root: {
      name: packageJson.name,
      version: packageJson.version,
      path: projectPath,
    },
    tree,
    flatList,
    stats,
    workspacePackages,
    rawOutput: result.stderr || undefined,
  };
}

/**
 * 解析命令输出
 */
function parseListOutput(
  stdout: string,
  stderr: string,
  pm: string
): { tree: DependencyNode[]; flatList: FlatDependency[]; stats: DependencyStats } {
  const tree: DependencyNode[] = [];
  const flatMap = new Map<string, FlatDependency>();
  let maxDepth = 0;
  let prodCount = 0;
  let devCount = 0;

  try {
    if (pm === "npm") {
      const data = JSON.parse(stdout);
      if (data.dependencies) {
        parseNpmDependencies(data.dependencies, tree, flatMap, 0, (d) => {
          maxDepth = Math.max(maxDepth, d);
        });
      }
    } else if (pm === "pnpm") {
      // pnpm 输出可能是数组
      const lines = stdout.trim().split("\n");
      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          if (Array.isArray(data)) {
            for (const item of data) {
              if (item.dependencies) {
                parsePnpmDependencies(item.dependencies, tree, flatMap, 0, (d) => {
                  maxDepth = Math.max(maxDepth, d);
                });
              }
            }
          } else if (data.dependencies) {
            parsePnpmDependencies(data.dependencies, tree, flatMap, 0, (d) => {
              maxDepth = Math.max(maxDepth, d);
            });
          }
        } catch {
          // 忽略非 JSON 行
        }
      }
    } else if (pm === "yarn") {
      // yarn list --json 输出每行一个 JSON
      const lines = stdout.trim().split("\n");
      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          if (data.type === "tree" && data.data?.trees) {
            parseYarnDependencies(data.data.trees, tree, flatMap, 0, (d) => {
              maxDepth = Math.max(maxDepth, d);
            });
          }
        } catch {
          // 忽略非 JSON 行
        }
      }
    }
  } catch {
    // 解析失败，从 stderr 提取问题
    if (stderr) {
      const problemNode: DependencyNode = {
        name: "PARSE_ERROR",
        version: "0.0.0",
        specifier: "",
        dependencyType: "prod",
        hoisted: false,
        deduped: false,
        location: "",
        dependencies: [],
        peerDependencies: {},
        problems: [stderr],
      };
      tree.push(problemNode);
    }
  }

  // 统计
  for (const dep of flatMap.values()) {
    // 简单统计
    prodCount += dep.versions.length;
  }

  const flatList = Array.from(flatMap.values());
  const uniquePackages = flatList.length;
  const totalPackages = flatList.reduce((sum, d) => sum + d.versions.length, 0);
  const duplicates = flatList.filter((d) => d.versions.length > 1);

  return {
    tree,
    flatList,
    stats: {
      totalPackages,
      uniquePackages,
      duplicatePackages: duplicates.length,
      maxDepth,
      prodDependencies: prodCount,
      devDependencies: devCount,
    },
  };
}

/**
 * 解析 npm ls 输出
 */
function parseNpmDependencies(
  deps: Record<string, NpmDependencyEntry>,
  tree: DependencyNode[],
  flatMap: Map<string, FlatDependency>,
  depth: number,
  onDepth: (d: number) => void
): void {
  onDepth(depth);

  for (const [name, info] of Object.entries(deps)) {
    const version = info.version || "unknown";

    // 更新 flatMap
    let flat = flatMap.get(name);
    if (!flat) {
      flat = { name, versions: [], locations: [], requestedBy: [] };
      flatMap.set(name, flat);
    }
    if (!flat.versions.includes(version)) {
      flat.versions.push(version);
    }

    const node: DependencyNode = {
      name,
      version,
      specifier: info.resolved || "",
      resolved: info.resolved,
      dependencyType: info.dev ? "dev" : "prod",
      hoisted: !info.resolved?.includes(name),
      deduped: info.deduped || false,
      location: info.path || "",
      dependencies: [],
      peerDependencies: info.peerDependencies || {},
      problems: info.problems,
    };

    if (info.dependencies) {
      parseNpmDependencies(
        info.dependencies,
        node.dependencies,
        flatMap,
        depth + 1,
        onDepth
      );
    }

    tree.push(node);
  }
}

interface NpmDependencyEntry {
  version?: string;
  resolved?: string;
  dev?: boolean;
  deduped?: boolean;
  path?: string;
  peerDependencies?: Record<string, string>;
  problems?: string[];
  dependencies?: Record<string, NpmDependencyEntry>;
}

/**
 * 解析 pnpm list 输出
 */
function parsePnpmDependencies(
  deps: Record<string, PnpmDependencyEntry>,
  tree: DependencyNode[],
  flatMap: Map<string, FlatDependency>,
  depth: number,
  onDepth: (d: number) => void
): void {
  onDepth(depth);

  for (const [name, info] of Object.entries(deps)) {
    const version = info.version || "unknown";

    let flat = flatMap.get(name);
    if (!flat) {
      flat = { name, versions: [], locations: [], requestedBy: [] };
      flatMap.set(name, flat);
    }
    if (!flat.versions.includes(version)) {
      flat.versions.push(version);
    }

    const node: DependencyNode = {
      name,
      version,
      specifier: info.from || "",
      dependencyType: "prod",
      hoisted: false,
      deduped: false,
      location: info.path || "",
      dependencies: [],
      peerDependencies: {},
    };

    if (info.dependencies) {
      parsePnpmDependencies(
        info.dependencies,
        node.dependencies,
        flatMap,
        depth + 1,
        onDepth
      );
    }

    tree.push(node);
  }
}

interface PnpmDependencyEntry {
  version?: string;
  from?: string;
  path?: string;
  dependencies?: Record<string, PnpmDependencyEntry>;
}

/**
 * 解析 yarn list 输出
 */
function parseYarnDependencies(
  trees: YarnTreeEntry[],
  result: DependencyNode[],
  flatMap: Map<string, FlatDependency>,
  depth: number,
  onDepth: (d: number) => void
): void {
  onDepth(depth);

  for (const item of trees) {
    // yarn 格式: "package@version"
    const match = item.name.match(/^(.+)@(.+)$/);
    if (!match) continue;

    const [, name, version] = match;

    let flat = flatMap.get(name);
    if (!flat) {
      flat = { name, versions: [], locations: [], requestedBy: [] };
      flatMap.set(name, flat);
    }
    if (!flat.versions.includes(version)) {
      flat.versions.push(version);
    }

    const node: DependencyNode = {
      name,
      version,
      specifier: "",
      dependencyType: "prod",
      hoisted: item.shadow || false,
      deduped: item.shadow || false,
      location: "",
      dependencies: [],
      peerDependencies: {},
    };

    if (item.children) {
      parseYarnDependencies(
        item.children,
        node.dependencies,
        flatMap,
        depth + 1,
        onDepth
      );
    }

    result.push(node);
  }
}

interface YarnTreeEntry {
  name: string;
  shadow?: boolean;
  children?: YarnTreeEntry[];
}

/**
 * 格式化依赖报告
 */
function formatDependencyReport(output: AnalyzeDependenciesOutput): string {
  const lines: string[] = [];

  lines.push("## 依赖分析报告\n");

  // 根包信息
  lines.push("### 项目信息");
  lines.push(`- **名称**: ${output.root.name}`);
  lines.push(`- **版本**: ${output.root.version}`);
  lines.push(`- **路径**: ${output.root.path}`);
  lines.push("");

  // 统计信息
  lines.push("### 依赖统计");
  lines.push(`- **总依赖数**: ${output.stats.totalPackages}`);
  lines.push(`- **唯一包数**: ${output.stats.uniquePackages}`);
  lines.push(`- **重复包数**: ${output.stats.duplicatePackages}`);
  lines.push(`- **最大深度**: ${output.stats.maxDepth}`);
  lines.push("");

  // 多版本依赖
  const multiVersionDeps = output.flatList.filter((d) => d.versions.length > 1);
  if (multiVersionDeps.length > 0) {
    lines.push("### 多版本依赖 (可能存在问题)");
    lines.push("");
    lines.push("| 包名 | 版本数 | 版本列表 |");
    lines.push("|------|--------|----------|");
    for (const dep of multiVersionDeps.slice(0, 20)) {
      lines.push(
        `| ${dep.name} | ${dep.versions.length} | ${dep.versions.join(", ")} |`
      );
    }
    if (multiVersionDeps.length > 20) {
      lines.push(`| ... | ... | 共 ${multiVersionDeps.length} 个多版本依赖 |`);
    }
    lines.push("");
  }

  // Workspace 包
  if (output.workspacePackages.length > 0) {
    lines.push("### Workspace 包");
    lines.push("");
    lines.push("| 包名 | 版本 | 路径 |");
    lines.push("|------|------|------|");
    for (const ws of output.workspacePackages) {
      lines.push(`| ${ws.name} | ${ws.version} | ${ws.relativePath} |`);
    }
    lines.push("");
  }

  // 问题警告
  if (output.rawOutput) {
    lines.push("### 警告信息");
    lines.push("```");
    lines.push(output.rawOutput.slice(0, 2000));
    if (output.rawOutput.length > 2000) {
      lines.push("... (输出已截断)");
    }
    lines.push("```");
    lines.push("");
  }

  // 建议
  lines.push("### 分析建议");
  const suggestions: string[] = [];

  if (output.stats.duplicatePackages > 10) {
    suggestions.push(
      `⚠️ 检测到 ${output.stats.duplicatePackages} 个重复包，建议运行 dedupe 命令优化`
    );
  }

  if (output.stats.maxDepth > 10) {
    suggestions.push(
      `💡 依赖树深度达到 ${output.stats.maxDepth} 层，可能影响安装速度`
    );
  }

  if (multiVersionDeps.length > 0) {
    suggestions.push(
      `⚠️ ${multiVersionDeps.length} 个包存在多版本，建议使用 detect_conflicts 检测具体问题`
    );
  }

  if (suggestions.length === 0) {
    lines.push("✅ 依赖结构良好，未发现明显问题");
  } else {
    for (const s of suggestions) {
      lines.push(`- ${s}`);
    }
  }

  return lines.join("\n");
}
