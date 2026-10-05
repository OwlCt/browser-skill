import fs from "node:fs";
import path from "node:path";
import { externalLifecycleDirectory, userBrowserDataDirectory } from "./config.mjs";
import { lifecyclePaths, listLiveClientLeases } from "./edge-lifecycle.mjs";
import { connectEdge, isCdpReady, isLoopbackHost } from "./edge-session.mjs";

export function assertProfileDirectoryName(name) {
  if (!/^(Default|Profile \d+)$/.test(name)) {
    throw new Error("profile_directory must be Default or Profile N.");
  }
  return name;
}

export function assertSelectableCdpUrl(rawUrl, allowRemoteCdp) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("cdp_url must be an absolute HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("cdp_url must use HTTP or HTTPS.");
  }
  if (!allowRemoteCdp && !isLoopbackHost(url.hostname)) {
    throw new Error("cdp_url must be a loopback address.");
  }
  return url.href.replace(/\/+$/, "");
}

function externalProfile(profileTarget) {
  return profileTarget === "user" || profileTarget === "custom";
}

export function listProfileDirectories(userDataDir) {
  if (!userDataDir || !fs.existsSync(userDataDir)) return [];
  try {
    return fs.readdirSync(userDataDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^(Default|Profile \d+)$/.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

const PROFILE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function readProfileNames(userDataDir) {
  const directories = listProfileDirectories(userDataDir);
  let cache = {};
  const localState = path.join(userDataDir, "Local State");
  try {
    if (fs.existsSync(localState) && fs.statSync(localState).size <= 2_000_000) {
      const parsed = JSON.parse(fs.readFileSync(localState, "utf8"));
      cache = parsed?.profile?.info_cache || {};
    }
  } catch {
    cache = {};
  }
  return directories.map((directory) => {
    const rawName = typeof cache[directory]?.name === "string" ? cache[directory].name.trim().slice(0, 80) : "";
    const name = rawName && !PROFILE_EMAIL.test(rawName) ? rawName : "";
    return name ? { directory, name } : { directory };
  });
}

export function runtimeStatePath(cwd = process.cwd()) {
  return path.join(path.resolve(cwd), ".runtime", "browser.json");
}

function chooseValue(value, current, allowed, name) {
  if (value == null || value === "" || value === "keep") return current;
  if (!allowed.includes(value)) throw new Error(`${name} must be keep or ${allowed.join(", ")}.`);
  return value;
}

function chooseBoolean(value, current, name) {
  if (value == null || value === "" || value === "keep") return current;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`${name} must be keep, true, or false.`);
}

export function parseWindowSize(value) {
  if (value == null || value === "" || value === "keep") return undefined;
  if (value === "default") return null;
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(String(value).trim());
  if (!match) throw new Error("window must be keep, default, or WIDTHxHEIGHT.");
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 320 || width > 3840 || height < 320 || height > 2160) {
    throw new Error("window must be between 320x320 and 3840x2160.");
  }
  return { width, height };
}

export function launchIdentity(config) {
  return JSON.stringify({
    browserProduct: config.browserProduct || "edge",
    headless: Boolean(config.headless),
    disableExtensions: config.disableExtensions !== false,
    stealth: config.stealth === true,
    connectionMode: config.connectionMode || "managed",
    profileTarget: config.profileTarget || "dedicated",
    profileDirectory: config.profileDirectory || "Default",
    edgeUserDataDir: path.resolve(config.edgeUserDataDir),
    cdpUrl: config.cdpUrl,
  });
}

export function describeRuntime(config, env = process.env) {
  const external = externalProfile(config.profileTarget);
  const attach = config.connectionMode === "attach";
  return {
    ok: true,
    browser: config.browserProduct || "edge",
    userProfiles: {
      edge: readProfileNames(userBrowserDataDirectory("edge", env)),
      chrome: readProfileNames(userBrowserDataDirectory("chrome", env)),
    },
    headless: Boolean(config.headless),
    loadExtensions: config.disableExtensions === false,
    stealth: config.stealth === true,
    bringToFront: config.bringToFront !== false,
    window: config.windowWidth && config.windowHeight ? `${config.windowWidth}x${config.windowHeight}` : "",
    connectionMode: config.connectionMode || "managed",
    profileTarget: config.profileTarget || "dedicated",
    profileDirectory: config.profileDirectory || "Default",
    userDataDir: path.resolve(config.edgeUserDataDir),
    cdpUrl: config.cdpUrl,
    launchControlled: !attach,
    keepsExternalBrowserOpen: external || attach,
    stealthScope: "Omits --enable-automation only. Does not change the user agent, Canvas, or WebGL, and does not guarantee passing Cloudflare.",
  };
}

export function planRuntimeChange(config, args, env = process.env, cwd = config.workspaceRoot || process.cwd()) {
  if (args.action === "status") return { next: config, relaunch: false, live: false };
  if (args.action !== "apply") throw new Error("browser_runtime action must be status or apply.");

  const browser = chooseValue(args.browser, config.browserProduct || "edge", ["edge", "chrome"], "browser");
  const profileTarget = chooseValue(
    args.profile_target,
    config.profileTarget || "dedicated",
    ["dedicated", "user", "custom"],
    "profile_target",
  );
  const connectionMode = chooseValue(
    args.connection_mode,
    config.connectionMode || "managed",
    ["managed", "attach"],
    "connection_mode",
  );
  const headless = chooseBoolean(args.headless, Boolean(config.headless), "headless");
  const loadExtensions = chooseBoolean(args.load_extensions, config.disableExtensions === false, "load_extensions");
  const stealth = chooseBoolean(args.stealth, config.stealth === true, "stealth");
  const bringToFront = chooseBoolean(args.bring_to_front, config.bringToFront !== false, "bring_to_front");
  const windowSize = parseWindowSize(args.window);
  const external = externalProfile(profileTarget);
  const browserChanged = browser !== (config.browserProduct || "edge");
  const targetChanged = profileTarget !== (config.profileTarget || "dedicated") || browserChanged;
  const customChanged = profileTarget === "custom"
    && Boolean(args.user_data_dir)
    && path.resolve(args.user_data_dir) !== path.resolve(config.edgeUserDataDir);
  if (external && (targetChanged || customChanged) && !chooseBoolean(args.confirm_external_profile, false, "confirm_external_profile")) {
    throw new Error("user and custom profiles contain existing logins. Set confirm_external_profile to true to apply them.");
  }

  const profileDirectory = args.profile_directory
    ? assertProfileDirectoryName(args.profile_directory)
    : (config.profileDirectory || "Default");

  const dedicatedProfiles = config.dedicatedProfiles || {
    edge: config.dedicatedUserDataDir || config.edgeUserDataDir,
    chrome: config.dedicatedUserDataDir || config.edgeUserDataDir,
  };
  let edgeUserDataDir = dedicatedProfiles[browser] || config.edgeUserDataDir;
  if (profileTarget === "user") {
    edgeUserDataDir = userBrowserDataDirectory(browser, env);
  } else if (profileTarget === "custom") {
    if (!args.user_data_dir && config.profileTarget !== "custom") {
      throw new Error("profile_target custom requires user_data_dir.");
    }
    edgeUserDataDir = args.user_data_dir ? path.resolve(args.user_data_dir) : config.edgeUserDataDir;
  }
  edgeUserDataDir = path.resolve(edgeUserDataDir);
  if (external && !fs.existsSync(edgeUserDataDir)) {
    throw new Error(`Browser profile directory does not exist: ${edgeUserDataDir}`);
  }

  const cdpUrl = args.cdp_url
    ? assertSelectableCdpUrl(args.cdp_url, config.allowRemoteCdp)
    : config.cdpUrl;

  const next = {
    ...config,
    browserProduct: browser,
    headless,
    disableExtensions: !loadExtensions,
    stealth,
    bringToFront,
    windowWidth: windowSize === undefined ? (config.windowWidth || null) : (windowSize?.width || null),
    windowHeight: windowSize === undefined ? (config.windowHeight || null) : (windowSize?.height || null),
    connectionMode,
    profileTarget,
    profileDirectory,
    edgeUserDataDir,
    cdpUrl,
    requireDedicatedProfile: external ? false : config.dedicatedRequireProfile !== false,
    clearSessionTabsOnStart: external ? false : Boolean(config.dedicatedClearSessionTabs),
    autoCloseTabs: external ? false : Boolean(config.dedicatedAutoCloseTabs),
    lifecycleDirectory: external
      ? externalLifecycleDirectory(edgeUserDataDir, cwd)
      : path.resolve(edgeUserDataDir),
  };
  const relaunch = launchIdentity(config) !== launchIdentity(next);
  const live = !relaunch && (
    bringToFront !== (config.bringToFront !== false)
    || next.windowWidth !== (config.windowWidth || null)
    || next.windowHeight !== (config.windowHeight || null)
  );

  return { next, relaunch, live };
}

const SAVED_ENV_LOCKS = {
  browserProduct: "BROWSER_PRODUCT",
  headless: "EDGE_HEADLESS",
  disableExtensions: "EDGE_DISABLE_EXTENSIONS",
  stealth: "EDGE_STEALTH",
  connectionMode: "EDGE_CONNECTION_MODE",
  cdpUrl: "EDGE_CDP_URL",
  bringToFront: "EDGE_BRING_TO_FRONT",
};

function envHas(env, key) {
  return env?.[key] != null && String(env[key]).trim() !== "";
}

export function saveRuntimeState(config, cwd = config.workspaceRoot || process.cwd()) {
  const file = runtimeStatePath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    v: 1,
    browserProduct: config.browserProduct || "edge",
    headless: Boolean(config.headless),
    disableExtensions: config.disableExtensions !== false,
    stealth: config.stealth === true,
    connectionMode: config.connectionMode || "managed",
    profileTarget: config.profileTarget || "dedicated",
    profileDirectory: config.profileDirectory || "Default",
    edgeUserDataDir: path.resolve(config.edgeUserDataDir),
    cdpUrl: config.cdpUrl,
    bringToFront: config.bringToFront !== false,
    windowWidth: config.windowWidth || null,
    windowHeight: config.windowHeight || null,
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

export function applySavedRuntime(config, env = process.env, cwd = config.workspaceRoot || process.cwd()) {
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(runtimeStatePath(cwd), "utf8"));
  } catch {
    return config;
  }
  if (saved?.v !== 1) return config;
  const profileLocked = ["EDGE_PROFILE_TARGET", "EDGE_USER_DATA_DIR", "EDGE_CUSTOM_USER_DATA_DIR", "BROWSER_PRODUCT", "EDGE_PROFILE_DIRECTORY"]
    .some((key) => envHas(env, key));
  try {
    const plan = planRuntimeChange(config, {
      action: "apply",
      browser: envHas(env, SAVED_ENV_LOCKS.browserProduct) ? "keep" : saved.browserProduct,
      headless: envHas(env, SAVED_ENV_LOCKS.headless) ? "keep" : saved.headless,
      load_extensions: envHas(env, SAVED_ENV_LOCKS.disableExtensions) ? "keep" : saved.disableExtensions === false,
      stealth: envHas(env, SAVED_ENV_LOCKS.stealth) ? "keep" : saved.stealth === true,
      connection_mode: envHas(env, SAVED_ENV_LOCKS.connectionMode) ? "keep" : saved.connectionMode,
      profile_target: profileLocked ? "keep" : saved.profileTarget,
      profile_directory: profileLocked ? "" : (saved.profileDirectory || ""),
      user_data_dir: profileLocked || saved.profileTarget !== "custom" ? "" : (saved.edgeUserDataDir || ""),
      cdp_url: envHas(env, SAVED_ENV_LOCKS.cdpUrl) ? "" : (saved.cdpUrl || ""),
      confirm_external_profile: true,
      bring_to_front: envHas(env, SAVED_ENV_LOCKS.bringToFront) ? "keep" : saved.bringToFront,
      window: saved.windowWidth && saved.windowHeight ? `${saved.windowWidth}x${saved.windowHeight}` : "keep",
    }, env, cwd);
    return plan.next;
  } catch {
    return config;
  }
}

export async function relaunchManagedBrowser({
  config,
  nextConfig,
  tools,
  logger = () => {},
  isReady = isCdpReady,
  connect = connectEdge,
}) {
  const session = tools.session;
  if (session?.lifecycle && !session.lifecycle.externalProfile) {
    const paths = lifecyclePaths(session.lifecycle.profileDirectory);
    const live = listLiveClientLeases(paths, session.lifecycle.browserKey);
    const others = live.filter((lease) => lease.leaseId !== session.lifecycle.leaseId);
    if (others.length > 0) {
      throw new Error("Another client is using this browser. Change launch settings when this session is the only client.");
    }
  }

  const previousConfig = { ...config };
  const keepOpen = !session?.launched || Boolean(session?.lifecycle?.externalProfile);
  if (session) await session.shutdown({ keepOpen });
  if (nextConfig.connectionMode !== "attach" && keepOpen && await isReady(nextConfig.cdpUrl)) {
    Object.assign(config, previousConfig);
    throw new Error(`A browser is already listening at ${nextConfig.cdpUrl}. Attach to it, or stop it before launching another profile.`);
  }

  try {
    Object.assign(config, nextConfig);
    tools.session = await connect(config, logger);
    return tools;
  } catch (error) {
    Object.assign(config, previousConfig);
    throw error;
  }
}
