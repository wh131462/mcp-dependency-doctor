/**
 * detect_environment Tool
 * 检测项目的包管理器类型、monorepo 结构、workspace 配置
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as path from "node:path";
import {
  detectPackageManager,
  detectWorkspaces,
  getWorkspacePackages,
  getOverrides,
  getNodeVersionConstraint,
  getCurrentNodeVersion,
} from "../core/package-manager/index.js";
import { readJsonFile } from "../utils/index.js";
import type { PackageJson, EnvironmentInfo } from "../types/index.js";

// 输入参数 Schema
export const detectEnvironmentSchema = z.object({
  projectPath: z.string().describe("项目根目录的绝对路径"),
});

export type DetectEnvironmentInput = z.infer<typeof detectEnvironmentSchema>;

/**
 * 注册 detect_environment tool
 */
export function registerDetectEnvironmentTool(server: McpServer): void {
  server.tool(
    "detect_environment",
    "检测项目的包管理器类型、monorepo 结构、workspace 配置、overrides/resolutions 设置。这是分析项目依赖的第一步。",
    detectEnvironmentSchema.shape,
    async (input: DetectEnvironmentInput) => {
      try {
        const result = await detectEnvironment(input.projectPath);
        return {
          content: [
            {
              type: "text" as const,
              text: formatEnvironmentReport(result),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `检测项目环境失败: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

/**
 * 检测项目环境
 */
async function detectEnvironment(
  projectPath: string
): Promise<EnvironmentInfo> {
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

  // 获取 workspace 包列表
  const workspacePackages = await getWorkspacePackages(
    projectPath,
    workspaceConfig
  );

  // 获取 overrides
  const overrides = getOverrides(packageJson, pmInfo.name);

  // 构建其他包管理器的 overrides (用于对比)
  const allOverrides = {
    npm:
      pmInfo.name === "npm"
        ? overrides
        : getOverrides(packageJson, "npm"),
    pnpm:
      pmInfo.name === "pnpm"
        ? overrides
        : getOverrides(packageJson, "pnpm"),
    yarn:
      pmInfo.name === "yarn"
        ? overrides
        : getOverrides(packageJson, "yarn"),
  };

  return {
    packageManager: pmInfo,
    isMonorepo: workspaceConfig.enabled,
    workspaces: {
      ...workspaceConfig,
      packages: workspacePackages.map((ws) => ws.relativePath),
    },
    nodeVersion: {
      required: getNodeVersionConstraint(packageJson),
      current: getCurrentNodeVersion(),
    },
    packageManagerField: packageJson.packageManager || null,
    overrides: allOverrides,
    rootPackage: {
      name: packageJson.name,
      version: packageJson.version,
      private: packageJson.private || false,
    },
  };
}

/**
 * 格式化环境报告为 Markdown
 */
function formatEnvironmentReport(info: EnvironmentInfo): string {
  const lines: string[] = [];

  lines.push("## 项目环境检测报告\n");

  // 根包信息
  lines.push("### 根包信息");
  lines.push(`- **名称**: ${info.rootPackage.name}`);
  lines.push(`- **版本**: ${info.rootPackage.version}`);
  lines.push(`- **私有包**: ${info.rootPackage.private ? "是" : "否"}`);
  lines.push("");

  // 包管理器
  lines.push("### 包管理器");
  lines.push(`- **类型**: ${info.packageManager.name}`);
  lines.push(`- **版本**: ${info.packageManager.version}`);
  lines.push(
    `- **Lock 文件**: ${info.packageManager.lockFile || "未找到"}`
  );
  if (info.packageManagerField) {
    lines.push(`- **packageManager 字段**: ${info.packageManagerField}`);
  }
  lines.push("");

  // Node.js 版本
  lines.push("### Node.js 版本");
  lines.push(`- **当前版本**: ${info.nodeVersion.current}`);
  lines.push(
    `- **要求版本**: ${info.nodeVersion.required || "未指定"}`
  );
  lines.push("");

  // Monorepo / Workspace
  lines.push("### Monorepo 配置");
  lines.push(`- **是否为 Monorepo**: ${info.isMonorepo ? "是" : "否"}`);
  if (info.isMonorepo) {
    lines.push(
      `- **配置来源**: ${info.workspaces.configSource}`
    );
    lines.push(`- **Workspace 数量**: ${info.workspaces.packages.length}`);
    if (info.workspaces.packages.length > 0) {
      lines.push("- **Workspace 路径**:");
      for (const pkg of info.workspaces.packages) {
        lines.push(`  - ${pkg}`);
      }
    }
  }
  lines.push("");

  // Overrides / Resolutions
  const activeOverrides = info.overrides[info.packageManager.name];
  lines.push("### 版本覆盖配置 (Overrides/Resolutions)");
  if (Object.keys(activeOverrides).length > 0) {
    lines.push(`使用 ${info.packageManager.name} 的覆盖配置:\n`);
    lines.push("| 包名 | 强制版本 |");
    lines.push("|------|----------|");
    for (const [pkg, version] of Object.entries(activeOverrides)) {
      lines.push(`| ${pkg} | ${version} |`);
    }
  } else {
    lines.push("*未配置版本覆盖*");
  }
  lines.push("");

  // 诊断建议
  lines.push("### 诊断建议");
  const suggestions: string[] = [];

  if (!info.packageManager.lockFile) {
    suggestions.push(
      "⚠️ 未找到 lock 文件，建议运行 `" +
        info.packageManager.name +
        " install` 生成"
    );
  }

  if (!info.packageManagerField && info.isMonorepo) {
    suggestions.push(
      "💡 Monorepo 项目建议在 package.json 中添加 `packageManager` 字段以锁定包管理器版本"
    );
  }

  if (
    info.nodeVersion.required &&
    !isNodeVersionSatisfied(
      info.nodeVersion.current,
      info.nodeVersion.required
    )
  ) {
    suggestions.push(
      `⚠️ 当前 Node.js 版本 (${info.nodeVersion.current}) 可能不满足要求 (${info.nodeVersion.required})`
    );
  }

  if (Object.keys(activeOverrides).length > 0) {
    suggestions.push(
      `💡 项目使用了 ${Object.keys(activeOverrides).length} 个版本覆盖，建议定期检查是否仍然需要`
    );
  }

  if (suggestions.length === 0) {
    lines.push("✅ 项目环境配置良好，未发现明显问题");
  } else {
    for (const suggestion of suggestions) {
      lines.push(`- ${suggestion}`);
    }
  }

  return lines.join("\n");
}

/**
 * 简单检查 Node 版本是否满足要求
 */
function isNodeVersionSatisfied(
  current: string,
  required: string
): boolean {
  // 简单实现，只处理 >= 格式
  const match = required.match(/^>=?\s*(\d+)/);
  if (match) {
    const requiredMajor = parseInt(match[1], 10);
    const currentMajor = parseInt(current.split(".")[0], 10);
    return currentMajor >= requiredMajor;
  }
  return true;
}
