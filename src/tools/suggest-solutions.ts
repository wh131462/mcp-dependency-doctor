/**
 * suggest_solutions Tool
 * 为依赖问题生成多个解决方案
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as path from "node:path";
import { readJsonFile, generateId } from "../utils/index.js";
import {
  detectPackageManager,
  detectWorkspaces,
  getWorkspacePackages,
} from "../core/package-manager/index.js";
import { RegistryClient } from "../core/registry/index.js";
import type {
  PackageJson,
  Solution,
  SolutionStep,
  RiskLevel,
  EffortLevel,
  WorkspaceInfo,
} from "../types/index.js";

// 策略类型
const strategies = ["conservative", "aggressive", "balanced"] as const;

// 输入参数 Schema
export const suggestSolutionsSchema = z.object({
  projectPath: z.string().describe("项目根目录路径"),
  targetPackage: z.string().optional().describe("针对特定包生成方案"),
  targetVersion: z.string().optional().describe("目标版本"),
  strategy: z.enum(strategies).optional().default("balanced"),
  constraints: z
    .object({
      allowMajorUpgrade: z.boolean().optional().default(false),
      preferredVersions: z.record(z.string()).optional(),
      excludePackages: z.array(z.string()).optional(),
    })
    .optional(),
});

export type SuggestSolutionsInput = z.infer<typeof suggestSolutionsSchema>;

interface SuggestSolutionsOutput {
  targetPackage: string | null;
  solutions: Solution[];
  comparison: {
    matrix: Array<{
      solutionId: string;
      title: string;
      risk: number;
      effort: number;
      recommendation: number;
    }>;
    recommended: string | null;
    reason: string;
  };
  warnings: string[];
}

/**
 * 注册 suggest_solutions tool
 */
export function registerSuggestSolutionsTool(server: McpServer): void {
  server.tool(
    "suggest_solutions",
    "为依赖问题生成多个解决方案，进行风险评估和方案对比，提供推荐等级。支持保守、激进、平衡三种策略。",
    suggestSolutionsSchema.shape,
    async (input: SuggestSolutionsInput) => {
      try {
        const result = await suggestSolutions(input);
        return {
          content: [
            {
              type: "text" as const,
              text: formatSolutionsReport(result),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `生成解决方案失败: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

/**
 * 生成解决方案
 */
async function suggestSolutions(
  input: SuggestSolutionsInput
): Promise<SuggestSolutionsOutput> {
  const { projectPath, targetPackage, targetVersion, strategy, constraints } = input;

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

  // Registry 客户端
  const registryClient = new RegistryClient();

  const solutions: Solution[] = [];
  const warnings: string[] = [];

  if (targetPackage) {
    // 针对特定包生成方案
    const packageSolutions = await generatePackageSolutions(
      targetPackage,
      targetVersion,
      packageJson,
      workspacePackages,
      pmInfo.name,
      strategy || "balanced",
      constraints || {},
      registryClient
    );
    solutions.push(...packageSolutions);
  } else {
    // 生成通用优化方案
    const generalSolutions = await generateGeneralSolutions(
      packageJson,
      workspacePackages,
      pmInfo.name,
      strategy || "balanced",
      registryClient
    );
    solutions.push(...generalSolutions);
  }

  // 如果没有生成任何方案
  if (solutions.length === 0) {
    warnings.push("未能生成任何解决方案，项目可能已处于最佳状态");
  }

  // 生成比较矩阵
  const comparison = generateComparison(solutions);

  return {
    targetPackage: targetPackage || null,
    solutions,
    comparison,
    warnings,
  };
}

/**
 * 为特定包生成解决方案
 */
async function generatePackageSolutions(
  packageName: string,
  targetVersion: string | undefined,
  packageJson: PackageJson,
  workspaces: WorkspaceInfo[],
  pm: string,
  strategy: string,
  constraints: { allowMajorUpgrade?: boolean; preferredVersions?: Record<string, string> },
  registryClient: RegistryClient
): Promise<Solution[]> {
  const solutions: Solution[] = [];

  // 获取包信息
  const packageInfo = await registryClient.getPackageInfo(packageName);
  const latestVersion = packageInfo?.["dist-tags"].latest;

  // 检查当前安装情况
  const currentVersion =
    packageJson.dependencies?.[packageName] ||
    packageJson.devDependencies?.[packageName];

  const isDirectDep = currentVersion !== undefined;
  const isDev = packageJson.devDependencies?.[packageName] !== undefined;

  // 方案 1: 升级到最新版本
  if (latestVersion && currentVersion !== latestVersion) {
    const isBreaking = isMajorUpgrade(currentVersion, latestVersion);

    if (!isBreaking || constraints.allowMajorUpgrade || strategy === "aggressive") {
      solutions.push({
        id: generateId(),
        forIssue: packageName,
        title: `升级 ${packageName} 到最新版本`,
        description: `将 ${packageName} 从 ${currentVersion || "未安装"} 升级到 ${latestVersion}`,
        steps: generateUpgradeSteps(packageName, latestVersion, isDirectDep, isDev, pm),
        risk: {
          level: isBreaking ? "high" : "low",
          factors: isBreaking ? ["主版本升级可能包含破坏性变更"] : [],
          mitigations: ["运行测试套件", "检查 changelog"],
        },
        compatibility: {
          breakingChanges: isBreaking,
          affectedPackages: [packageName],
          testingRequired: ["unit tests", "integration tests"],
        },
        recommendation: {
          score: isBreaking ? 60 : 90,
          reasons: isBreaking
            ? ["最新版本", "但包含主版本升级"]
            : ["最新版本", "非破坏性升级"],
        },
        estimatedEffort: isBreaking ? "moderate" : "minor",
      });
    }
  }

  // 方案 2: 升级到指定版本
  if (targetVersion && targetVersion !== latestVersion) {
    const isBreaking = isMajorUpgrade(currentVersion, targetVersion);

    solutions.push({
      id: generateId(),
      forIssue: packageName,
      title: `升级 ${packageName} 到 ${targetVersion}`,
      description: `将 ${packageName} 从 ${currentVersion || "未安装"} 升级到指定版本 ${targetVersion}`,
      steps: generateUpgradeSteps(packageName, targetVersion, isDirectDep, isDev, pm),
      risk: {
        level: isBreaking ? "medium" : "low",
        factors: isBreaking ? ["主版本变更"] : [],
        mitigations: ["运行测试"],
      },
      compatibility: {
        breakingChanges: isBreaking,
        affectedPackages: [packageName],
        testingRequired: ["unit tests"],
      },
      recommendation: {
        score: 75,
        reasons: ["指定版本", "可控升级"],
      },
      estimatedEffort: "minor",
    });
  }

  // 方案 3: 使用 overrides/resolutions 强制版本
  if (latestVersion && !isDirectDep) {
    const overrideField = getOverrideField(pm);

    solutions.push({
      id: generateId(),
      forIssue: packageName,
      title: `使用 ${overrideField} 强制 ${packageName} 版本`,
      description: `在 package.json 中添加 ${overrideField} 配置，强制所有依赖使用统一版本`,
      steps: [
        {
          action: "override",
          target: packageName,
          to: targetVersion || latestVersion,
          file: "package.json",
          field: overrideField,
          command: undefined,
          manual: true,
        },
        {
          action: "regenerate_lock",
          target: "lock file",
          file: getLockFileName(pm),
          command: getInstallCommand(pm),
          manual: false,
        },
      ],
      risk: {
        level: "medium",
        factors: [
          "强制版本可能导致依赖不兼容",
          "需要长期维护 override 配置",
        ],
        mitigations: [
          "定期检查 override 是否仍然需要",
          "监控依赖更新",
        ],
      },
      compatibility: {
        breakingChanges: false,
        affectedPackages: [packageName],
        testingRequired: ["full regression"],
      },
      recommendation: {
        score: 65,
        reasons: ["可快速解决多版本问题", "但需要持续维护"],
      },
      estimatedEffort: "minor",
    });
  }

  // 方案 4: Workspace 统一版本 (仅 monorepo)
  if (workspaces.length > 0) {
    const affectedWorkspaces = findWorkspacesUsingPackage(workspaces, packageName);

    if (affectedWorkspaces.length > 1) {
      solutions.push({
        id: generateId(),
        forIssue: packageName,
        title: `统一 ${packageName} 在所有 workspace 中的版本`,
        description: `将所有 workspace 中的 ${packageName} 统一为 ${targetVersion || latestVersion || "最新版本"}`,
        steps: affectedWorkspaces.map((ws) => ({
          action: "upgrade" as const,
          target: packageName,
          to: targetVersion || latestVersion || "latest",
          file: path.join(ws.relativePath, "package.json"),
          manual: true,
        })),
        risk: {
          level: "low",
          factors: [],
          mitigations: ["逐个 workspace 测试"],
        },
        compatibility: {
          breakingChanges: false,
          affectedPackages: affectedWorkspaces.map((ws) => ws.name),
          testingRequired: affectedWorkspaces.map((ws) => `${ws.name} tests`),
        },
        recommendation: {
          score: 85,
          reasons: ["统一版本管理", "减少依赖复杂度"],
        },
        estimatedEffort: affectedWorkspaces.length > 3 ? "moderate" : "minor",
      });
    }
  }

  return solutions;
}

/**
 * 生成通用优化方案
 */
async function generateGeneralSolutions(
  _packageJson: PackageJson,
  _workspaces: WorkspaceInfo[],
  pm: string,
  strategy: string,
  _registryClient: RegistryClient
): Promise<Solution[]> {
  const solutions: Solution[] = [];

  // 方案 1: 运行 dedupe
  solutions.push({
    id: generateId(),
    forIssue: "general",
    title: "运行依赖去重",
    description: "使用包管理器的 dedupe 命令减少重复依赖",
    steps: [
      {
        action: "dedupe",
        target: "all dependencies",
        file: getLockFileName(pm),
        command: getDedupeCommand(pm),
        manual: false,
      },
    ],
    risk: {
      level: "low",
      factors: [],
      mitigations: ["运行测试验证"],
    },
    compatibility: {
      breakingChanges: false,
      affectedPackages: [],
      testingRequired: ["smoke tests"],
    },
    recommendation: {
      score: 95,
      reasons: ["安全操作", "可能减少 node_modules 大小"],
    },
    estimatedEffort: "trivial",
  });

  // 方案 2: 重新生成 lock 文件
  solutions.push({
    id: generateId(),
    forIssue: "general",
    title: "重新生成 lock 文件",
    description: "删除 node_modules 和 lock 文件，重新安装依赖",
    steps: [
      {
        action: "remove",
        target: "node_modules",
        file: "node_modules",
        command: "rm -rf node_modules",
        manual: false,
      },
      {
        action: "remove",
        target: "lock file",
        file: getLockFileName(pm),
        command: `rm -f ${getLockFileName(pm)}`,
        manual: false,
      },
      {
        action: "regenerate_lock",
        target: "dependencies",
        file: "package.json",
        command: getInstallCommand(pm),
        manual: false,
      },
    ],
    risk: {
      level: "medium",
      factors: [
        "可能导致依赖版本变化",
        "可能引入新的冲突",
      ],
      mitigations: [
        "备份当前 lock 文件",
        "对比新旧 lock 文件差异",
        "运行完整测试套件",
      ],
    },
    compatibility: {
      breakingChanges: false,
      affectedPackages: [],
      testingRequired: ["full regression"],
    },
    recommendation: {
      score: 70,
      reasons: ["可解决某些 lock 文件损坏问题", "但存在风险"],
    },
    estimatedEffort: "minor",
  });

  // 方案 3: 更新所有依赖
  if (strategy === "aggressive") {
    solutions.push({
      id: generateId(),
      forIssue: "general",
      title: "更新所有依赖到最新版本",
      description: "使用 npm-check-updates 或类似工具更新所有依赖",
      steps: [
        {
          action: "upgrade",
          target: "all dependencies",
          file: "package.json",
          command: getNcuCommand(pm),
          manual: true,
        },
        {
          action: "regenerate_lock",
          target: "dependencies",
          file: getLockFileName(pm),
          command: getInstallCommand(pm),
          manual: false,
        },
      ],
      risk: {
        level: "high",
        factors: [
          "可能包含多个破坏性变更",
          "需要大量测试工作",
        ],
        mitigations: [
          "创建新分支进行测试",
          "逐步更新而非一次性更新",
          "检查所有 changelog",
        ],
      },
      compatibility: {
        breakingChanges: true,
        affectedPackages: [],
        testingRequired: ["full regression", "manual testing"],
      },
      recommendation: {
        score: 40,
        reasons: ["最新依赖", "但风险较高"],
      },
      estimatedEffort: "major",
    });
  }

  return solutions;
}

/**
 * 生成升级步骤
 */
function generateUpgradeSteps(
  packageName: string,
  version: string,
  isDirectDep: boolean,
  isDev: boolean,
  pm: string
): SolutionStep[] {
  const steps: SolutionStep[] = [];

  if (isDirectDep) {
    let command: string;

    switch (pm) {
      case "npm":
        command = `npm install ${packageName}@${version} ${isDev ? "--save-dev" : "--save"}`;
        break;
      case "pnpm":
        command = `pnpm add ${packageName}@${version} ${isDev ? "-D" : ""}`;
        break;
      case "yarn":
        command = `yarn add ${packageName}@${version} ${isDev ? "-D" : ""}`;
        break;
      default:
        command = `npm install ${packageName}@${version}`;
    }

    steps.push({
      action: "upgrade",
      target: packageName,
      to: version,
      file: "package.json",
      field: isDev ? "devDependencies" : "dependencies",
      command,
      manual: false,
    });
  } else {
    steps.push({
      action: "override",
      target: packageName,
      to: version,
      file: "package.json",
      field: getOverrideField(pm),
      manual: true,
    });
  }

  return steps;
}

/**
 * 生成比较矩阵
 */
function generateComparison(solutions: Solution[]): SuggestSolutionsOutput["comparison"] {
  const matrix = solutions.map((s) => ({
    solutionId: s.id,
    title: s.title,
    risk: riskToNumber(s.risk.level),
    effort: effortToNumber(s.estimatedEffort),
    recommendation: s.recommendation.score,
  }));

  // 找出推荐方案
  const sorted = [...matrix].sort((a, b) => b.recommendation - a.recommendation);
  const recommended = sorted[0]?.solutionId || null;
  const reason = recommended
    ? `方案 "${sorted[0].title}" 综合评分最高 (${sorted[0].recommendation}/100)`
    : "无可用方案";

  return {
    matrix,
    recommended,
    reason,
  };
}

// 辅助函数

function isMajorUpgrade(from: string | undefined, to: string): boolean {
  if (!from) return false;
  const fromMatch = from.match(/\d+/);
  const toMatch = to.match(/\d+/);
  if (fromMatch && toMatch) {
    return parseInt(toMatch[0]) > parseInt(fromMatch[0]);
  }
  return false;
}

function getOverrideField(pm: string): string {
  switch (pm) {
    case "yarn":
      return "resolutions";
    default:
      return "overrides";
  }
}

function getLockFileName(pm: string): string {
  switch (pm) {
    case "npm":
      return "package-lock.json";
    case "pnpm":
      return "pnpm-lock.yaml";
    case "yarn":
      return "yarn.lock";
    default:
      return "package-lock.json";
  }
}

function getInstallCommand(pm: string): string {
  return `${pm} install`;
}

function getDedupeCommand(pm: string): string {
  switch (pm) {
    case "npm":
      return "npm dedupe";
    case "pnpm":
      return "pnpm dedupe";
    case "yarn":
      return "yarn dedupe";
    default:
      return "npm dedupe";
  }
}

function getNcuCommand(_pm: string): string {
  return "npx npm-check-updates -u";
}

function findWorkspacesUsingPackage(
  workspaces: WorkspaceInfo[],
  packageName: string
): WorkspaceInfo[] {
  return workspaces.filter((ws) => {
    const allDeps = {
      ...ws.packageJson.dependencies,
      ...ws.packageJson.devDependencies,
    };
    return allDeps[packageName] !== undefined;
  });
}

function riskToNumber(risk: RiskLevel): number {
  switch (risk) {
    case "low":
      return 1;
    case "medium":
      return 2;
    case "high":
      return 3;
  }
}

function effortToNumber(effort: EffortLevel): number {
  switch (effort) {
    case "trivial":
      return 1;
    case "minor":
      return 2;
    case "moderate":
      return 3;
    case "major":
      return 4;
  }
}

/**
 * 格式化解决方案报告
 */
function formatSolutionsReport(output: SuggestSolutionsOutput): string {
  const lines: string[] = [];

  lines.push("## 解决方案建议\n");

  if (output.targetPackage) {
    lines.push(`*目标包: ${output.targetPackage}*\n`);
  }

  // 警告
  if (output.warnings.length > 0) {
    lines.push("### ⚠️ 警告");
    for (const warning of output.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }

  // 方案对比表
  if (output.comparison.matrix.length > 0) {
    lines.push("### 方案对比\n");
    lines.push("| 方案 | 风险 | 工作量 | 推荐度 |");
    lines.push("|------|------|--------|--------|");
    for (const item of output.comparison.matrix) {
      const riskStr = ["🟢", "🟡", "🔴"][item.risk - 1];
      const effortStr = ["极小", "小", "中", "大"][item.effort - 1];
      lines.push(
        `| ${item.title} | ${riskStr} | ${effortStr} | ${item.recommendation}/100 |`
      );
    }
    lines.push("");

    // 推荐
    lines.push(`**推荐**: ${output.comparison.reason}\n`);
  }

  // 详细方案
  lines.push("### 方案详情\n");

  for (let i = 0; i < output.solutions.length; i++) {
    const solution = output.solutions[i];
    const isRecommended = solution.id === output.comparison.recommended;

    lines.push(
      `#### 方案 ${i + 1}: ${solution.title}${isRecommended ? " ⭐ 推荐" : ""}`
    );
    lines.push("");
    lines.push(`**描述**: ${solution.description}`);
    lines.push("");

    // 步骤
    lines.push("**执行步骤**:");
    for (let j = 0; j < solution.steps.length; j++) {
      const step = solution.steps[j];
      const actionName = {
        upgrade: "升级",
        downgrade: "降级",
        add: "添加",
        remove: "移除",
        override: "覆盖",
        dedupe: "去重",
        regenerate_lock: "重新生成",
      }[step.action];

      if (step.command) {
        lines.push(`${j + 1}. ${actionName} ${step.target}`);
        lines.push(`   \`\`\`bash`);
        lines.push(`   ${step.command}`);
        lines.push(`   \`\`\``);
      } else if (step.manual) {
        lines.push(
          `${j + 1}. [手动] 在 \`${step.file}\` 中${actionName} \`${step.target}\` ${step.to ? `为 \`${step.to}\`` : ""}`
        );
      }
    }
    lines.push("");

    // 风险
    lines.push(
      `**风险级别**: ${{low: "🟢 低", medium: "🟡 中", high: "🔴 高"}[solution.risk.level]}`
    );
    if (solution.risk.factors.length > 0) {
      lines.push(`- 风险因素: ${solution.risk.factors.join("; ")}`);
    }
    if (solution.risk.mitigations.length > 0) {
      lines.push(`- 缓解措施: ${solution.risk.mitigations.join("; ")}`);
    }
    lines.push("");

    // 推荐理由
    lines.push(`**推荐理由**: ${solution.recommendation.reasons.join(", ")}`);
    lines.push("");
    lines.push("---\n");
  }

  return lines.join("\n");
}
