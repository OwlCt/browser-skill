import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { configInternals, loadConfig } from "../src/config.mjs";

test("loadConfig supports third-party Responses endpoints", () => {
  const config = loadConfig({
    OPENAI_API_KEY: "provider-key",
    OPENAI_BASE_URL: "https://provider.example/v1/",
    OPENAI_MODEL: "codex-compatible",
    RESPONSES_STATE_MODE: "manual",
    RESPONSES_COMPAT_MODE: "minimal",
    BROWSER_ALLOWED_ORIGINS: "https://example.com,http://localhost:3000",
    LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
    EDGE_USER_DATA_DIR: ".mcp-edge-profile",
    EDGE_REQUIRE_DEDICATED_PROFILE: "true",
    EDGE_BRING_TO_FRONT: "false",
    EDGE_HEADLESS: "true",
    EDGE_AUTO_CLOSE_TABS: "true",
    EDGE_CLEAR_SESSION_TABS_ON_START: "true",
    EDGE_TAB_IDLE_TIMEOUT_MS: "60000",
    EDGE_POPUP_QUIET_MS: "250",
  }, "C:\\workspace");

  assert.equal(config.baseURL, "https://provider.example/v1");
  assert.equal(config.model, "codex-compatible");
  assert.equal(config.stateMode, "manual");
  assert.equal(config.compatMode, "minimal");
  assert.deepEqual([...config.allowedOrigins], ["https://example.com", "http://localhost:3000"]);
  assert.equal(config.edgeUserDataDir, path.resolve("C:\\workspace", ".mcp-edge-profile"));
  assert.equal(config.requireDedicatedProfile, true);
  assert.equal(config.bringToFront, false);
  assert.equal(config.headless, true);
  assert.equal(config.autoCloseTabs, true);
  assert.equal(config.clearSessionTabsOnStart, true);
  assert.equal(config.tabIdleTimeoutMs, 60_000);
  assert.equal(config.popupQuietMs, 250);
});

test("loadConfig rejects invalid compatibility modes", () => {
  assert.throws(
    () => loadConfig({ RESPONSES_COMPAT_MODE: "maybe" }),
    /RESPONSES_COMPAT_MODE/,
  );
});

test("boolean parsing is explicit", () => {
  assert.equal(configInternals.parseBoolean("yes", false, "FLAG"), true);
  assert.equal(configInternals.parseBoolean("off", true, "FLAG"), false);
  assert.throws(() => configInternals.parseBoolean("sometimes", false, "FLAG"), /FLAG/);
});

test("tab lifecycle timing rejects unsafe values", () => {
  assert.throws(
    () => loadConfig({ EDGE_TAB_IDLE_TIMEOUT_MS: "-1" }),
    /EDGE_TAB_IDLE_TIMEOUT_MS/,
  );
  assert.throws(
    () => loadConfig({ EDGE_POPUP_QUIET_MS: "5000" }),
    /EDGE_POPUP_QUIET_MS/,
  );
});
