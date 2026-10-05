import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
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

export function findEdgeExecutable(configuredPath = "", env = process.env) {
  const candidates = [
    configuredPath,
    env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    env.ProgramFiles && path.join(env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
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

export function findUserDataDirArgument(commandLine = []) {
  for (let index = 0; index < commandLine.length; index += 1) {
    const argument = String(commandLine[index]);
    if (argument === "--user-data-dir") return commandLine[index + 1] || "";
    if (argument.startsWith("--user-data-dir=")) return argument.slice("--user-data-dir=".length);
  }
  return "";
}

async function assertDedicatedProfile(browser, config) {
  if (!config.requireDedicatedProfile) return;

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

  const actualProfile = findUserDataDirArgument(commandLine);
  if (!actualProfile || normalizeProfilePath(actualProfile) !== normalizeProfilePath(config.edgeUserDataDir)) {
    throw new Error(`Refusing to use Edge at ${config.cdpUrl}: expected dedicated profile ${config.edgeUserDataDir}, but the listening browser uses ${actualProfile || "an unknown profile"}.`);
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

export function edgeLaunchArguments(config) {
  const cdpUrl = new URL(config.cdpUrl);
  const port = cdpUrl.port || (cdpUrl.protocol === "https:" ? "443" : "80");
  return [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${config.edgeUserDataDir}`,
      "--profile-directory=Default",
      "--enable-automation",
      "--disable-extensions",
      "--disable-sync",
      "--disable-default-apps",
      "--disable-session-crashed-bubble",
      ...(config.headless ? ["--headless=new"] : []),
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
  ];
}

export function launchEdge(config) {
  const executable = findEdgeExecutable(config.edgeExecutable);
  if (!executable) {
    throw new Error("Microsoft Edge was not found. Set EDGE_EXECUTABLE in .env.");
  }

  fs.mkdirSync(config.edgeUserDataDir, { recursive: true });

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
        await assertDedicatedProfile(cleanupBrowser, config);
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
    if (page) this.#trackOwnedPage(page, "primary");
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
    page.on?.("popup", onPopup);
    page.on?.("close", onClose);
    this.#pageHandlers.set(page, { onPopup, onClose });
    return page;
  }

  #untrackOwnedPage(page) {
    const handlers = this.#pageHandlers.get(page);
    if (handlers) {
      page.off?.("popup", handlers.onPopup);
      page.off?.("close", handlers.onClose);
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
  return withEdgeLifecycleLock(config.edgeUserDataDir, async (paths) => {
    let launched = null;
    let browser;
    let browserKey = "";
    let profileVerified = false;
    let leaseRegistered = false;
    let metadata = await getCdpMetadata(config.cdpUrl);
    try {
      if (!metadata) {
        if (!config.autoLaunchEdge) {
          throw new Error(`No browser is listening at ${config.cdpUrl}. Run npm run edge first.`);
        }
        if (config.clearSessionTabsOnStart) clearSavedTabSessions(config.edgeUserDataDir);
        launched = launchEdge(config);
        logger(`Started Edge (${launched.executable}) with profile ${config.edgeUserDataDir}`);
        metadata = await waitForCdp(config.cdpUrl);
      }

      browserKey = browserKeyFromWebSocketUrl(metadata.webSocketDebuggerUrl);
      if (!browserKey) throw new Error("Edge returned an invalid CDP browser identity.");

      browser = await chromium.connectOverCDP(config.cdpUrl, { timeout: 15_000 });
      await assertDedicatedProfile(browser, config);
      profileVerified = true;
      const context = browser.contexts()[0];
      if (!context) throw new Error("Connected to Edge, but no browser context was available.");

      if (launched) {
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
      if (firstClient && managed && config.autoCloseTabs) {
        await waitForPagesToSettle(context, config.popupQuietMs, 2_000);
        const pages = context.pages().filter((candidate) => !candidate.isClosed());
        page = pages.find((candidate) => ["about:blank", "edge://newtab/"].includes(candidate.url()))
          || await createPage();
        for (const candidate of pages) {
          if (candidate !== page) await candidate.close();
        }
      } else if (firstClient && launched) {
        const pages = context.pages().filter((candidate) => !candidate.isClosed());
        page = pages.find((candidate) => ["about:blank", "edge://newtab/"].includes(candidate.url()))
          || pages.at(-1)
          || await createPage();
      } else {
        page = await createPage();
      }
      const lifecycle = {
        profileDirectory: config.edgeUserDataDir,
        leaseId,
        browserKey,
        managed,
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
        await browser.close().catch(() => {});
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
      await assertDedicatedProfile(browser, config);
      await closeBrowserThroughCdp(browser);
    } finally {
      clearLifecycleState(paths);
      if (browser.isConnected()) await browser.close().catch(() => {});
    }
    return true;
  });
}
