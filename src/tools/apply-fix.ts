/**
 * apply_fix Tool
 * 自动修复依赖冲突 - 通过修改 package.json 添加 overrides/resolutions
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readJsonFile, execCommand } from "../utils/index.js";
import { detectPackageManager } from "../core/package-manager/index.js";
import { RegistryClient } from "../core/registry/index.js";
import type { PackageJson } from "../types/index.js";

// 输入参数 Schema
export const applyFixSchema = z.object({
  projectPath: z.string().describe("项目根目录路径"),
  fixes: z
    .array(
      z.object({
        package: z.string().describe("要修复的包名"),
        version: z.string().describe("目标版本"),
        type: z
          .enum(["override", "install", "upgrade"])
          .optional()
          .default("override")
          .describe("修复类型"),
      })
    )
    .optional()
    .describe("手动指定修复列表，不指定则自动检测"),
  autoDetect: z.boolean().optional().default(true).describe("自动检测需要修复的问题"),
  dryRun: z.boolean().optional().default(false).describe("仅预览修改，不实际执行"),
  reinstall: z.boolean().optional().default(true).describe("修改后是否重新安装依赖"),
});

export type ApplyFixInput = z.infer<typeof applyFixSchema>;

interface FixResult {
  success: boolean;
  appliedFixes: Array<{
    package: string;
    action: string;
    from?: string;
    to: string;
  }>;
  modifiedFiles: string[];
  commands: string[];
  errors: string[];
  warnings: string[];
}

/**
 * 注册 apply_fix tool
 */
export function registerApplyFixTool(server: McpServer): void {
  server.tool(
    "apply_fix",
    "自动修复依赖冲突。通过添加 overrides/resolutions 或升级依赖来解决 peer dependency 警告。支持 npm/pnpm/yarn。",
    applyFixSchema.shape,
    async (input: ApplyFixInput) => {
      try {
        const result = await applyFix(input);
        return {
          content: [
            {
              type: "text" as const,
              text: formatFixReport(result, input.dryRun),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `修复失败: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

/**
 * 执行修复
 */
async function applyFix(input: ApplyFixInput): Promise<FixResult> {
  const { projectPath, fixes, autoDetect, dryRun, reinstall } = input;

  const result: FixResult = {
    success: true,
    appliedFixes: [],
    modifiedFiles: [],
    commands: [],
    errors: [],
    warnings: [],
  };

  // 检测包管理器
  const pmInfo = await detectPackageManager(projectPath);

  // 读取 package.json
  const packageJsonPath = path.join(projectPath, "package.json");
  const packageJson = await readJsonFile<PackageJson>(packageJsonPath);

  if (!packageJson) {
    throw new Error(`无法读取 package.json: ${packageJsonPath}`);
  }

  // 收集需要修复的问题
  let fixList = fixes || [];

  if (autoDetect && fixList.length === 0) {
    // 自动检测 peer dependency 问题
    const detected = await detectPeerDependencyIssues(projectPath, pmInfo.name);
    fixList = detected;
  }

  if (fixList.length === 0) {
    result.warnings.push("未检测到需要修复的问题");
    return result;
  }

  // 准备修改
  const updatedPackageJson = { ...packageJson };

  // 初始化 overrides 对象
  if (pmInfo.name === "pnpm") {
    if (!updatedPackageJson.pnpm) {
      updatedPackageJson.pnpm = {};
    }
    if (!updatedPackageJson.pnpm.overrides) {
      updatedPackageJson.pnpm.overrides = {};
    }
  } else if (pmInfo.name === "yarn") {
    if (!updatedPackageJson.resolutions) {
      updatedPackageJson.resolutions = {};
    }
  } else {
    if (!updatedPackageJson.overrides) {
      updatedPackageJson.overrides = {};
    }
  }

  // 应用修复
  for (const fix of fixList) {
    const { package: pkgName, version, type } = fix;

    if (type === "override") {
      // 添加 override
      if (pmInfo.name === "pnpm") {
        updatedPackageJson.pnpm!.overrides![pkgName] = version;
      } else if (pmInfo.name === "yarn") {
        updatedPackageJson.resolutions![pkgName] = version;
      } else {
        (updatedPackageJson.overrides as Record<string, string>)[pkgName] = version;
      }

      result.appliedFixes.push({
        package: pkgName,
        action: "override",
        to: version,
      });
    }
  }

  // 写入 package.json
  if (!dryRun) {
    await fs.writeFile(
      packageJsonPath,
      JSON.stringify(updatedPackageJson, null, 2) + "\n",
      "utf-8"
    );
    result.modifiedFiles.push(packageJsonPath);

    // 重新安装依赖
    if (reinstall) {
      const installCmd = `${pmInfo.name} install`;
      result.commands.push(installCmd);

      const installResult = await execCommand(installCmd, projectPath);
      if (installResult.exitCode !== 0) {
        result.warnings.push(`安装命令返回非零退出码: ${installResult.stderr}`);
      }
    }
  } else {
    result.commands.push(`# 将修改 ${packageJsonPath}`);
    result.commands.push(`# 将执行 ${pmInfo.name} install`);
  }

  return result;
}

/**
 * 自动检测 peer dependency 问题并生成修复列表
 */
async function detectPeerDependencyIssues(
  projectPath: string,
  pm: string
): Promise<Array<{ package: string; version: string; type: "override" }>> {
  const fixes: Array<{ package: string; version: string; type: "override" }> = [];
  const registryClient = new RegistryClient();

  // 运行安装命令获取警告
  let command: string;
  switch (pm) {
    case "npm":
      command = "npm install --dry-run 2>&1";
      break;
    case "pnpm":
      command = "pnpm install --dry-run 2>&1";
      break;
    case "yarn":
      command = "yarn install --dry-run 2>&1";
      break;
    default:
      return fixes;
  }

  const result = await execCommand(command, projectPath);
  const output = result.stdout + result.stderr;

  // 解析 pnpm 的 peer dependency 警告
  // 格式: ✕ unmet peer less@^4: found 3.13.1
  const pnpmPeerRegex = /✕ unmet peer (.+?)@(.+?): found (.+)/g;
  let match;

  while ((match = pnpmPeerRegex.exec(output)) !== null) {
    const [, pkgName, required, found] = match;

    // 检查是否已经添加过
    if (fixes.some((f) => f.package === pkgName)) {
      continue;
    }

    // 确定目标版本
    let targetVersion: string;

    // 如果需要的版本比已安装的低，使用已安装的版本（因为某些包可能向后兼容）
    // 如果需要的版本比已安装的高，查询 registry 获取满足要求的版本
    if (required.startsWith("^") || required.startsWith("~") || required.startsWith(">=")) {
      // 查询 registry 获取最新满足要求的版本
      const pkgInfo = await registryClient.getPackageInfo(pkgName);
      if (pkgInfo) {
        const semver = await import("semver");
        const allVersions = Object.keys(pkgInfo.versions);
        const satisfying = semver.maxSatisfying(allVersions, required);
        if (satisfying) {
          targetVersion = satisfying;
        } else {
          // 如果没有满足的版本，使用最新版本
          targetVersion = pkgInfo["dist-tags"].latest;
        }
      } else {
        // 无法获取 registry 信息，尝试提取版本号
        const versionMatch = required.match(/[\d.]+/);
        targetVersion = versionMatch ? versionMatch[0] : found;
      }
    } else {
      // 精确版本
      targetVersion = required;
    }

    fixes.push({
      package: pkgName,
      version: targetVersion,
      type: "override",
    });
  }

  // 解析 npm 的 peer dependency 警告
  // 格式: npm warn peer dep missing: react@>=16, required by some-package
  const npmPeerRegex = /peer dep missing: (.+?)@(.+?),/g;
  while ((match = npmPeerRegex.exec(output)) !== null) {
    const [, pkgName, required] = match;

    if (fixes.some((f) => f.package === pkgName)) {
      continue;
    }

    // 查询 registry 获取满足要求的版本
    const pkgInfo = await registryClient.getPackageInfo(pkgName);
    let targetVersion = required.replace(/[<>=^~]/g, "");

    if (pkgInfo) {
      const semver = await import("semver");
      const allVersions = Object.keys(pkgInfo.versions);
      const satisfying = semver.maxSatisfying(allVersions, required);
      if (satisfying) {
        targetVersion = satisfying;
      }
    }

    fixes.push({
      package: pkgName,
      version: targetVersion,
      type: "override",
    });
  }

  return fixes;
}

/**
 * 格式化修复报告
 */
function formatFixReport(result: FixResult, dryRun: boolean): string {
  const lines: string[] = [];

  lines.push(`## 依赖修复报告${dryRun ? " (预览模式)" : ""}\n`);

  // 应用的修复
  if (result.appliedFixes.length > 0) {
    lines.push("### 已应用的修复\n");
    lines.push("| 包名 | 操作 | 目标版本 |");
    lines.push("|------|------|----------|");
    for (const fix of result.appliedFixes) {
      lines.push(`| ${fix.package} | ${fix.action} | ${fix.to} |`);
    }
    lines.push("");
  } else {
    lines.push("*未应用任何修复*\n");
  }

  // 修改的文件
  if (result.modifiedFiles.length > 0) {
    lines.push("### 修改的文件");
    for (const file of result.modifiedFiles) {
      lines.push(`- ${file}`);
    }
    lines.push("");
  }

  // 执行的命令
  if (result.commands.length > 0) {
    lines.push("### 执行的命令");
    lines.push("```bash");
    for (const cmd of result.commands) {
      lines.push(cmd);
    }
    lines.push("```");
    lines.push("");
  }

  // 警告
  if (result.warnings.length > 0) {
    lines.push("### ⚠️ 警告");
    for (const warning of result.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }

  // 错误
  if (result.errors.length > 0) {
    lines.push("### ❌ 错误");
    for (const error of result.errors) {
      lines.push(`- ${error}`);
    }
    lines.push("");
  }

  // 结果
  if (result.success && result.appliedFixes.length > 0) {
    if (dryRun) {
      lines.push("---\n*这是预览模式，实际文件未被修改。设置 `dryRun: false` 来执行修复。*");
    } else {
      lines.push("---\n✅ **修复完成！** 请重新运行你的构建/安装命令验证结果。");
    }
  }

  return lines.join("\n");
}
