import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertNavigableUrl,
  BrowserTools,
  browserToolDefinitions,
  pageNeedsManualVerification,
  parseElementRef,
  resolveUploadPath,
  sanitizeUrlForModel,
} from "../src/browser-tools.mjs";
import { applySavedRuntime, listProfileDirectories, planRuntimeChange, readProfileNames } from "../src/browser-runtime.mjs";
import {
  commandLineMatchesProfile,
  createPageInBackground,
  edgeLaunchArguments,
  EdgeSession,
  findUserDataDirArgument,
  isLoopbackHost,
} from "../src/edge-session.mjs";

function makeContext() {
  const allPages = [];
  let newPageCalls = 0;
  const context = {
    pages: () => allPages,
    async newPage() {
      newPageCalls += 1;
      return context.addPage();
    },
    addPage(options = {}) {
      const page = makePage(context, options);
      allPages.push(page);
      return page;
    },
    get newPageCalls() {
      return newPageCalls;
    },
  };
  return context;
}

function makePage(context, { url = "about:blank" } = {}) {
  let currentUrl = url;
  let closed = false;
  let closeError;
  let closeFailures = 0;
  let click = async () => {};
  const events = new Map();
  const calls = { close: 0, front: 0, goto: [] };
  const page = {
    calls,
    isClosed: () => closed,
    url: () => currentUrl,
    title: async () => currentUrl,
    async goto(nextUrl) {
      calls.goto.push(nextUrl);
      currentUrl = nextUrl;
    },
    async close() {
      if (closed) return;
      if (closeFailures > 0) {
        closeFailures -= 1;
        throw new Error("temporary CDP failure");
      }
      if (closeError) throw closeError;
      calls.close += 1;
      closed = true;
      page.emit("close");
    },
    async bringToFront() {
      calls.front += 1;
    },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    snapshotState: {
      title: "",
      text: "",
      textTruncated: false,
      elements: [],
      viewport: { width: 1, height: 1, scrollY: 0, pageHeight: 1 },
    },
    setSnapshot(next) {
      page.snapshotState = next;
    },
    evaluate: async () => page.snapshotState,
    on(event, handler) {
      if (!events.has(event)) events.set(event, new Set());
      events.get(event).add(handler);
      return page;
    },
    off(event, handler) {
      events.get(event)?.delete(handler);
      return page;
    },
    emit(event, ...args) {
      for (const handler of [...(events.get(event) || [])]) handler(...args);
    },
    emitPopup(popup) {
      page.emit("popup", popup);
    },
    listenerCount(event) {
      return events.get(event)?.size || 0;
    },
    setClick(handler) {
      click = handler;
    },
    setCloseError(error) {
      closeError = error;
    },
    setCloseFailures(count) {
      closeFailures = count;
    },
    locator: () => ({
      count: async () => 1,
      getAttribute: async () => null,
      click: async () => click(),
      fill: async () => {},
      press: async () => {},
      selectOption: async () => {},
    }),
    mouse: { wheel: async () => {} },
  };
  return page;
}

function makeOwnedSession(context, page, options = {}) {
  return new EdgeSession(
    { isConnected: () => true },
    context,
    page,
    null,
    null,
    { autoCloseTabs: true, popupQuietMs: 0, sleep: async () => {}, ...options },
  );
}

const toolConfig = {
  allowedOrigins: new Set(),
  maxTextChars: 1_000,
  sitePolicy: "allow",
  workspaceRoot: os.tmpdir(),
};

test("browser tools have unique strict function schemas", () => {
  const names = browserToolDefinitions.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  for (const tool of browserToolDefinitions) {
    assert.equal(tool.type, "function");
    assert.equal(tool.strict, true);
    assert.equal(tool.parameters.additionalProperties, false);
  }
});

test("navigation allows HTTP(S) and enforces allowed origins", () => {
  assert.equal(
    assertNavigableUrl("https://example.com/path", new Set(["https://example.com"])),
    "https://example.com/path",
  );
  assert.throws(() => assertNavigableUrl("file:///etc/passwd"), /only HTTP\(S\)/);
  assert.throws(() => assertNavigableUrl("javascript:alert(1)"), /only HTTP\(S\)/);
  assert.throws(
    () => assertNavigableUrl("https://other.example", new Set(["https://example.com"])),
    /not in BROWSER_ALLOWED_ORIGINS/,
  );
});

test("model-facing URLs redact common secret query fields", () => {
  const sanitized = sanitizeUrlForModel("https://user:pass@example.com/callback?code=abc&view=full&access_token=secret");
  assert.doesNotMatch(sanitized, /user|pass|abc|secret/);
  assert.match(sanitized, /view=full/);
  assert.match(sanitized, /redacted/);
});

test("CDP loopback detection accepts only local hosts", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("127.evil.example"), false);
  assert.equal(isLoopbackHost("192.168.1.20"), false);
});

test("Edge command lines expose their user data directory", () => {
  assert.equal(
    findUserDataDirArgument(["msedge.exe", "--user-data-dir=C:\\profiles\\mcp"]),
    "C:\\profiles\\mcp",
  );
  assert.equal(findUserDataDirArgument(["msedge.exe", "--user-data-dir", "/tmp/mcp"]), "/tmp/mcp");
  assert.equal(findUserDataDirArgument(["msedge.exe"]), "");
});

test("background launch arguments start Edge in headless mode", () => {
  const argumentsList = edgeLaunchArguments({
    cdpUrl: "http://127.0.0.1:9333",
    edgeUserDataDir: "C:\\profiles\\mcp",
    headless: true,
  });
  assert.ok(argumentsList.includes("--headless=new"));
  assert.ok(argumentsList.includes("--enable-automation"));
  assert.ok(argumentsList.includes("--disable-extensions"));
  assert.equal(argumentsList.at(-1), "about:blank");
});

test("profile matching does not require the automation flag", () => {
  const match = commandLineMatchesProfile(
    ["--user-data-dir=C:\\profiles\\mcp", "--profile-directory=Default"],
    { edgeUserDataDir: "C:\\profiles\\mcp", profileDirectory: "Default" },
  );
  assert.equal(match.ok, true);
});

test("experimental stealth and extension loading change only their launch flags", () => {
  const argumentsList = edgeLaunchArguments({
    cdpUrl: "http://127.0.0.1:9333",
    edgeUserDataDir: "C:\\profiles\\mcp",
    headless: false,
    stealth: true,
    disableExtensions: false,
    profileTarget: "user",
  });
  assert.equal(argumentsList.includes("--enable-automation"), false);
  assert.equal(argumentsList.includes("--disable-extensions"), false);
  assert.equal(argumentsList.includes("--disable-sync"), false);
  assert.ok(argumentsList.includes("--user-data-dir=C:\\profiles\\mcp"));
});

test("verification pages pause later automated actions", async () => {
  const context = makeContext();
  const page = context.addPage({ url: "https://example.com/challenge" });
  page.setSnapshot({
    title: "Just a moment...",
    text: "Verify you are human",
    textTruncated: false,
    elements: [],
    viewport: { width: 1, height: 1, scrollY: 0, pageHeight: 1 },
  });
  const tools = new BrowserTools(makeOwnedSession(context, page), toolConfig);
  const state = await tools.snapshot();
  assert.equal(state.needsUser, true);
  await assert.rejects(
    () => tools.execute("browser_click", { ref: "e1" }),
    /paused/,
  );
  page.setSnapshot({
    title: "Example",
    text: "ready",
    textTruncated: false,
    elements: [],
    viewport: { width: 1, height: 1, scrollY: 0, pageHeight: 1 },
  });
  const resumed = await tools.execute("browser_handoff", { action: "resume" });
  assert.equal(resumed.needsUser, false);
});

test("manual verification detection stays specific", () => {
  assert.equal(pageNeedsManualVerification("https://example.com", "Example", "hello"), "");
  assert.equal(pageNeedsManualVerification("https://challenges.cloudflare.com/cdn-cgi/challenge", "", ""), "verification");
  assert.equal(pageNeedsManualVerification("https://example.com/login", "Sign in", "", [{ type: "password" }]), "sign-in");
  assert.equal(pageNeedsManualVerification("https://example.com", "Checkout", "complete the captcha"), "verification");
});

test("Chrome runtime selection uses the Chrome profile and requires confirmation", () => {
  const config = {
    browserProduct: "edge",
    dedicatedProfiles: {
      edge: "C:\\workspace\\.mcp-edge-profile",
      chrome: "C:\\workspace\\.mcp-chrome-profile",
    },
    dedicatedUserDataDir: "C:\\workspace\\.mcp-edge-profile",
    dedicatedRequireProfile: true,
    dedicatedClearSessionTabs: true,
    dedicatedAutoCloseTabs: true,
    edgeUserDataDir: "C:\\workspace\\.mcp-edge-profile",
    profileDirectory: "Default",
    profileTarget: "dedicated",
    connectionMode: "managed",
    cdpUrl: "http://127.0.0.1:9333",
    headless: false,
    disableExtensions: true,
    stealth: false,
    allowRemoteCdp: false,
    workspaceRoot: "C:\\workspace",
  };
  assert.throws(
    () => planRuntimeChange(config, {
      action: "apply",
      browser: "chrome",
      headless: false,
      load_extensions: true,
      stealth: false,
      connection_mode: "managed",
      profile_target: "user",
      profile_directory: "Profile 1",
      user_data_dir: "",
      cdp_url: "",
      confirm_external_profile: false,
    }, { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }),
    /confirm_external_profile/,
  );
});

test("runtime apply changes browser, headless mode, extensions, and stealth", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-runtime-"));
  fs.mkdirSync(path.join(root, "Google", "Chrome", "User Data", "Profile 2"), { recursive: true });
  const config = {
    browserProduct: "edge",
    dedicatedProfiles: {
      edge: path.join(root, "edge"),
      chrome: path.join(root, "chrome"),
    },
    dedicatedUserDataDir: path.join(root, "edge"),
    dedicatedRequireProfile: true,
    dedicatedClearSessionTabs: false,
    dedicatedAutoCloseTabs: false,
    edgeUserDataDir: path.join(root, "edge"),
    profileDirectory: "Default",
    profileTarget: "dedicated",
    connectionMode: "managed",
    cdpUrl: "http://127.0.0.1:9333",
    headless: false,
    disableExtensions: true,
    stealth: false,
    allowRemoteCdp: false,
    workspaceRoot: root,
  };
  let relaunched = false;
  const tools = new BrowserTools({}, config, {
    env: { LOCALAPPDATA: root },
    relaunch: async (next, current) => {
      relaunched = true;
      Object.assign(current.config, next);
    },
  });
  const result = await tools.execute("browser_runtime", {
    action: "apply",
    browser: "chrome",
    headless: true,
    load_extensions: true,
    stealth: true,
    connection_mode: "managed",
    profile_target: "dedicated",
    profile_directory: "",
    user_data_dir: "",
    cdp_url: "",
    confirm_external_profile: false,
  });
  assert.equal(relaunched, true);
  assert.equal(result.relaunched, true);
  assert.equal(result.browser, "chrome");
  assert.equal(result.headless, true);
  assert.equal(result.loadExtensions, true);
  assert.equal(result.stealth, true);
  assert.equal(result.userDataDir, path.resolve(root, "chrome"));
  assert.deepEqual(
    listProfileDirectories(path.join(root, "Google", "Chrome", "User Data")),
    ["Profile 2"],
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("runtime apply can change only the requested field", () => {
  const config = {
    browserProduct: "edge",
    dedicatedProfiles: { edge: "C:\\profiles\\edge", chrome: "C:\\profiles\\chrome" },
    dedicatedUserDataDir: "C:\\profiles\\edge",
    dedicatedRequireProfile: true,
    dedicatedClearSessionTabs: false,
    dedicatedAutoCloseTabs: false,
    edgeUserDataDir: "C:\\profiles\\edge",
    profileDirectory: "Default",
    profileTarget: "dedicated",
    connectionMode: "managed",
    cdpUrl: "http://127.0.0.1:9333",
    headless: false,
    disableExtensions: true,
    stealth: false,
    bringToFront: true,
    allowRemoteCdp: false,
    workspaceRoot: "C:\\profiles",
  };
  const plan = planRuntimeChange(config, {
    action: "apply",
    browser: "keep",
    headless: "true",
    load_extensions: "keep",
    stealth: "keep",
    bring_to_front: "keep",
    window: "390x844",
    connection_mode: "keep",
    profile_target: "keep",
    profile_directory: "",
    user_data_dir: "",
    cdp_url: "",
    confirm_external_profile: "keep",
  });
  assert.equal(plan.relaunch, true);
  assert.equal(plan.next.browserProduct, "edge");
  assert.equal(plan.next.headless, true);
  assert.equal(plan.next.disableExtensions, true);
  assert.equal(plan.next.windowWidth, 390);
  assert.equal(plan.next.windowHeight, 844);
});

test("profile names omit email addresses from Local State", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-names-"));
  const userData = path.join(root, "User Data");
  fs.mkdirSync(path.join(userData, "Profile 1"), { recursive: true });
  fs.writeFileSync(path.join(userData, "Local State"), JSON.stringify({
    profile: {
      info_cache: {
        "Profile 1": { name: "Work", user_name: "person@example.com" },
      },
    },
  }));
  assert.deepEqual(readProfileNames(userData), [{ directory: "Profile 1", name: "Work" }]);
  fs.writeFileSync(path.join(userData, "Local State"), JSON.stringify({
    profile: { info_cache: { "Profile 1": { name: "person@example.com" } } },
  }));
  assert.deepEqual(readProfileNames(userData), [{ directory: "Profile 1" }]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("saved runtime applies unless the process environment locks the field", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "saved-runtime-"));
  const edgeProfile = path.join(root, "edge");
  fs.mkdirSync(edgeProfile, { recursive: true });
  const config = {
    browserProduct: "edge",
    dedicatedProfiles: { edge: edgeProfile, chrome: path.join(root, "chrome") },
    dedicatedUserDataDir: edgeProfile,
    dedicatedRequireProfile: true,
    dedicatedClearSessionTabs: false,
    dedicatedAutoCloseTabs: false,
    edgeUserDataDir: edgeProfile,
    profileDirectory: "Default",
    profileTarget: "dedicated",
    connectionMode: "managed",
    cdpUrl: "http://127.0.0.1:9333",
    headless: false,
    disableExtensions: true,
    stealth: false,
    bringToFront: true,
    allowRemoteCdp: false,
    workspaceRoot: root,
  };
  fs.mkdirSync(path.join(root, ".runtime"), { recursive: true });
  fs.writeFileSync(path.join(root, ".runtime", "browser.json"), JSON.stringify({
    v: 1,
    browserProduct: "edge",
    headless: true,
    disableExtensions: true,
    stealth: false,
    connectionMode: "managed",
    profileTarget: "dedicated",
    profileDirectory: "Default",
    edgeUserDataDir: edgeProfile,
    cdpUrl: "http://127.0.0.1:9333",
    bringToFront: false,
  }));
  assert.equal(applySavedRuntime(config, {}, root).headless, true);
  assert.equal(applySavedRuntime(config, { EDGE_HEADLESS: "false" }, root).headless, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("upload paths must be existing files and frame refs stay explicit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "upload-path-"));
  const file = path.join(root, "note.txt");
  fs.writeFileSync(file, "hello");
  assert.equal(resolveUploadPath("note.txt", root), file);
  assert.throws(() => resolveUploadPath("missing.txt", root), /does not exist/);
  assert.deepEqual(parseElementRef("e3"), { frameIndex: 0, localRef: "e3" });
  assert.deepEqual(parseElementRef("f2e4"), { frameIndex: 1, localRef: "e4" });
  assert.equal(parseElementRef("bad"), null);
  fs.rmSync(root, { recursive: true, force: true });
});

function makeBackgroundPageHarness({ sessionError, createError, gotoError, emitPage = true } = {}) {
  const commands = [];
  const listeners = new Set();
  const pages = [];
  let currentUrl = "";
  const page = {
    url: () => currentUrl,
    async goto(url) {
      if (gotoError) throw gotoError;
      currentUrl = url;
    },
  };
  const context = {
    on(event, handler) {
      assert.equal(event, "page");
      listeners.add(handler);
    },
    off(event, handler) {
      assert.equal(event, "page");
      listeners.delete(handler);
    },
    pages: () => pages,
  };
  const browser = {
    async newBrowserCDPSession() {
      if (sessionError) throw sessionError;
      return {
        async send(command, parameters) {
          commands.push({ command, parameters });
          if (command === "Target.createTarget") {
            if (createError) throw createError;
            currentUrl = parameters.url;
            pages.push(page);
            if (emitPage) {
              for (const handler of [...listeners]) handler(page);
            }
            return { targetId: "target-1" };
          }
          return {};
        },
        async detach() {},
      };
    },
  };
  return { browser, commands, context, listeners, page };
}

test("background pages are created through CDP without activating the target", async () => {
  const harness = makeBackgroundPageHarness();

  assert.equal(await createPageInBackground(harness.browser, harness.context), harness.page);
  assert.equal(harness.commands[0].command, "Target.createTarget");
  assert.equal(harness.commands[0].parameters.background, true);
  assert.match(harness.commands[0].parameters.url, /^about:blank#responses-edge-/);
  assert.equal(harness.page.url(), "about:blank");
  assert.equal(harness.listeners.size, 0);
});

test("background page creation cancels its listener when CDP setup fails", async () => {
  const sessionFailure = makeBackgroundPageHarness({ sessionError: new Error("no CDP session") });
  await assert.rejects(
    createPageInBackground(sessionFailure.browser, sessionFailure.context),
    /no CDP session/,
  );
  assert.equal(sessionFailure.listeners.size, 0);

  const createFailure = makeBackgroundPageHarness({ createError: new Error("create failed") });
  await assert.rejects(
    createPageInBackground(createFailure.browser, createFailure.context),
    /create failed/,
  );
  assert.equal(createFailure.listeners.size, 0);
});

test("background page creation closes a target that never exposes a page", async () => {
  const harness = makeBackgroundPageHarness({ emitPage: false });

  await assert.rejects(
    createPageInBackground(harness.browser, harness.context, { timeoutMs: 5 }),
    /did not expose the background tab/,
  );

  assert.ok(harness.commands.some(({ command, parameters }) => (
    command === "Target.closeTarget" && parameters.targetId === "target-1"
  )));
  assert.equal(harness.listeners.size, 0);
});

test("background page creation closes its target when page initialization fails", async () => {
  const harness = makeBackgroundPageHarness({ gotoError: new Error("goto failed") });

  await assert.rejects(
    createPageInBackground(harness.browser, harness.context),
    /goto failed/,
  );

  assert.ok(harness.commands.some(({ command, parameters }) => (
    command === "Target.closeTarget" && parameters.targetId === "target-1"
  )));
  assert.equal(harness.listeners.size, 0);
});

test("shutdown closes the Edge process through CDP", async () => {
  let connected = true;
  let fallbackCloses = 0;
  const commands = [];
  const browser = {
    isConnected: () => connected,
    async newBrowserCDPSession() {
      return {
        async send(command) {
          commands.push(command);
        },
      };
    },
    async close() {
      fallbackCloses += 1;
      connected = false;
    },
  };
  const session = new EdgeSession(browser, null, null, null);

  await session.shutdown({ keepOpen: false });

  assert.deepEqual(commands, ["Browser.close"]);
  assert.equal(fallbackCloses, 1);
});

test("new tab reconnects after every Edge window is closed", async () => {
  const staleBrowser = { isConnected: () => false };
  const staleContext = {
    pages: () => [],
    async newPage() {
      throw new Error("Target page, context or browser has been closed");
    },
  };
  const stalePage = { isClosed: () => true };
  const replacementPage = {
    isClosed: () => false,
    async bringToFront() {},
  };
  const replacementBrowser = { isConnected: () => true };
  const replacementContext = { pages: () => [replacementPage] };
  const replacement = new EdgeSession(
    replacementBrowser,
    replacementContext,
    replacementPage,
    null,
  );
  let reconnects = 0;
  const session = new EdgeSession(staleBrowser, staleContext, stalePage, null, async () => {
    reconnects += 1;
    return replacement;
  });

  const page = await session.newTab();

  assert.equal(page, replacementPage);
  assert.equal(session.browser, replacementBrowser);
  assert.equal(session.context, replacementContext);
  assert.equal(reconnects, 1);
});

test("navigation reuses the session-owned primary tab", async () => {
  const context = makeContext();
  const foreignPage = context.addPage({ url: "https://foreign.example/" });
  const primaryPage = context.addPage();
  const session = makeOwnedSession(context, primaryPage);
  const tools = new BrowserTools(session, toolConfig);

  await tools.navigate({ url: "https://example.com/one" });
  await tools.navigate({ url: "https://example.com/two" });

  assert.deepEqual(primaryPage.calls.goto, ["https://example.com/one", "https://example.com/two"]);
  assert.equal(context.newPageCalls, 0);
  assert.equal(foreignPage.calls.close, 0);
  assert.equal((await session.listTabs()).length, 1);
});

test("background mode never brings navigation, explicit tabs, or popups to the foreground", async () => {
  const context = makeContext();
  const primaryPage = context.addPage({ url: "https://example.com/" });
  const session = makeOwnedSession(context, primaryPage, { bringToFront: false });
  const tools = new BrowserTools(session, toolConfig);

  await tools.navigate({ url: "https://example.com/next" });
  const explicitPage = await session.newTab();
  const popup = context.addPage({ url: "https://example.com/popup" });
  explicitPage.setClick(async () => explicitPage.emitPopup(popup));
  await tools.click({ ref: "e1" });
  const ownedTabs = await session.listTabs();
  const primaryTab = ownedTabs.find((tab) => tab.url === "https://example.com/next");
  const explicitTab = ownedTabs.find((tab) => tab.url === "about:blank");
  await session.switchTab(primaryTab.id);
  await session.closeTab(explicitTab.id);
  await session.closeOwnedTabs();
  const replacementPage = await session.ensureReady();

  assert.equal(primaryPage.calls.front, 0);
  assert.equal(explicitPage.calls.front, 0);
  assert.equal(popup.calls.front, 0);
  assert.equal(replacementPage.calls.front, 0);
});

test("closing the last background tab creates a replacement without foreground activation", async () => {
  const context = makeContext();
  const primaryPage = context.addPage();
  const session = makeOwnedSession(context, primaryPage, { bringToFront: false });
  const [{ id }] = await session.listTabs();

  await session.closeTab(id);

  assert.equal(primaryPage.calls.front, 0);
  assert.equal(session.page().calls.front, 0);
});

test("foreground mode remains available when explicitly enabled", async () => {
  const context = makeContext();
  const primaryPage = context.addPage();
  const session = makeOwnedSession(context, primaryPage, { bringToFront: true });
  const tools = new BrowserTools(session, toolConfig);

  await tools.navigate({ url: "https://example.com/foreground" });

  assert.equal(primaryPage.calls.front, 1);
});

test("popup cleanup keeps the primary tab and only the newest implicit popup", async () => {
  const context = makeContext();
  const primaryPage = context.addPage({ url: "https://example.com/" });
  const session = makeOwnedSession(context, primaryPage);
  const tools = new BrowserTools(session, toolConfig);
  const firstPopup = context.addPage({ url: "https://example.com/first" });
  primaryPage.setClick(async () => primaryPage.emitPopup(firstPopup));

  await tools.click({ ref: "e1" });
  assert.equal(session.page(), firstPopup);

  const secondPopup = context.addPage({ url: "https://example.com/second" });
  firstPopup.setClick(async () => firstPopup.emitPopup(secondPopup));
  await tools.click({ ref: "e1" });

  assert.equal(firstPopup.calls.close, 1);
  assert.equal(primaryPage.calls.close, 0);
  assert.equal(secondPopup.calls.close, 0);
  assert.equal(session.page(), secondPopup);
  assert.deepEqual((await session.listTabs()).map((tab) => tab.url), [
    "https://example.com/",
    "https://example.com/second",
  ]);
});

test("one action opening multiple popups keeps only the latest one", async () => {
  const context = makeContext();
  const primaryPage = context.addPage({ url: "https://example.com/" });
  const session = makeOwnedSession(context, primaryPage);
  const tools = new BrowserTools(session, toolConfig);
  const firstPopup = context.addPage({ url: "https://example.com/a" });
  const secondPopup = context.addPage({ url: "https://example.com/b" });
  primaryPage.setClick(async () => {
    primaryPage.emitPopup(firstPopup);
    primaryPage.emitPopup(secondPopup);
  });

  await tools.click({ ref: "e1" });

  assert.equal(firstPopup.calls.close, 1);
  assert.equal(secondPopup.calls.close, 0);
  assert.equal(session.page(), secondPopup);
});

test("explicit tabs survive implicit popup cleanup", async () => {
  const context = makeContext();
  const primaryPage = context.addPage({ url: "https://example.com/" });
  const session = makeOwnedSession(context, primaryPage);
  const explicitPage = await session.newTab();
  const firstPopup = context.addPage({ url: "https://example.com/first" });
  explicitPage.emitPopup(firstPopup);
  await session.settlePopups();
  const secondPopup = context.addPage({ url: "https://example.com/second" });
  firstPopup.emitPopup(secondPopup);
  await session.settlePopups();

  assert.equal(firstPopup.calls.close, 1);
  assert.equal(primaryPage.calls.close, 0);
  assert.equal(explicitPage.calls.close, 0);
  assert.equal(secondPopup.calls.close, 0);
  assert.equal((await session.listTabs()).length, 3);
});

test("foreign pages are never adopted or closed by another session", async () => {
  const context = makeContext();
  const primaryPage = context.addPage({ url: "https://example.com/" });
  const session = makeOwnedSession(context, primaryPage);
  const tools = new BrowserTools(session, toolConfig);
  let foreignPage;
  primaryPage.setClick(async () => {
    foreignPage = context.addPage({ url: "https://foreign.example/" });
  });

  await tools.click({ ref: "e1" });

  assert.equal(foreignPage.calls.close, 0);
  assert.equal((await session.listTabs()).length, 1);
  assert.equal(session.page(), primaryPage);
});

test("idle cleanup closes owned tabs and detaches popup listeners", async () => {
  const context = makeContext();
  const primaryPage = context.addPage();
  const session = makeOwnedSession(context, primaryPage);
  const explicitPage = await session.newTab();

  const closed = await session.closeOwnedTabs();

  assert.equal(closed, 2);
  assert.equal(primaryPage.calls.close, 1);
  assert.equal(explicitPage.calls.close, 1);
  assert.equal(primaryPage.listenerCount("popup"), 0);
  assert.equal(explicitPage.listenerCount("popup"), 0);
});

test("a failed tab close remains owned so cleanup can retry", async () => {
  const context = makeContext();
  const primaryPage = context.addPage();
  const session = makeOwnedSession(context, primaryPage);
  primaryPage.setCloseError(new Error("temporary CDP failure"));

  assert.equal(await session.closeOwnedTabs(), 0);
  assert.equal((await session.listTabs()).length, 1);
  assert.equal(primaryPage.listenerCount("popup"), 1);

  primaryPage.setCloseError(null);
  assert.equal(await session.closeOwnedTabs(), 1);
  assert.equal(primaryPage.listenerCount("popup"), 0);
});

test("bounded close retries recover a transient shutdown failure", async () => {
  const context = makeContext();
  const primaryPage = context.addPage();
  const session = makeOwnedSession(context, primaryPage);
  primaryPage.setCloseFailures(1);

  assert.equal(await session.closeOwnedTabs({ attempts: 2, retryDelayMs: 0 }), 1);
  assert.equal(primaryPage.calls.close, 1);
  assert.equal(primaryPage.listenerCount("popup"), 0);
});
