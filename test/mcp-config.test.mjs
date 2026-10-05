import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadMcpConfig } from "../src/mcp-config.mjs";

test("MCP client overrides project defaults without loading provider credentials", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-config-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, ".env"), "OPENAI_API_KEY=synthetic-dotenv-key\nEDGE_HEADLESS=true\n");
  fs.writeFileSync(path.join(root, ".env.mcp"), "EDGE_HEADLESS=false\nEDGE_KEEP_OPEN=true\nEDGE_USER_DATA_DIR=.profile\nOPENAI_API_KEY=synthetic-mcp-key\n");
  const defaults = loadMcpConfig({}, root);
  assert.equal(defaults.headless, false);
  assert.equal(defaults.keepEdgeOpen, true);
  assert.equal(defaults.edgeUserDataDir, path.join(root, ".profile"));
  assert.equal(defaults.apiKey, "");
  const override = loadMcpConfig({
    EDGE_HEADLESS: "true", EDGE_KEEP_OPEN: "false", EDGE_CDP_URL: "http://127.0.0.1:12345",
    OPENAI_API_KEY: "synthetic-parent-key", OPENAI_BASE_URL: "https://provider.example/v1",
  }, root);
  assert.equal(override.headless, true);
  assert.equal(override.keepEdgeOpen, false);
  assert.equal(override.cdpUrl, "http://127.0.0.1:12345");
  assert.equal(override.apiKey, "");
  assert.equal(override.baseURL, "https://api.openai.com/v1");
});
