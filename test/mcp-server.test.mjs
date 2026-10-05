import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("stdio MCP server initializes and lists all browser tools", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "src", "mcp-server.mjs")],
    cwd: root,
    env: {
      ...process.env,
      EDGE_AUTO_LAUNCH: "false",
    },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "responses-edge-browser-test", version: "1.0.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    const result = await client.listTools();
    assert.equal(result.tools.length, 21);
    assert.ok(result.tools.some((tool) => tool.name === "browser_runtime"));
    assert.ok(result.tools.some((tool) => tool.name === "browser_handoff"));
    assert.ok(result.tools.some((tool) => tool.name === "browser_snapshot"));
    assert.ok(result.tools.some((tool) => tool.name === "browser_screenshot"));
    assert.match(client.getInstructions(), /local Edge or Chrome profile/);
    assert.match(client.getInstructions(), /background mode must not bring Edge to the foreground/);
    assert.match(client.getInstructions(), /Idle session tabs close automatically/);
  } finally {
    await client.close();
  }
});
