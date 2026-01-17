/**
 * query_registry Tool
 * 查询 npm registry 获取包的版本信息、peerDependencies 等
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RegistryClient } from "../core/registry/index.js";
import { getMaxSatisfying } from "../utils/index.js";

// 查询类型
const queryTypes = ["latest", "versions", "peerDependencies", "full", "compatibility"] as const;

// 输入参数 Schema
export const queryRegistrySchema = z.object({
  packageName: z.string().describe("包名"),
  query: z.enum(queryTypes).describe("查询类型"),
  version: z.string().optional().describe("指定版本，用于获取特定版本的信息"),
  registry: z.string().optional().describe("自定义 registry URL"),
  targetVersion: z.string().optional().describe("目标版本范围，用于兼容性检查"),
});

export type QueryRegistryInput = z.infer<typeof queryRegistrySchema>;

interface QueryRegistryOutput {
  name: string;
  latestVersion: string | null;
  distTags: Record<string, string>;
  versions?: string[];
  requestedVersion?: {
    version: string;
    publishedAt?: string;
    deprecated?: string;
    engines?: Record<string, string>;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  compatibility?: {
    version: string;
    peerDependencies: Record<
      string,
      {
        required: string;
        latestCompatible: string | null;
        isOptional: boolean;
      }
    >;
    nodeRequirement: string | null;
  };
  metadata?: {
    description?: string;
    homepage?: string;
    repository?: string;
    license?: string;
    maintainers?: string[];
  };
  cached: boolean;
  fetchedAt: string;
}

/**
 * 注册 query_registry tool
 */
export function registerQueryRegistryTool(server: McpServer): void {
  server.tool(
    "query_registry",
    "查询 npm registry 获取包的版本信息、peerDependencies、兼容性信息。支持自定义 registry。",
    queryRegistrySchema.shape,
    async (input: QueryRegistryInput) => {
      try {
        const result = await queryRegistry(input);
        return {
          content: [
            {
              type: "text" as const,
              text: formatRegistryReport(result, input.query),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `查询 Registry 失败: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

/**
 * 查询 Registry
 */
async function queryRegistry(
  input: QueryRegistryInput
): Promise<QueryRegistryOutput> {
  const { packageName, query, version, registry } = input;

  const client = new RegistryClient({
    registry: registry || undefined,
  });

  // 获取包信息
  const packageInfo = await client.getPackageInfo(packageName);

  if (!packageInfo) {
    throw new Error(`包 ${packageName} 不存在或无法访问`);
  }

  const latestVersion = packageInfo["dist-tags"].latest || null;
  const requestedVersionStr = version || latestVersion;

  // 构建基础输出
  const output: QueryRegistryOutput = {
    name: packageName,
    latestVersion,
    distTags: packageInfo["dist-tags"],
    cached: false,
    fetchedAt: new Date().toISOString(),
  };

  // 根据查询类型填充数据
  switch (query) {
    case "latest":
      // 只需要基础信息
      break;

    case "versions":
      output.versions = Object.keys(packageInfo.versions).sort((a, b) => {
        try {
          // 尝试语义化排序
          const semverCompare = require("semver").compare;
          return semverCompare(b, a);
        } catch {
          return b.localeCompare(a);
        }
      });
      break;

    case "peerDependencies":
      if (requestedVersionStr && packageInfo.versions[requestedVersionStr]) {
        const versionInfo = packageInfo.versions[requestedVersionStr];
        output.requestedVersion = {
          version: requestedVersionStr,
          peerDependencies: versionInfo.peerDependencies,
          peerDependenciesMeta: versionInfo.peerDependenciesMeta,
        };
      }
      break;

    case "full":
      output.versions = Object.keys(packageInfo.versions);
      if (requestedVersionStr && packageInfo.versions[requestedVersionStr]) {
        const versionInfo = packageInfo.versions[requestedVersionStr];
        output.requestedVersion = {
          version: requestedVersionStr,
          publishedAt: packageInfo.time?.[requestedVersionStr],
          deprecated: versionInfo.deprecated,
          engines: versionInfo.engines,
          dependencies: versionInfo.dependencies,
          peerDependencies: versionInfo.peerDependencies,
          peerDependenciesMeta: versionInfo.peerDependenciesMeta,
        };
      }
      output.metadata = {
        description: packageInfo.description,
        homepage: packageInfo.homepage,
        repository:
          typeof packageInfo.repository === "object"
            ? packageInfo.repository.url
            : undefined,
        license: packageInfo.license,
        maintainers: packageInfo.maintainers?.map((m) => m.name),
      };
      break;

    case "compatibility":
      if (requestedVersionStr && packageInfo.versions[requestedVersionStr]) {
        const versionInfo = packageInfo.versions[requestedVersionStr];
        const peerDeps = versionInfo.peerDependencies || {};
        const peerDepsMeta = versionInfo.peerDependenciesMeta || {};

        const peerCompatibility: Record<
          string,
          { required: string; latestCompatible: string | null; isOptional: boolean }
        > = {};

        // 检查每个 peer 依赖
        for (const [peerName, peerRange] of Object.entries(peerDeps)) {
          const isOptional = peerDepsMeta[peerName]?.optional || false;

          // 获取 peer 依赖的最新兼容版本
          let latestCompatible: string | null = null;
          try {
            const peerInfo = await client.getPackageInfo(peerName);
            if (peerInfo) {
              const allVersions = Object.keys(peerInfo.versions);
              latestCompatible = getMaxSatisfying(allVersions, peerRange);
            }
          } catch {
            // 获取失败
          }

          peerCompatibility[peerName] = {
            required: peerRange,
            latestCompatible,
            isOptional,
          };
        }

        output.compatibility = {
          version: requestedVersionStr,
          peerDependencies: peerCompatibility,
          nodeRequirement: versionInfo.engines?.node || null,
        };
      }
      break;
  }

  return output;
}

/**
 * 格式化 Registry 报告
 */
function formatRegistryReport(
  output: QueryRegistryOutput,
  query: string
): string {
  const lines: string[] = [];

  lines.push(`## NPM Registry 查询: ${output.name}\n`);
  lines.push(`*查询时间: ${output.fetchedAt}*\n`);

  // 基础信息
  lines.push("### 基础信息");
  lines.push(`- **最新版本**: ${output.latestVersion || "未知"}`);

  // dist-tags
  if (Object.keys(output.distTags).length > 1) {
    lines.push("- **发布标签**:");
    for (const [tag, version] of Object.entries(output.distTags)) {
      lines.push(`  - ${tag}: ${version}`);
    }
  }
  lines.push("");

  // 根据查询类型显示不同内容
  switch (query) {
    case "versions":
      if (output.versions) {
        lines.push("### 所有版本");
        const recentVersions = output.versions.slice(0, 20);
        lines.push("");
        lines.push("最近发布的版本:");
        for (const v of recentVersions) {
          lines.push(`- ${v}`);
        }
        if (output.versions.length > 20) {
          lines.push(`- ... 共 ${output.versions.length} 个版本`);
        }
      }
      break;

    case "peerDependencies":
      if (output.requestedVersion) {
        lines.push(`### Peer Dependencies (${output.requestedVersion.version})`);
        const peers = output.requestedVersion.peerDependencies;
        const peerMeta = output.requestedVersion.peerDependenciesMeta;
        if (peers && Object.keys(peers).length > 0) {
          lines.push("");
          lines.push("| 包名 | 版本要求 | 可选 |");
          lines.push("|------|----------|------|");
          for (const [name, range] of Object.entries(peers)) {
            const optional = peerMeta?.[name]?.optional ? "是" : "否";
            lines.push(`| ${name} | ${range} | ${optional} |`);
          }
        } else {
          lines.push("*无 peer dependencies*");
        }
      }
      break;

    case "full":
      if (output.metadata) {
        lines.push("### 包元数据");
        if (output.metadata.description) {
          lines.push(`- **描述**: ${output.metadata.description}`);
        }
        if (output.metadata.homepage) {
          lines.push(`- **主页**: ${output.metadata.homepage}`);
        }
        if (output.metadata.repository) {
          lines.push(`- **仓库**: ${output.metadata.repository}`);
        }
        if (output.metadata.license) {
          lines.push(`- **许可证**: ${output.metadata.license}`);
        }
        if (output.metadata.maintainers?.length) {
          lines.push(`- **维护者**: ${output.metadata.maintainers.join(", ")}`);
        }
        lines.push("");
      }

      if (output.requestedVersion) {
        lines.push(`### 版本详情 (${output.requestedVersion.version})`);
        if (output.requestedVersion.publishedAt) {
          lines.push(`- **发布时间**: ${output.requestedVersion.publishedAt}`);
        }
        if (output.requestedVersion.deprecated) {
          lines.push(`- ⚠️ **已废弃**: ${output.requestedVersion.deprecated}`);
        }
        if (output.requestedVersion.engines) {
          lines.push("- **引擎要求**:");
          for (const [engine, range] of Object.entries(
            output.requestedVersion.engines
          )) {
            lines.push(`  - ${engine}: ${range}`);
          }
        }
        lines.push("");

        // 依赖
        if (output.requestedVersion.dependencies) {
          const deps = Object.entries(output.requestedVersion.dependencies);
          lines.push(`### Dependencies (${deps.length})`);
          if (deps.length > 0) {
            lines.push("");
            for (const [name, range] of deps.slice(0, 15)) {
              lines.push(`- ${name}: ${range}`);
            }
            if (deps.length > 15) {
              lines.push(`- ... 共 ${deps.length} 个依赖`);
            }
          }
          lines.push("");
        }

        // Peer 依赖
        if (output.requestedVersion.peerDependencies) {
          const peers = Object.entries(output.requestedVersion.peerDependencies);
          lines.push(`### Peer Dependencies (${peers.length})`);
          if (peers.length > 0) {
            lines.push("");
            lines.push("| 包名 | 版本要求 | 可选 |");
            lines.push("|------|----------|------|");
            for (const [name, range] of peers) {
              const optional =
                output.requestedVersion.peerDependenciesMeta?.[name]?.optional
                  ? "是"
                  : "否";
              lines.push(`| ${name} | ${range} | ${optional} |`);
            }
          }
        }
      }

      if (output.versions) {
        lines.push("");
        lines.push(`### 版本统计`);
        lines.push(`- **总版本数**: ${output.versions.length}`);
      }
      break;

    case "compatibility":
      if (output.compatibility) {
        lines.push(`### 兼容性分析 (${output.compatibility.version})`);
        lines.push("");

        if (output.compatibility.nodeRequirement) {
          lines.push(`**Node.js 要求**: ${output.compatibility.nodeRequirement}`);
          lines.push("");
        }

        const peers = Object.entries(output.compatibility.peerDependencies);
        if (peers.length > 0) {
          lines.push("**Peer Dependencies 兼容性**:\n");
          lines.push("| 包名 | 版本要求 | 最新兼容版本 | 可选 |");
          lines.push("|------|----------|--------------|------|");
          for (const [name, info] of peers) {
            const latestStr = info.latestCompatible || "未知";
            const optionalStr = info.isOptional ? "是" : "否";
            lines.push(
              `| ${name} | ${info.required} | ${latestStr} | ${optionalStr} |`
            );
          }
          lines.push("");

          // 建议
          lines.push("**建议**:");
          for (const [name, info] of peers) {
            if (!info.isOptional) {
              if (info.latestCompatible) {
                lines.push(
                  `- 安装 ${name}@${info.latestCompatible} 以满足 peer 依赖要求`
                );
              } else {
                lines.push(`- ⚠️ ${name} 无法找到兼容版本，请检查版本要求`);
              }
            }
          }
        } else {
          lines.push("*无 peer dependencies*");
        }
      }
      break;
  }

  return lines.join("\n");
}
