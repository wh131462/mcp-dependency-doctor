/**
 * detect_conflicts Tool
 * 检测依赖冲突、peerDependencies 问题、多版本依赖等
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as path from "node:path";
import { readJsonFile, execCommand, generateId, satisfiesVersion } from "../utils/index.js";
import {
  detectPackageManager,
  detectWorkspaces,
  getWorkspacePackages,
  getOverrides,
  getCurrentNodeVersion,
} from "../core/package-manager/index.js";
import type {
  PackageJson,
  ConflictIssue,
  ConflictType,
  WorkspaceInfo,
} from "../types/index.js";

// 检测类型枚举
const conflictTypes = [
  "version_conflict",
  "peer_dependency",
  "multiple_versions",
  "workspace_mismatch",
  "override_risk",
  "engine_mismatch",
  "deprecated",
  "missing_dependency",
] as const;

// 输入参数 Schema
export const detectConflictsSchema = z.object({
  projectPath: z.string().describe("项目根目录路径"),
  checkTypes: z
    .array(z.enum(conflictTypes))
    .optional()
    .default(["version_conflict", "peer_dependency", "multiple_versions", "workspace_mismatch"]),
  severity: z.enum(["all", "error", "warning"]).optional().default("all"),
});

export type DetectConflictsInput = z.infer<typeof detectConflictsSchema>;

interface DetectConflictsOutput {
  hasIssues: boolean;
  summary: {
    total: number;
    errors: number;
    warnings: number;
    infos: number;
    byType: Record<string, number>;
  };
  issues: ConflictIssue[];
  analysisTimestamp: string;
}

/**
 * 注册 detect_conflicts tool
 */
export function registerDetectConflictsTool(server: McpServer): void {
  server.tool(
    "detect_conflicts",
    "检测依赖冲突、peerDependencies 问题、多版本依赖、workspace 不一致、overrides 风险、engine 不匹配等问题",
    detectConflictsSchema.shape,
    async (input: DetectConflictsInput) => {
      try {
        const result = await detectConflicts(input);
        return {
          content: [
            {
              type: "text" as const,
              text: formatConflictsReport(result),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `检测冲突失败: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

/**
 * 检测冲突
 */
async function detectConflicts(
  input: DetectConflictsInput
): Promise<DetectConflictsOutput> {
  const { projectPath, checkTypes, severity } = input;

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

  // 收集所有问题
  const issues: ConflictIssue[] = [];

  // 根据配置执行检测
  if (checkTypes.includes("peer_dependency")) {
    const peerIssues = await detectPeerDependencyIssues(projectPath, pmInfo.name);
    issues.push(...peerIssues);
  }

  if (checkTypes.includes("multiple_versions")) {
    const multiVersionIssues = await detectMultipleVersions(projectPath, pmInfo.name);
    issues.push(...multiVersionIssues);
  }

  if (checkTypes.includes("workspace_mismatch") && workspacePackages.length > 0) {
    const workspaceIssues = detectWorkspaceMismatch(workspacePackages, packageJson);
    issues.push(...workspaceIssues);
  }

  if (checkTypes.includes("override_risk")) {
    const overrides = getOverrides(packageJson, pmInfo.name);
    const overrideIssues = detectOverrideRisks(overrides, packageJson);
    issues.push(...overrideIssues);
  }

  if (checkTypes.includes("engine_mismatch")) {
    const engineIssues = detectEngineMismatch(packageJson);
    issues.push(...engineIssues);
  }

  // 过滤严重级别
  let filteredIssues = issues;
  if (severity === "error") {
    filteredIssues = issues.filter((i) => i.severity === "error");
  } else if (severity === "warning") {
    filteredIssues = issues.filter((i) => i.severity !== "info");
  }

  // 统计
  const byType: Record<string, number> = {};
  for (const issue of filteredIssues) {
    byType[issue.type] = (byType[issue.type] || 0) + 1;
  }

  return {
    hasIssues: filteredIssues.length > 0,
    summary: {
      total: filteredIssues.length,
      errors: filteredIssues.filter((i) => i.severity === "error").length,
      warnings: filteredIssues.filter((i) => i.severity === "warning").length,
      infos: filteredIssues.filter((i) => i.severity === "info").length,
      byType,
    },
    issues: filteredIssues,
    analysisTimestamp: new Date().toISOString(),
  };
}

/**
 * 检测 peerDependencies 问题
 */
async function detectPeerDependencyIssues(
  projectPath: string,
  pm: string
): Promise<ConflictIssue[]> {
  const issues: ConflictIssue[] = [];

  // 使用 npm/pnpm ls 检测问题
  let command: string;
  switch (pm) {
    case "npm":
      command = "npm ls --json 2>&1";
      break;
    case "pnpm":
      command = "pnpm list --json 2>&1";
      break;
    case "yarn":
      command = "yarn list --json 2>&1";
      break;
    default:
      return issues;
  }

  const result = await execCommand(command, projectPath);

  // 解析 npm 的 peer 依赖问题
  if (pm === "npm" && result.stdout) {
    try {
      const data = JSON.parse(result.stdout);
      if (data.problems) {
        for (const problem of data.problems) {
          // 解析 peer dep 问题
          const peerMatch = problem.match(
            /peer dep missing: (.+)@(.+), required by (.+)/
          );
          if (peerMatch) {
            issues.push({
              id: generateId(),
              type: "peer_dependency",
              severity: "warning",
              package: peerMatch[1],
              message: problem,
              details: {
                peerDependency: {
                  host: peerMatch[3],
                  hostVersion: "",
                  peerPackage: peerMatch[1],
                  required: peerMatch[2],
                  installed: null,
                },
              },
              affectedPaths: [peerMatch[3]],
              suggestedAction: `安装 ${peerMatch[1]}@${peerMatch[2]} 或检查版本兼容性`,
            });
          }
        }
      }
    } catch {
      // 解析失败，忽略
    }
  }

  // 检查 stderr 中的警告
  if (result.stderr) {
    const peerWarnings = result.stderr.match(/WARN.*peer.*dep.*/gi);
    if (peerWarnings) {
      for (const warning of peerWarnings) {
        issues.push({
          id: generateId(),
          type: "peer_dependency",
          severity: "warning",
          package: "unknown",
          message: warning,
          details: {},
          affectedPaths: [],
          suggestedAction: "检查 peerDependencies 配置",
        });
      }
    }
  }

  return issues;
}

/**
 * 检测多版本依赖
 */
async function detectMultipleVersions(
  projectPath: string,
  pm: string
): Promise<ConflictIssue[]> {
  const issues: ConflictIssue[] = [];

  let command: string;
  switch (pm) {
    case "npm":
      command = "npm ls --json --all";
      break;
    case "pnpm":
      command = "pnpm list --json --depth=Infinity";
      break;
    case "yarn":
      command = "yarn list --json";
      break;
    default:
      return issues;
  }

  const result = await execCommand(command, projectPath);

  // 收集所有包版本
  const versionMap = new Map<string, Set<string>>();

  try {
    if (pm === "npm" && result.stdout) {
      collectNpmVersions(JSON.parse(result.stdout), versionMap);
    }
  } catch {
    // 解析失败
  }

  // 检测多版本
  for (const [name, versions] of versionMap) {
    if (versions.size > 1) {
      const versionList = Array.from(versions);
      issues.push({
        id: generateId(),
        type: "multiple_versions",
        severity: versionList.length > 2 ? "warning" : "info",
        package: name,
        message: `包 ${name} 存在 ${versions.size} 个版本: ${versionList.join(", ")}`,
        details: {
          multipleVersions: versionList.map((v) => ({
            version: v,
            paths: [],
          })),
        },
        affectedPaths: [],
        suggestedAction: `考虑统一 ${name} 版本，使用 overrides/resolutions 或升级依赖`,
      });
    }
  }

  return issues;
}

/**
 * 收集 npm ls 输出中的版本
 */
function collectNpmVersions(
  data: NpmLsOutput,
  versionMap: Map<string, Set<string>>
): void {
  if (!data.dependencies) return;

  for (const [name, info] of Object.entries(data.dependencies)) {
    if (info.version) {
      let versions = versionMap.get(name);
      if (!versions) {
        versions = new Set();
        versionMap.set(name, versions);
      }
      versions.add(info.version);
    }

    if (info.dependencies) {
      collectNpmVersions({ dependencies: info.dependencies }, versionMap);
    }
  }
}

interface NpmLsOutput {
  dependencies?: Record<string, { version?: string; dependencies?: Record<string, { version?: string; dependencies?: NpmLsOutput["dependencies"] }> }>;
}

/**
 * 检测 workspace 版本不一致
 */
function detectWorkspaceMismatch(
  workspaces: WorkspaceInfo[],
  _rootPackageJson: PackageJson
): ConflictIssue[] {
  const issues: ConflictIssue[] = [];

  // 收集所有 workspace 中的依赖
  const depVersions = new Map<string, Map<string, string[]>>();

  for (const ws of workspaces) {
    const allDeps = {
      ...ws.packageJson.dependencies,
      ...ws.packageJson.devDependencies,
    };

    for (const [name, version] of Object.entries(allDeps)) {
      let pkgMap = depVersions.get(name);
      if (!pkgMap) {
        pkgMap = new Map();
        depVersions.set(name, pkgMap);
      }

      let workspacesList = pkgMap.get(version);
      if (!workspacesList) {
        workspacesList = [];
        pkgMap.set(version, workspacesList);
      }
      workspacesList.push(ws.name);
    }
  }

  // 检测不一致
  for (const [pkgName, versionWorkspaces] of depVersions) {
    if (versionWorkspaces.size > 1) {
      const details: Array<{ workspace: string; version: string }> = [];

      for (const [version, wsNames] of versionWorkspaces) {
        for (const wsName of wsNames) {
          details.push({ workspace: wsName, version });
        }
      }

      issues.push({
        id: generateId(),
        type: "workspace_mismatch",
        severity: "warning",
        package: pkgName,
        message: `包 ${pkgName} 在不同 workspace 中使用了不同版本`,
        details: {
          workspaceMismatch: Array.from(versionWorkspaces.entries()).map(
            ([version, wsNames]) => ({
              workspace: wsNames.join(", "),
              localVersion: version,
              usedVersions: [version],
            })
          ),
        },
        affectedPaths: Array.from(versionWorkspaces.values()).flat(),
        suggestedAction: `统一 ${pkgName} 在所有 workspace 中的版本`,
      });
    }
  }

  return issues;
}

/**
 * 检测 override 风险
 */
function detectOverrideRisks(
  overrides: Record<string, string>,
  _packageJson: PackageJson
): ConflictIssue[] {
  const issues: ConflictIssue[] = [];

  for (const [pkg, forcedVersion] of Object.entries(overrides)) {
    // 提取包名（可能包含路径如 react>classnames）
    const pkgName = pkg.split(">").pop() || pkg;

    issues.push({
      id: generateId(),
      type: "override_risk",
      severity: "info",
      package: pkgName,
      message: `包 ${pkgName} 被强制覆盖为版本 ${forcedVersion}`,
      details: {
        overrideRisk: {
          package: pkgName,
          forcedVersion,
          originalRequirements: [],
          potentialBreaking: true,
        },
      },
      affectedPaths: [pkg],
      suggestedAction: `定期检查 ${pkgName} 的 override 是否仍然需要`,
    });
  }

  return issues;
}

/**
 * 检测 engine 不匹配
 */
function detectEngineMismatch(packageJson: PackageJson): ConflictIssue[] {
  const issues: ConflictIssue[] = [];

  if (packageJson.engines?.node) {
    const currentNode = getCurrentNodeVersion();
    const required = packageJson.engines.node;

    if (!satisfiesVersion(currentNode, required)) {
      issues.push({
        id: generateId(),
        type: "engine_mismatch",
        severity: "error",
        package: "node",
        message: `当前 Node.js 版本 ${currentNode} 不满足要求 ${required}`,
        details: {
          engineMismatch: {
            package: "node",
            required,
            current: currentNode,
            field: "node",
          },
        },
        affectedPaths: [],
        suggestedAction: `升级 Node.js 到满足 ${required} 的版本`,
      });
    }
  }

  return issues;
}

/**
 * 格式化冲突报告
 */
function formatConflictsReport(output: DetectConflictsOutput): string {
  const lines: string[] = [];

  lines.push("## 依赖冲突检测报告\n");
  lines.push(`*分析时间: ${output.analysisTimestamp}*\n`);

  // 摘要
  lines.push("### 问题摘要");
  if (output.hasIssues) {
    lines.push(`- **总问题数**: ${output.summary.total}`);
    lines.push(`- **错误**: ${output.summary.errors}`);
    lines.push(`- **警告**: ${output.summary.warnings}`);
    lines.push(`- **提示**: ${output.summary.infos}`);
    lines.push("");

    // 按类型统计
    lines.push("**按类型分布:**");
    for (const [type, count] of Object.entries(output.summary.byType)) {
      lines.push(`- ${formatConflictType(type as ConflictType)}: ${count}`);
    }
  } else {
    lines.push("✅ **未检测到依赖问题**");
  }
  lines.push("");

  // 详细问题列表
  if (output.issues.length > 0) {
    lines.push("### 问题详情\n");

    // 按严重级别分组
    const errors = output.issues.filter((i) => i.severity === "error");
    const warnings = output.issues.filter((i) => i.severity === "warning");
    const infos = output.issues.filter((i) => i.severity === "info");

    if (errors.length > 0) {
      lines.push("#### ❌ 错误\n");
      for (const issue of errors) {
        lines.push(formatIssue(issue));
      }
    }

    if (warnings.length > 0) {
      lines.push("#### ⚠️ 警告\n");
      for (const issue of warnings) {
        lines.push(formatIssue(issue));
      }
    }

    if (infos.length > 0) {
      lines.push("#### ℹ️ 提示\n");
      for (const issue of infos.slice(0, 10)) {
        lines.push(formatIssue(issue));
      }
      if (infos.length > 10) {
        lines.push(`*... 还有 ${infos.length - 10} 条提示*\n`);
      }
    }
  }

  // 建议
  lines.push("### 建议操作");
  if (output.summary.errors > 0) {
    lines.push("1. 首先解决所有 **错误** 级别的问题");
  }
  if (output.summary.byType["peer_dependency"]) {
    lines.push("2. 使用 `trace_dependency` 追踪 peer 依赖的来源路径");
  }
  if (output.summary.byType["multiple_versions"]) {
    lines.push("3. 考虑使用 `suggest_solutions` 获取统一版本的方案");
  }
  if (output.summary.byType["workspace_mismatch"]) {
    lines.push("4. 在 monorepo 中统一依赖版本管理");
  }

  return lines.join("\n");
}

/**
 * 格式化单个问题
 */
function formatIssue(issue: ConflictIssue): string {
  const lines: string[] = [];

  lines.push(`**${issue.package}** (ID: ${issue.id})`);
  lines.push(`- 类型: ${formatConflictType(issue.type)}`);
  lines.push(`- 描述: ${issue.message}`);
  lines.push(`- 建议: ${issue.suggestedAction}`);

  if (issue.affectedPaths.length > 0) {
    lines.push(`- 影响路径: ${issue.affectedPaths.slice(0, 3).join(", ")}`);
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * 格式化冲突类型名称
 */
function formatConflictType(type: ConflictType): string {
  const names: Record<ConflictType, string> = {
    version_conflict: "版本冲突",
    peer_dependency: "Peer 依赖问题",
    multiple_versions: "多版本依赖",
    workspace_mismatch: "Workspace 版本不一致",
    override_risk: "Override 风险",
    engine_mismatch: "Engine 不匹配",
    deprecated: "已废弃包",
    missing_dependency: "缺失依赖",
  };
  return names[type] || type;
}
