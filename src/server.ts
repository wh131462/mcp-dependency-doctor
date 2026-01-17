/**
 * Dependency Doctor MCP Server
 * 专门用于诊断和修复 Node.js 项目依赖冲突的 MCP 服务器
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerDetectEnvironmentTool,
  registerAnalyzeDependenciesTool,
  registerDetectConflictsTool,
  registerTraceDependencyTool,
  registerQueryRegistryTool,
  registerSuggestSolutionsTool,
  registerApplyFixTool,
} from "./tools/index.js";

/**
 * 创建 MCP 服务器实例
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "dependency-doctor",
    version: "1.0.0",
  });

  // 注册所有 tools
  registerDetectEnvironmentTool(server);
  registerAnalyzeDependenciesTool(server);
  registerDetectConflictsTool(server);
  registerTraceDependencyTool(server);
  registerQueryRegistryTool(server);
  registerSuggestSolutionsTool(server);
  registerApplyFixTool(server);

  console.error("[Dependency Doctor] MCP server initialized with 7 tools:");
  console.error("  - detect_environment: 检测项目环境和包管理器配置");
  console.error("  - analyze_dependencies: 分析依赖树结构");
  console.error("  - detect_conflicts: 检测依赖冲突和问题");
  console.error("  - trace_dependency: 追踪特定依赖的来源路径");
  console.error("  - query_registry: 查询 NPM Registry 包信息");
  console.error("  - suggest_solutions: 生成解决方案建议");
  console.error("  - apply_fix: 自动修复依赖冲突");

  return server;
}
