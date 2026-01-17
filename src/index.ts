#!/usr/bin/env node

/**
 * Dependency Doctor MCP Server
 * 入口文件
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  console.error("[Dependency Doctor] Server running on stdio transport");
}

main().catch((error) => {
  console.error("[Dependency Doctor] Fatal error:", error);
  process.exit(1);
});
