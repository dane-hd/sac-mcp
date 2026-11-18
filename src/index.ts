#!/usr/bin/env node

/**
 * SAP Analytics Cloud — MCP Server
 *
 * Entry point.  Boots the MCP server over stdio transport,
 * registers all tool and resource handlers, then listens.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools/index.js";
import { registerResources } from "./resources/index.js";
import { registerPrompts } from "./prompts/index.js";
import { signIn } from "./tools/auth.js";
import { getConfig } from "./tools/_helpers.js";
import { logout } from "./auth/sac-client.js";

// ── Server metadata ────────────────────────────────────────────────
const SERVER_NAME = "sac-mcp-server";
const SERVER_VERSION = "0.1.0";

async function main(): Promise<void> {
  // 1. Create the MCP server instance
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // 2. Register tool handlers  (src/tools/index.ts)
  registerTools(server);


  // 3. Register resource handlers  (src/resources/index.ts)
  registerResources(server);

  // 4. Register prompt templates (src/prompts/index.ts)
  registerPrompts(server);

  // 4. Connect via stdio transport (the standard for local MCP servers)
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // The server is now running — the SDK handles the JSON-RPC loop.
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

/** `sac-mcp-server login|logout` — sign in or out from a terminal. */
async function cli(command: "login" | "logout"): Promise<void> {
  if (command === "login") {
    const who = await signIn();
    console.error(`Signed in to SAC as ${who.email ?? who.user ?? "unknown user"}.`);
  } else {
    logout(getConfig());
    console.error("Signed out of SAC.");
  }
  process.exit(0);
}

const command = process.argv[2];
(command === "login" || command === "logout" ? cli(command) : main()).catch((error) => {
  if (command) console.error(`${command} failed: ${error instanceof Error ? error.message : error}`);
  else console.error("Fatal error starting MCP server:", error);
  process.exit(1);
});
