import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { createInspectionLog } from "./inspection.mjs";
import {
  browserKeyFromWebSocketUrl,
  clearLifecycleState,
  createLeaseId,
  listLiveClientLeases,
  readManagedOwner,
  removeClientLease,
  removeManagedOwner,
  withEdgeLifecycleLock,
  writeClientLease,
  writeManagedOwner,
} from "./edge-lifecycle.mjs";

export function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const octets = host.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

function firstExisting(candidates) {
  return candidates.filter(Boolean).find((candidate) => fs.existsSync(candidate)) || "";
}

export function findEdgeExecutable(configuredPath = "", env = process.env) {
  return firstExisting([
    configuredPath,
    env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    env.ProgramFiles && path.join(env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
  ]);
}

export function findChromeExecutable(configuredPath = "", env = process.env) {
  return firstExisting([
    configuredPath,
    env.ProgramFiles && path.join(env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    process.platform === "darwin" && "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    process.platform !== "win32" && "/usr/bin/google-chrome",
    process.platform !== "win32" && "/usr/bin/google-chrome-stable",
  ]);
}

export function browserLabel(config) {
  return config?.browserProduct === "chrome" ? "Chrome" : "Edge";
}

export function findBrowserExecutable(config, env = process.env) {
  if (config.browserProduct === "chrome") return findChromeExecutable(config.chromeExecutable, env);
  return findEdgeExecutable(config.edgeExecutable, env);
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function getCdpMetadata(cdpUrl, timeoutMs = 1_000) {
  try {
    const endpoint = new URL("/json/version", cdpUrl);
    const response = await fetchWithTimeout(endpoint, timeoutMs);
    if (!response.ok) return null;
    const metadata = await response.json();
    if (!metadata.webSocketDebuggerUrl) return null;
    return metadata;
  } catch {
    return null;
  }
}

export async function isCdpReady(cdpUrl, timeoutMs = 1_000) {
  return Boolean(await getCdpMetadata(cdpUrl, timeoutMs));
}

async function waitForCdp(cdpUrl, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const metadata = await getCdpMetadata(cdpUrl);
    if (metadata) return metadata;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Edge did not expose CDP at ${cdpUrl} within ${timeoutMs}ms.`);
}

function normalizeProfilePath(profilePath) {
  const normalized = path.normalize(path.resolve(String(profilePath).replace(/^"|"$/g, ""))).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function findCommandLineValue(commandLine = [], name) {
  const prefix = `${name}=`;
  for (let index = 0; index < commandLine.length; index += 1) {
    const argument = String(commandLine[index]);
    if (argument === name) return commandLine[index + 1] || "";
    if (argument.startsWith(prefix)) return argument.slice(prefix.length);
  }
  return "";
}

export function findUserDataDirArgument(commandLine = []) {
  return findCommandLineValue(commandLine, "--user-data-dir");
}

export function commandLineMatchesProfile(commandLine = [], config) {
  const actualProfile = findUserDataDirArgument(commandLine);
  if (!actualProfile) return { ok: false, reason: "The listening browser did not advertise --user-data-dir." };
  if (normalizeProfilePath(actualProfile) !== normalizeProfilePath(config.edgeUserDataDir)) {
    return {
      ok: false,
      reason: `expected profile ${config.edgeUserDataDir}, but the listening browser uses ${actualProfile}.`,
    };
  }
  const actualDirectory = findCommandLineValue(commandLine, "--profile-directory");
  const expectedDirectory = config.profileDirectory || "Default";
  if (actualDirectory && actualDirectory !== expectedDirectory) {
    return {
      ok: false,
      reason: `expected profile directory ${expectedDirectory}, but the listening browser uses ${actualDirectory}.`,
    };
  }
  return { ok: true };
}

function profileCheckRequired(config) {
  return Boolean(
    config.requireDedicatedProfile
    || config.connectionMode === "attach"
    || config.profileTarget === "user"
    || config.profileTarget === "custom",
  );
}

async function assertExpectedProfile(browser, config) {
  if (!profileCheckRequired(config)) return;

  let cdpSession;
  let commandLine;
  try {
    cdpSession = await browser.newBrowserCDPSession();
    const response = await cdpSession.send("Browser.getBrowserCommandLine");
    commandLine = response.arguments;
  } catch (error) {
    throw new Error(`Refusing to use Edge at ${config.cdpUrl}: its profile could not be verified (${error.message}).`);
  } finally {
    await cdpSession?.detach().catch(() => {});
  }

  // Identity is the user-data directory and profile directory. --enable-automation is not part of this check.
  const match = commandLineMatchesProfile(commandLine, config);
  if (!match.ok) {
    throw new Error(`Refusing to use Edge at ${config.cdpUrl}: ${match.reason}`);
  }
}

function assertContainedPath(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to clear an unsafe Edge session path: ${target}`);
  }
}

export function clearSavedTabSessions(profileDirectory) {
  const profile = path.resolve(profileDirectory);
  if (profile === path.parse(profile).root) {
    throw new Error(`Refusing to clear Edge session tabs from a filesystem root: ${profile}`);
  }
  const defaultProfile = path.join(profile, "Default");
  const targets = [
    path.join(defaultProfile, "Sessions"),
    path.join(defaultProfile, "Last Session"),
    path.join(defaultProfile, "Last Tabs"),
    path.join(defaultProfile, "Current Session"),
    path.join(defaultProfile, "Current Tabs"),
  ];
  for (const target of targets) {
    assertContainedPath(defaultProfile, target);
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function usesExternalProfile(config) {
  return config.profileTarget === "user" || config.profileTarget === "custom";
}

export function edgeLaunchArguments(config) {
  const cdpUrl = new URL(config.cdpUrl);
  const port = cdpUrl.port || (cdpUrl.protocol === "https:" ? "443" : "80");
  const external = usesExternalProfile(config);
  return [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${config.edgeUserDataDir}`,
      `--profile-directory=${config.profileDirectory || "Default"}`,
      ...(config.stealth === true ? [] : ["--enable-automation"]),
      ...(config.disableExtensions === false ? [] : ["--disable-extensions"]),
      ...(external ? [] : ["--disable-sync", "--disable-default-apps"]),
      "--disable-session-crashed-bubble",
      ...(config.headless ? ["--headless=new"] : []),
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
  ];
}

const BLANK_PAGE_URLS = new Set(["about:blank", "edge://newtab/", "chrome://newtab/"]);

export function launchEdge(config) {
  const executable = findBrowserExecutable(config);
  const label = browserLabel(config);
  if (!executable) {
    const setting = label === "Chrome" ? "BROWSER_CHROME_EXECUTABLE" : "EDGE_EXECUTABLE";
    throw new Error(`${label} was not found. Set ${setting}.`);
  }

  if (usesExternalProfile(config)) {
    if (!fs.existsSync(config.edgeUserDataDir)) {
      throw new Error(`Browser profile directory does not exist: ${config.edgeUserDataDir}`);
    }
  } else {
    fs.mkdirSync(config.edgeUserDataDir, { recursive: true });
  }

  const child = spawn(
    executable,
    edgeLaunchArguments(config),
    { detached: true, stdio: "ignore", windowsHide: Boolean(config.headless) },
  );
  child.unref();
  return { executable, pid: child.pid };
}

async function waitForPagesToSettle(context, quietMs = 200, maxMs = 2_000) {
  if (!context?.on || quietMs <= 0) return;
  const startedAt = Date.now();
  let lastPageAt = startedAt;
  const onPage = () => {
    lastPageAt = Date.now();
  };
  context.on("page", onPage);
  try {
    while (Date.now() - startedAt < maxMs && Date.now() - lastPageAt < quietMs) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, quietMs)));
    }
  } finally {
    context.off("page", onPage);
  }
}

async function closeBrowserThroughCdp(browser) {
  if (!browser?.isConnected?.()) return;
  const cdpSession = await browser.newBrowserCDPSession();
  await cdpSession.send("Browser.close");
}

export async function createPageInBackground(browser, context, { timeoutMs = 10_000 } = {}) {
  const markerUrl = `about:blank#responses-edge-${randomUUID()}`;
  const cdpSession = await browser.newBrowserCDPSession();
  let targetId;
  let timer;
  let onPage;
  let cancelPageWait = () => {};
  try {
    const pageResultPromise = new Promise((resolve, reject) => {
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (onPage) context.off("page", onPage);
      };
      cancelPageWait = cleanup;
      onPage = (page) => {
        if (page.url() !== markerUrl) return;
        cleanup();
        resolve(page);
      };
      context.on("page", onPage);
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Edge did not expose the background tab within ${timeoutMs}ms.`));
      }, timeoutMs);
      const existingPage = context.pages().find((page) => page.url() === markerUrl);
      if (existingPage) onPage(existingPage);
    }).then((page) => ({ page }), (error) => ({ error }));
    const created = await cdpSession.send("Target.createTarget", {
      url: markerUrl,
      background: true,
    });
    targetId = created.targetId;
    const pageResult = await pageResultPromise;
    if (pageResult.error) throw pageResult.error;
    const { page } = pageResult;
    await page.goto("about:blank", { waitUntil: "commit", timeout: timeoutMs });
    return page;
  } catch (error) {
    cancelPageWait();
    if (targetId) {
      await cdpSession.send("Target.closeTarget", { targetId }).catch(() => {});
    }
    throw error;
  } finally {
    cancelPageWait();
    await cdpSession.detach().catch(() => {});
  }
}

async function cleanupFailedLaunch({
  browser,
  browserKey,
  launched,
  config,
  profileVerified,
  logger,
}) {
  let closed = false;
  if (profileVerified && browser?.isConnected?.()) {
    try {
      await closeBrowserThroughCdp(browser);
      closed = true;
    } catch {
      // Retry through a fresh CDP connection below.
    }
  }

  if (!closed && browserKey) {
    const currentMetadata = await getCdpMetadata(config.cdpUrl);
    const currentBrowserKey = browserKeyFromWebSocketUrl(currentMetadata?.webSocketDebuggerUrl);
    if (currentBrowserKey === browserKey) {
      let cleanupBrowser;
      try {
        cleanupBrowser = await chromium.connectOverCDP(config.cdpUrl, { timeout: 5_000 });
        await assertExpectedProfile(cleanupBrowser, config);
        await closeBrowserThroughCdp(cleanupBrowser);
        closed = true;
      } catch {
        // Fall back to the exact process launched by this call.
      } finally {
        if (cleanupBrowser?.isConnected?.()) await cleanupBrowser.close().catch(() => {});
      }
    }
  }

  if (!closed && launched?.pid) {
    try {
      process.kill(launched.pid, "SIGTERM");
    } catch {
      // The launcher may already have exited or handed off to the browser process.
    }
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline && await isCdpReady(config.cdpUrl, 250)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!(await isCdpReady(config.cdpUrl, 250))) {
      logger("The failed Edge launcher is no longer exposing CDP; ownership will be reconciled on the next connection");
    }
  }

  if (browser?.isConnected?.()) await browser.close().catch(() => {});
  if (!closed) logger("Could not confirm Browser.close after a failed launch; leaving lifecycle recovery to the next dedicated-profile connection");
  return closed;
}

export class EdgeSession {
  #tabIds = new WeakMap();
  #nextTabId = 1;
  #ownedPages = new Map();
  #pageHandlers = new Map();
  #popupQueue = [];
  #popupTimer;
  #popupSettlement;
  #implicitPage;
  #reconnectFactory;
  #reconnectPromise;
  #sleep;
  #shuttingDown = false;
  #nextDialog = null;

  constructor(browser, context, page, launched, reconnectFactory, options = {}) {
    this.browser = browser;
    this.context = context;
    this.currentPage = page;
    this.launched = launched;
    this.lifecycle = options.lifecycle || null;
    this.autoCloseTabs = Boolean(options.autoCloseTabs);
    this.bringToFront = options.bringToFront !== false;
    this.backgroundPages = Boolean(options.backgroundPages);
    this.popupQuietMs = Number.isFinite(options.popupQuietMs) ? options.popupQuietMs : 200;
    this.logger = options.logger || (() => {});
    this.#sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#reconnectFactory = reconnectFactory;
    this.#nextDialog = null;
    this.lastDialog = null;
    this.downloads = [];
    this.artifactsDir = options.artifactsDir || "";
    this.inspection = createInspectionLog();
    if (page) this.#trackOwnedPage(page, "primary");
  }

  armDialog(choice) {
    this.#nextDialog = choice;
  }

  dialogStatus() {
    return this.#nextDialog;
  }

  consumeDownloads() {
    const downloads = this.downloads;
    this.downloads = [];
    return downloads;
  }

  async applyWindow(width, height) {
    if (!width || !height) return false;
    const page = this.page?.();
    if (!page?.setViewportSize) return false;
    await page.setViewportSize({ width, height }).catch(() => {});
    if (!this.browser?.newBrowserCDPSession) return true;
    let cdp;
    try {
      cdp = await this.browser.newBrowserCDPSession();
      const target = await cdp.send("Browser.getWindowForTarget");
      await cdp.send("Browser.setWindowBounds", {
        windowId: target.windowId,
        bounds: { width, height, windowState: "normal" },
      });
      return true;
    } catch {
      return true;
    } finally {
      await cdp?.detach?.().catch(() => {});
    }
  }

  async #saveDownload(download) {
    try {
      const rawName = String(download.suggestedFilename?.() || "download");
      const safe = rawName.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 80) || "download";
      const directory = this.artifactsDir || path.join(process.cwd(), "artifacts");
      fs.mkdirSync(directory, { recursive: true });
      const filename = path.join(directory, `${Date.now()}-${safe}`);
      await download.saveAs(filename);
      this.downloads.push({ name: safe, artifact: path.relative(process.cwd(), filename) });
    } catch (error) {
      this.logger(`Download failed: ${error.message}`);
    }
  }

  #schedulePopupSettlement() {
    if (this.#popupTimer) clearTimeout(this.#popupTimer);
    this.#popupTimer = setTimeout(() => {
      this.#popupTimer = undefined;
      void this.settlePopups({ waitForQuiet: false }).catch((error) => {
        this.logger(`Popup cleanup failed: ${error.message}`);
      });
    }, Math.max(0, this.popupQuietMs));
    this.#popupTimer.unref?.();
  }

  async #createOwnedPage(kind) {
    const page = this.backgroundPages
      ? await createPageInBackground(this.browser, this.context)
      : await this.context.newPage();
    this.#trackOwnedPage(page, kind);
    return page;
  }

  #trackOwnedPage(page, kind) {
    if (!page || page.isClosed?.()) return page;
    const existingKind = this.#ownedPages.get(page);
    if (existingKind) {
      if (kind === "explicit") this.#ownedPages.set(page, "explicit");
      return page;
    }

    this.#ownedPages.set(page, kind);
    const onPopup = (popup) => {
      if (this.#shuttingDown) return;
      this.#trackOwnedPage(popup, "implicit");
      this.#popupQueue.push(popup);
      this.#schedulePopupSettlement();
    };
    const onClose = () => {
      this.#untrackOwnedPage(page);
    };
    const onDialog = (dialog) => {
      const armed = this.#nextDialog;
      this.#nextDialog = null;
      const decision = armed?.decision === "accept" ? "accept" : "dismiss";
      this.lastDialog = {
        type: String(dialog.type?.() || "alert"),
        message: String(dialog.message?.() || "").replace(/\s+/g, " ").trim().slice(0, 300),
        decision,
        armed: Boolean(armed),
      };
      const response = decision === "accept"
        ? dialog.accept?.(armed?.promptText || "")
        : dialog.dismiss?.();
      Promise.resolve(response).catch(() => {});
    };
    const onDownload = (download) => {
      void this.#saveDownload(download);
    };
    const onConsole = (message) => this.inspection.console(message);
    const onPageError = (error) => this.inspection.pageError(error);
    const onRequest = (request) => this.inspection.request(request);
    const onResponse = (response) => this.inspection.response(response);
    const onRequestFailed = (request) => this.inspection.requestFailed(request);
    page.on?.("popup", onPopup);
    page.on?.("close", onClose);
    page.on?.("dialog", onDialog);
    page.on?.("download", onDownload);
    page.on?.("console", onConsole);
    page.on?.("pageerror", onPageError);
    page.on?.("request", onRequest);
    page.on?.("response", onResponse);
    page.on?.("requestfailed", onRequestFailed);
    this.#pageHandlers.set(page, {
      onPopup,
      onClose,
      onDialog,
      onDownload,
      onConsole,
      onPageError,
      onRequest,
      onResponse,
      onRequestFailed,
    });
    return page;
  }

  #untrackOwnedPage(page) {
    const handlers = this.#pageHandlers.get(page);
    if (handlers) {
      page.off?.("popup", handlers.onPopup);
      page.off?.("close", handlers.onClose);
      page.off?.("dialog", handlers.onDialog);
      page.off?.("download", handlers.onDownload);
      page.off?.("console", handlers.onConsole);
      page.off?.("pageerror", handlers.onPageError);
      page.off?.("request", handlers.onRequest);
      page.off?.("response", handlers.onResponse);
      page.off?.("requestfailed", handlers.onRequestFailed);
      this.#pageHandlers.delete(page);
    }
    this.#ownedPages.delete(page);
    this.#popupQueue = this.#popupQueue.filter((candidate) => candidate !== page);
    if (this.#implicitPage === page) this.#implicitPage = undefined;
    if (this.currentPage === page) this.currentPage = undefined;
  }

  #ownedOpenPages() {
    const pages = [];
    for (const page of [...this.#ownedPages.keys()]) {
      if (page.isClosed?.()) {
        this.#untrackOwnedPage(page);
      } else {
        pages.push(page);
      }
    }
    return pages;
  }

  #openPage() {
    if (!this.browser?.isConnected?.()) return undefined;
    const pages = this.#ownedOpenPages();
    if (this.currentPage && pages.includes(this.currentPage)) return this.currentPage;
    return pages.at(-1);
  }

  async #closeOwnedPage(page) {
    if (!this.#ownedPages.has(page)) return true;
    try {
      await page.close();
      this.#untrackOwnedPage(page);
      return true;
    } catch (error) {
      this.logger(`Failed to close owned tab: ${error.message}`);
      return false;
    }
  }

  #detachOwnedPages() {
    const currentPage = this.currentPage;
    const ownedPages = [...this.#ownedPages.entries()].filter(([page]) => !page.isClosed?.());
    if (this.#popupTimer) clearTimeout(this.#popupTimer);
    this.#popupTimer = undefined;
    this.#popupQueue = [];
    this.#implicitPage = undefined;
    for (const [page] of [...this.#ownedPages.entries()]) this.#untrackOwnedPage(page);
    return { currentPage, ownedPages };
  }

  takeStateForAdoption() {
    const { currentPage, ownedPages } = this.#detachOwnedPages();
    return {
      browser: this.browser,
      context: this.context,
      currentPage,
      launched: this.launched,
      lifecycle: this.lifecycle,
      ownedPages,
    };
  }

  async #restoreConnection() {
    if (!this.#reconnectFactory) {
      throw new Error("The Edge browser session was closed and cannot be restarted.");
    }

    if (!this.#reconnectPromise) {
      this.#reconnectPromise = this.#reconnectFactory()
        .then((replacement) => {
          const oldPages = [...this.#ownedPages.keys()];
          for (const page of oldPages) this.#untrackOwnedPage(page);
          const state = replacement.takeStateForAdoption();
          this.browser = state.browser;
          this.context = state.context;
          this.currentPage = state.currentPage;
          this.launched = state.launched;
          this.lifecycle = state.lifecycle;
          for (const [page, kind] of state.ownedPages) this.#trackOwnedPage(page, kind);
          if (!this.currentPage || !this.#ownedPages.has(this.currentPage)) {
            this.currentPage = this.#ownedOpenPages().at(-1);
          }
          return this.currentPage;
        })
        .finally(() => {
          this.#reconnectPromise = undefined;
        });
    }

    return this.#reconnectPromise;
  }

  async ensureReady() {
    const openPage = this.#openPage();
    if (openPage) {
      this.currentPage = openPage;
      return openPage;
    }

    if (this.browser?.isConnected?.()) {
      try {
        const page = await this.#createOwnedPage("primary");
        this.currentPage = page;
        await this.maybeBringToFront(page);
        return page;
      } catch {
        // The last Edge window can close the CDP context between checks.
      }
    }

    return this.#restoreConnection();
  }

  page() {
    const page = this.#openPage();
    if (!page) throw new Error("No open Edge tab is available.");
    this.currentPage = page;
    return page;
  }

  async maybeBringToFront(page = this.page()) {
    if (this.bringToFront) await page.bringToFront();
    return page;
  }

  tabId(page) {
    if (!this.#tabIds.has(page)) {
      this.#tabIds.set(page, `t${this.#nextTabId++}`);
    }
    return this.#tabIds.get(page);
  }

  async listTabs() {
    await this.ensureReady();
    return Promise.all(
      this.#ownedOpenPages().map(async (page) => ({
        id: this.tabId(page),
        active: page === this.currentPage,
        title: await page.title().catch(() => ""),
        url: page.url(),
      })),
    );
  }

  async switchTab(tabId) {
    await this.ensureReady();
    const page = this.#ownedOpenPages().find((candidate) => this.tabId(candidate) === tabId);
    if (!page) throw new Error(`Unknown tab id for this MCP session: ${tabId}`);
    this.currentPage = page;
    await this.maybeBringToFront(page);
    return page;
  }

  async newTab() {
    const existingPage = this.#openPage();
    const activePage = await this.ensureReady();
    if (!existingPage) return activePage;
    const page = await this.#createOwnedPage("explicit");
    this.currentPage = page;
    await this.maybeBringToFront(page);
    return page;
  }

  async closeTab(tabId) {
    await this.ensureReady();
    const page = this.#ownedOpenPages().find((candidate) => this.tabId(candidate) === tabId);
    if (!page) throw new Error(`Unknown tab id for this MCP session: ${tabId}`);

    if (!(await this.#closeOwnedPage(page))) {
      throw new Error(`Failed to close tab ${tabId}; it remains owned by this MCP session.`);
    }
    const remaining = this.#ownedOpenPages();
    if (remaining.length > 0) {
      this.currentPage = remaining.at(-1);
    } else {
      const replacement = await this.#createOwnedPage("primary");
      this.currentPage = replacement;
    }
    await this.maybeBringToFront(this.currentPage);
    return this.currentPage;
  }

  async settlePopups({ waitForQuiet = true } = {}) {
    if (this.#popupSettlement) return this.#popupSettlement;
    this.#popupSettlement = (async () => {
      if (waitForQuiet && this.popupQuietMs > 0 && this.#popupQueue.length > 0) {
        await this.#sleep(this.popupQuietMs);
      }
      if (this.#popupTimer) clearTimeout(this.#popupTimer);
      this.#popupTimer = undefined;

      const queued = this.#popupQueue.filter((page) => this.#ownedPages.has(page) && !page.isClosed?.());
      this.#popupQueue = [];
      const newest = queued.at(-1);
      if (!newest) return this.#openPage();

      if (this.autoCloseTabs) {
        const implicitPages = [...this.#ownedPages.entries()]
          .filter(([page, kind]) => kind === "implicit" && page !== newest && !page.isClosed?.())
          .map(([page]) => page);
        for (const page of implicitPages) await this.#closeOwnedPage(page);
      }

      this.#implicitPage = newest;
      this.currentPage = newest;
      await this.maybeBringToFront(newest).catch(() => {});
      return newest;
    })().finally(() => {
      this.#popupSettlement = undefined;
      if (this.#popupQueue.length > 0) this.#schedulePopupSettlement();
    });
    return this.#popupSettlement;
  }

  async closeOwnedTabs({ attempts = 1, retryDelayMs = 100 } = {}) {
    if (this.#popupTimer) clearTimeout(this.#popupTimer);
    this.#popupTimer = undefined;
    this.#popupQueue = [];
    let closedTabs = 0;
    const boundedAttempts = Math.max(1, Math.min(5, Number(attempts) || 1));
    for (let attempt = 0; attempt < boundedAttempts; attempt += 1) {
      const pages = this.#ownedOpenPages();
      if (pages.length === 0) break;
      for (const page of pages) {
        if (await this.#closeOwnedPage(page)) closedTabs += 1;
      }
      if (this.#ownedOpenPages().length > 0 && attempt + 1 < boundedAttempts) {
        await this.#sleep(Math.max(0, retryDelayMs));
      }
    }
    const remaining = this.#ownedOpenPages();
    this.currentPage = remaining.at(-1);
    if (!this.#implicitPage || this.#implicitPage.isClosed?.()) this.#implicitPage = undefined;
    return closedTabs;
  }

  async shutdown({ keepOpen }) {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    await this.closeOwnedTabs({ attempts: 3, retryDelayMs: 100 });

    if (this.lifecycle) {
      const { profileDirectory, leaseId, browserKey, managed } = this.lifecycle;
      await withEdgeLifecycleLock(profileDirectory, async (paths) => {
        removeClientLease(paths, leaseId);
        const remaining = listLiveClientLeases(paths, browserKey);
        const owner = readManagedOwner(paths);
        const isManagedBrowser = managed && owner?.browserKey === browserKey;
        if (!keepOpen && isManagedBrowser && remaining.length === 0) {
          try {
            await closeBrowserThroughCdp(this.browser);
          } finally {
            removeManagedOwner(paths);
          }
        }
      });
      if (this.browser?.isConnected?.()) await this.browser.close().catch(() => {});
      return;
    }

    if (keepOpen || !this.browser?.isConnected?.()) return;
    try {
      await closeBrowserThroughCdp(this.browser);
    } finally {
      if (this.browser.isConnected()) await this.browser.close().catch(() => {});
    }
  }
}

export async function connectEdge(config, logger = () => {}, connectionOptions = {}) {
  let parsedCdpUrl;
  try {
    parsedCdpUrl = new URL(config.cdpUrl);
  } catch {
    throw new Error("EDGE_CDP_URL must be an absolute HTTP(S) URL.");
  }

  if (!["http:", "https:"].includes(parsedCdpUrl.protocol)) {
    throw new Error("EDGE_CDP_URL must use HTTP or HTTPS.");
  }
  if (!config.allowRemoteCdp && !isLoopbackHost(parsedCdpUrl.hostname)) {
    throw new Error("Remote CDP is disabled. Use a loopback EDGE_CDP_URL or explicitly set ALLOW_REMOTE_CDP=true.");
  }

  const leaseId = connectionOptions.leaseId || createLeaseId();
  const external = usesExternalProfile(config);
  const lifecycleDirectory = config.lifecycleDirectory || config.edgeUserDataDir;
  return withEdgeLifecycleLock(lifecycleDirectory, async (paths) => {
    let launched = null;
    let browser;
    let browserKey = "";
    let profileVerified = false;
    let leaseRegistered = false;
    let metadata = await getCdpMetadata(config.cdpUrl);
    try {
      if (!metadata) {
        if (config.connectionMode === "attach" || !config.autoLaunchEdge) {
          const hint = config.connectionMode === "attach"
            ? `Start the selected ${browserLabel(config)} with that loopback debugging port, then attach again.`
            : "Run npm run edge first.";
          throw new Error(`No browser is listening at ${config.cdpUrl}. ${hint}`);
        }
        if (config.clearSessionTabsOnStart && !external) clearSavedTabSessions(config.edgeUserDataDir);
        launched = launchEdge(config);
        logger(`Started ${browserLabel(config)} (${launched.executable}) with profile ${config.edgeUserDataDir}`);
        metadata = await waitForCdp(config.cdpUrl);
      }

      browserKey = browserKeyFromWebSocketUrl(metadata.webSocketDebuggerUrl);
      if (!browserKey) throw new Error(`${browserLabel(config)} returned an invalid CDP browser identity.`);

      browser = await chromium.connectOverCDP(config.cdpUrl, { timeout: 15_000 });
      await assertExpectedProfile(browser, config);
      profileVerified = true;
      const context = browser.contexts()[0];
      if (!context) throw new Error(`Connected to ${browserLabel(config)}, but no browser context was available.`);

      if (launched && !external) {
        writeManagedOwner(paths, {
          browserKey,
          cdpUrl: config.cdpUrl,
          profilePath: path.resolve(config.edgeUserDataDir),
          launchedAt: Date.now(),
          launchPid: launched.pid,
        });
      }

      let owner = readManagedOwner(paths);
      if (owner?.browserKey !== browserKey && config.requireDedicatedProfile) {
        writeManagedOwner(paths, {
          browserKey,
          cdpUrl: config.cdpUrl,
          profilePath: path.resolve(config.edgeUserDataDir),
          adoptedAt: Date.now(),
          launchPid: launched?.pid || null,
        });
        owner = readManagedOwner(paths);
      }
      const managed = owner?.browserKey === browserKey;
      const previousLeases = listLiveClientLeases(paths, browserKey)
        .filter((lease) => lease.leaseId !== leaseId);
      const firstClient = previousLeases.length === 0;
      writeClientLease(paths, {
        leaseId,
        browserKey,
        pid: process.pid,
        createdAt: Date.now(),
      });
      leaseRegistered = true;

      const createPage = () => config.bringToFront
        ? context.newPage()
        : createPageInBackground(browser, context);

      let page;
      if (firstClient && managed && config.autoCloseTabs && !external && config.connectionMode !== "attach") {
        await waitForPagesToSettle(context, config.popupQuietMs, 2_000);
        const pages = context.pages().filter((candidate) => !candidate.isClosed());
        page = pages.find((candidate) => BLANK_PAGE_URLS.has(candidate.url()))
          || await createPage();
        for (const candidate of pages) {
          if (candidate !== page) await candidate.close();
        }
      } else if (firstClient && launched) {
        const pages = context.pages().filter((candidate) => !candidate.isClosed());
        page = pages.find((candidate) => BLANK_PAGE_URLS.has(candidate.url()))
          || pages.at(-1)
          || await createPage();
      } else {
        page = await createPage();
      }
      const lifecycle = {
        profileDirectory: lifecycleDirectory,
        leaseId,
        browserKey,
        managed: external ? false : managed,
        externalProfile: external,
      };
      const session = new EdgeSession(
        browser,
        context,
        page,
        launched,
        async () => {
          logger("Edge was closed; starting a new browser session");
          return connectEdge(config, logger, { leaseId });
        },
        {
          lifecycle,
          autoCloseTabs: config.autoCloseTabs,
          bringToFront: config.bringToFront,
          backgroundPages: !config.bringToFront,
          popupQuietMs: config.popupQuietMs,
          artifactsDir: config.artifactsDir,
          logger,
        },
      );
      await session.maybeBringToFront(page);
      return session;
    } catch (error) {
      if (leaseRegistered) removeClientLease(paths, leaseId);
      if (launched) {
        const stopped = await cleanupFailedLaunch({
          browser,
          browserKey,
          launched,
          config,
          profileVerified,
          logger,
        });
        if (stopped) removeManagedOwner(paths);
      } else if (browser?.isConnected?.()) {
        if (launched) await browser.close().catch(() => {});
        else if (typeof browser.disconnect === "function") await browser.disconnect().catch(() => {});
      }
      throw error;
    }
  });
}

export async function forceCloseEdge(config) {
  return withEdgeLifecycleLock(config.edgeUserDataDir, async (paths) => {
    const metadata = await getCdpMetadata(config.cdpUrl);
    if (!metadata) {
      clearLifecycleState(paths);
      return false;
    }
    const browser = await chromium.connectOverCDP(config.cdpUrl, { timeout: 15_000 });
    try {
      await assertExpectedProfile(browser, config);
      await closeBrowserThroughCdp(browser);
    } finally {
      clearLifecycleState(paths);
      if (browser.isConnected()) await browser.close().catch(() => {});
    }
    return true;
  });
}
