#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { createJobBoss2Server } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createJobBoss2Server(config);
  const transport = new StdioServerTransport();
  let closing = false;

  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void server.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await server.connect(transport);
}

try {
  await main();
} catch (error) {
  console.error(
    `jobboss2-mcp: ${error instanceof Error ? error.message : "unknown startup error"}`,
  );
  process.exitCode = 1;
}
