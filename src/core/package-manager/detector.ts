/**
 * 包管理器检测器
 * 自动检测项目使用的包管理器类型
 */

import * as path from "node:path";
import {
  fileExists,
  readJsonFile,
  readTextFile,
  execCommand,
} from "../../utils/index.js";
import type {
  PackageManagerName,
  PackageManagerInfo,
  PackageJson,
  WorkspaceConfig,
  WorkspaceInfo,
} from "../../types/index.js";
import { glob } from "glob";
import { parse as parseYaml } from "yaml";

// Lock 文件映射
const LOCK_FILES: Record<PackageManagerName, string> = {
  npm: "package-lock.json",
  pnpm: "pnpm-lock.yaml",
  yarn: "yarn.lock",
};

/**
 * 检测项目使用的包管理器
 */
export async function detectPackageManager(
  projectPath: string
): Promise<PackageManagerInfo> {
  // 1. 首先检查 package.json 中的 packageManager 字段
  const packageJsonPath = path.join(projectPath, "package.json");
  const packageJson = await readJsonFile<PackageJson>(packageJsonPath);

  if (packageJson?.packageManager) {
    const match = packageJson.packageManager.match(/^(npm|pnpm|yarn)@(.+)$/);
    if (match) {
      const [, name, version] = match;
      const pmName = name as PackageManagerName;
      const lockFile = LOCK_FILES[pmName];
      const lockFilePath = path.join(projectPath, lockFile);
      return {
        name: pmName,
        version,
        lockFile: (await fileExists(lockFilePath)) ? lockFile : null,
        lockFilePath: (await fileExists(lockFilePath)) ? lockFilePath : null,
      };
    }
  }

  // 2. 检查 lock 文件
  for (const [pmName, lockFile] of Object.entries(LOCK_FILES)) {
    const lockFilePath = path.join(projectPath, lockFile);
    if (await fileExists(lockFilePath)) {
      const version = await getPackageManagerVersion(
        pmName as PackageManagerName,
        projectPath
      );
      return {
        name: pmName as PackageManagerName,
        version,
        lockFile,
        lockFilePath,
      };
    }
  }

  // 3. 默认使用 npm
  const version = await getPackageManagerVersion("npm", projectPath);
  return {
    name: "npm",
    version,
    lockFile: null,
    lockFilePath: null,
  };
}

/**
 * 获取包管理器版本
 */
async function getPackageManagerVersion(
  pm: PackageManagerName,
  cwd: string
): Promise<string> {
  const result = await execCommand(`${pm} --version`, cwd);
  if (result.exitCode === 0) {
    return result.stdout.trim();
  }
  return "unknown";
}

/**
 * 检测 workspace 配置
 */
export async function detectWorkspaces(
  projectPath: string,
  pm: PackageManagerName
): Promise<WorkspaceConfig> {
  const packageJsonPath = path.join(projectPath, "package.json");
  const packageJson = await readJsonFile<PackageJson>(packageJsonPath);

  // pnpm 使用 pnpm-workspace.yaml
  if (pm === "pnpm") {
    const pnpmWorkspacePath = path.join(projectPath, "pnpm-workspace.yaml");
    const pnpmWorkspaceContent = await readTextFile(pnpmWorkspacePath);
    if (pnpmWorkspaceContent) {
      try {
        const pnpmWorkspace = parseYaml(pnpmWorkspaceContent) as {
          packages?: string[];
        };
        if (pnpmWorkspace.packages && pnpmWorkspace.packages.length > 0) {
          return {
            enabled: true,
            packages: pnpmWorkspace.packages,
            configSource: "pnpm-workspace.yaml",
          };
        }
      } catch {
        // 解析失败，继续检查 package.json
      }
    }
  }

  // 检查 package.json 中的 workspaces 字段
  if (packageJson?.workspaces) {
    const packages = Array.isArray(packageJson.workspaces)
      ? packageJson.workspaces
      : packageJson.workspaces.packages || [];
    if (packages.length > 0) {
      return {
        enabled: true,
        packages,
        configSource: "package.json",
      };
    }
  }

  return {
    enabled: false,
    packages: [],
    configSource: null,
  };
}

/**
 * 获取所有 workspace 包信息
 */
export async function getWorkspacePackages(
  projectPath: string,
  workspaceConfig: WorkspaceConfig
): Promise<WorkspaceInfo[]> {
  if (!workspaceConfig.enabled) {
    return [];
  }

  const workspaces: WorkspaceInfo[] = [];

  for (const pattern of workspaceConfig.packages) {
    const matches = await glob(pattern, {
      cwd: projectPath,
      absolute: false,
    });

    for (const match of matches) {
      const pkgPath = path.join(projectPath, match);
      const pkgJsonPath = path.join(pkgPath, "package.json");
      const pkgJson = await readJsonFile<PackageJson>(pkgJsonPath);

      if (pkgJson) {
        workspaces.push({
          name: pkgJson.name,
          path: pkgPath,
          relativePath: match,
          version: pkgJson.version,
          packageJson: pkgJson,
        });
      }
    }
  }

  return workspaces;
}

/**
 * 获取 overrides/resolutions 配置
 */
export function getOverrides(
  packageJson: PackageJson,
  pm: PackageManagerName
): Record<string, string> {
  const result: Record<string, string> = {};

  switch (pm) {
    case "npm":
      if (packageJson.overrides) {
        flattenOverrides(packageJson.overrides, result);
      }
      break;
    case "pnpm":
      if (packageJson.pnpm?.overrides) {
        Object.assign(result, packageJson.pnpm.overrides);
      }
      // pnpm 也支持 package.json 中的 overrides
      if (packageJson.overrides) {
        flattenOverrides(packageJson.overrides, result);
      }
      break;
    case "yarn":
      if (packageJson.resolutions) {
        Object.assign(result, packageJson.resolutions);
      }
      break;
  }

  return result;
}

/**
 * 扁平化嵌套的 overrides
 */
function flattenOverrides(
  overrides: Record<string, string | Record<string, string>>,
  result: Record<string, string>,
  prefix = ""
): void {
  for (const [key, value] of Object.entries(overrides)) {
    const fullKey = prefix ? `${prefix}>${key}` : key;
    if (typeof value === "string") {
      result[fullKey] = value;
    } else {
      flattenOverrides(value, result, fullKey);
    }
  }
}

/**
 * 检测是否为 monorepo
 */
export async function isMonorepo(
  projectPath: string,
  pm: PackageManagerName
): Promise<boolean> {
  const workspaceConfig = await detectWorkspaces(projectPath, pm);
  return workspaceConfig.enabled;
}

/**
 * 获取 Node.js 版本约束
 */
export function getNodeVersionConstraint(
  packageJson: PackageJson
): string | null {
  return packageJson.engines?.node || null;
}

/**
 * 获取当前 Node.js 版本
 */
export function getCurrentNodeVersion(): string {
  return process.version.replace(/^v/, "");
}
