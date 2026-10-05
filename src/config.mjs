import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

function parseBoolean(value, fallback, name) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be true or false.`);
}

function parseEnum(value, allowed, fallback, name) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!allowed.includes(normalized)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}.`);
  }
  return normalized;
}

function parseProfileDirectory(value) {
  const name = value == null || value === "" ? "Default" : String(value).trim();
  if (!/^(Default|Profile \d+)$/.test(name)) {
    throw new Error("EDGE_PROFILE_DIRECTORY must be Default or Profile N.");
  }
  return name;
}

export function userEdgeDataDirectory(env = process.env) {
  return userBrowserDataDirectory("edge", env);
}

export function userBrowserDataDirectory(product, env = process.env) {
  if (product === "chrome") {
    if (process.platform === "win32" && env.LOCALAPPDATA) {
      return path.join(env.LOCALAPPDATA, "Google", "Chrome", "User Data");
    }
    if (process.platform === "darwin") {
      return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
    }
    return path.join(os.homedir(), ".config", "google-chrome");
  }
  if (process.platform === "win32" && env.LOCALAPPDATA) {
    return path.join(env.LOCALAPPDATA, "Microsoft", "Edge", "User Data");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Microsoft Edge");
  }
  return path.join(os.homedir(), ".config", "microsoft-edge");
}

export function externalLifecycleDirectory(profilePath, cwd) {
  const hash = createHash("sha256").update(path.resolve(profilePath).toLowerCase()).digest("hex").slice(0, 16);
  return path.resolve(cwd, ".runtime", "lifecycle", hash);
}

function parseInteger(value, fallback, name, { min, max }) {
  if (value == null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function defaultEdgeProfile(env) {
  if (process.platform === "win32" && env.LOCALAPPDATA) {
    return path.join(env.LOCALAPPDATA, "ResponsesEdgeProfile");
  }
  return path.join(os.homedir(), ".responses-edge-profile");
}

function resolveEdgeProfile(value, env, cwd) {
  const configured = value?.trim();
  return configured ? path.resolve(cwd, configured) : path.resolve(defaultEdgeProfile(env));
}

function parseAllowedOrigins(value) {
  if (!value?.trim()) return new Set();

  return new Set(
    value.split(",").map((entry) => {
      const url = new URL(entry.trim());
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("BROWSER_ALLOWED_ORIGINS only accepts HTTP(S) origins.");
      }
      return url.origin;
    }),
  );
}

function resolveProfileSelection(env, cwd) {
  const browserProduct = parseEnum(env.BROWSER_PRODUCT, ["edge", "chrome"], "edge", "BROWSER_PRODUCT");
  const profileTarget = parseEnum(
    env.EDGE_PROFILE_TARGET,
    ["dedicated", "user", "custom"],
    "dedicated",
    "EDGE_PROFILE_TARGET",
  );
  const profileDirectory = parseProfileDirectory(env.EDGE_PROFILE_DIRECTORY);
  const dedicatedProfiles = {
    edge: resolveEdgeProfile(env.EDGE_USER_DATA_DIR, env, cwd),
    chrome: env.BROWSER_CHROME_USER_DATA_DIR?.trim()
      ? path.resolve(cwd, env.BROWSER_CHROME_USER_DATA_DIR.trim())
      : path.resolve(cwd, ".mcp-chrome-profile"),
  };
  const dedicatedUserDataDir = dedicatedProfiles[browserProduct];
  const dedicatedRequireProfile = parseBoolean(
    env.EDGE_REQUIRE_DEDICATED_PROFILE,
    false,
    "EDGE_REQUIRE_DEDICATED_PROFILE",
  );
  const dedicatedAutoCloseTabs = parseBoolean(env.EDGE_AUTO_CLOSE_TABS, false, "EDGE_AUTO_CLOSE_TABS");
  const dedicatedClearSessionTabs = parseBoolean(
    env.EDGE_CLEAR_SESSION_TABS_ON_START,
    false,
    "EDGE_CLEAR_SESSION_TABS_ON_START",
  );
  const external = profileTarget === "user" || profileTarget === "custom";
  let edgeUserDataDir = dedicatedUserDataDir;
  if (profileTarget === "user") {
    edgeUserDataDir = userBrowserDataDirectory(browserProduct, env);
  } else if (profileTarget === "custom") {
    const custom = env.EDGE_CUSTOM_USER_DATA_DIR?.trim();
    if (!custom) throw new Error("EDGE_PROFILE_TARGET=custom requires EDGE_CUSTOM_USER_DATA_DIR.");
    edgeUserDataDir = path.resolve(custom);
  }

  return {
    workspaceRoot: path.resolve(cwd),
    browserProduct,
    dedicatedProfiles,
    profileTarget,
    profileDirectory,
    dedicatedUserDataDir,
    dedicatedRequireProfile,
    dedicatedAutoCloseTabs,
    dedicatedClearSessionTabs,
    edgeUserDataDir,
    requireDedicatedProfile: external ? false : dedicatedRequireProfile,
    autoCloseTabs: external ? false : dedicatedAutoCloseTabs,
    clearSessionTabsOnStart: external ? false : dedicatedClearSessionTabs,
    lifecycleDirectory: external
      ? externalLifecycleDirectory(edgeUserDataDir, cwd)
      : dedicatedUserDataDir,
  };
}

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const stateMode = (env.RESPONSES_STATE_MODE || "manual").trim().toLowerCase();
  if (!["manual", "previous"].includes(stateMode)) {
    throw new Error('RESPONSES_STATE_MODE must be "manual" or "previous".');
  }
  const compatMode = (env.RESPONSES_COMPAT_MODE || "standard").trim().toLowerCase();
  if (!["standard", "minimal"].includes(compatMode)) {
    throw new Error('RESPONSES_COMPAT_MODE must be "standard" or "minimal".');
  }

  return {
    apiKey: env.OPENAI_API_KEY?.trim() || "",
    baseURL: (env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim().replace(/\/+$/, ""),
    model: (env.OPENAI_MODEL || "gpt-5.6").trim(),
    stateMode,
    compatMode,
    storeResponses: parseBoolean(env.OPENAI_STORE, false, "OPENAI_STORE"),
    requestTimeoutMs: parseInteger(
      env.OPENAI_TIMEOUT_MS,
      120_000,
      "OPENAI_TIMEOUT_MS",
      { min: 1_000, max: 900_000 },
    ),
    maxToolSteps: parseInteger(
      env.BROWSER_MAX_STEPS,
      40,
      "BROWSER_MAX_STEPS",
      { min: 1, max: 200 },
    ),
    cdpUrl: (env.EDGE_CDP_URL || "http://127.0.0.1:9222").trim(),
    autoLaunchEdge: parseBoolean(env.EDGE_AUTO_LAUNCH, true, "EDGE_AUTO_LAUNCH"),
    edgeExecutable: env.EDGE_EXECUTABLE?.trim() || "",
    chromeExecutable: env.BROWSER_CHROME_EXECUTABLE?.trim() || "",
    ...resolveProfileSelection(env, cwd),
    keepEdgeOpen: parseBoolean(env.EDGE_KEEP_OPEN, true, "EDGE_KEEP_OPEN"),
    bringToFront: parseBoolean(env.EDGE_BRING_TO_FRONT, true, "EDGE_BRING_TO_FRONT"),
    headless: parseBoolean(env.EDGE_HEADLESS, false, "EDGE_HEADLESS"),
    disableExtensions: parseBoolean(env.EDGE_DISABLE_EXTENSIONS, true, "EDGE_DISABLE_EXTENSIONS"),
    stealth: parseBoolean(env.EDGE_STEALTH, false, "EDGE_STEALTH"),
    connectionMode: parseEnum(env.EDGE_CONNECTION_MODE, ["managed", "attach"], "managed", "EDGE_CONNECTION_MODE"),
    tabIdleTimeoutMs: parseInteger(
      env.EDGE_TAB_IDLE_TIMEOUT_MS,
      0,
      "EDGE_TAB_IDLE_TIMEOUT_MS",
      { min: 0, max: 3_600_000 },
    ),
    popupQuietMs: parseInteger(
      env.EDGE_POPUP_QUIET_MS,
      200,
      "EDGE_POPUP_QUIET_MS",
      { min: 0, max: 2_000 },
    ),
    allowRemoteCdp: parseBoolean(env.ALLOW_REMOTE_CDP, false, "ALLOW_REMOTE_CDP"),
    allowedOrigins: parseAllowedOrigins(env.BROWSER_ALLOWED_ORIGINS),
    sitePolicy: parseEnum(env.BROWSER_SITE_POLICY, ["ask", "allow"], "ask", "BROWSER_SITE_POLICY"),
    maxTextChars: parseInteger(
      env.BROWSER_MAX_TEXT_CHARS,
      20_000,
      "BROWSER_MAX_TEXT_CHARS",
      { min: 1_000, max: 100_000 },
    ),
    inlineScreenshots: parseBoolean(
      env.BROWSER_INLINE_SCREENSHOTS,
      false,
      "BROWSER_INLINE_SCREENSHOTS",
    ),
    artifactsDir: path.resolve(cwd, env.BROWSER_ARTIFACTS_DIR?.trim() || "artifacts"),
  };
}

export function assertApiConfig(config) {
  if (!config.apiKey) {
    throw new Error("OPENAI_API_KEY is missing. Copy .env.example to .env and set it.");
  }
  if (!config.model) throw new Error("OPENAI_MODEL is missing.");
  try {
    new URL(config.baseURL);
  } catch {
    throw new Error("OPENAI_BASE_URL must be an absolute URL.");
  }
}

export const configInternals = {
  parseAllowedOrigins,
  parseBoolean,
  parseInteger,
};
