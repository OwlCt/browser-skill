import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  browserKeyFromWebSocketUrl,
  createLeaseId,
  listLiveClientLeases,
  readManagedOwner,
  removeClientLease,
  withEdgeLifecycleLock,
  writeClientLease,
  writeManagedOwner,
} from "../src/edge-lifecycle.mjs";
import { clearSavedTabSessions, EdgeSession } from "../src/edge-session.mjs";

function temporaryProfile(t) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "responses-edge-lifecycle-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  return profile;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function makeLifecyclePage() {
  let closed = false;
  const handlers = new Map();
  const page = {
    isClosed: () => closed,
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
    },
    off(event, handler) {
      handlers.get(event)?.delete(handler);
    },
    async close() {
      closed = true;
      for (const handler of [...(handlers.get("close") || [])]) handler();
    },
  };
  return page;
}

function makeLifecycleBrowser(commands) {
  let connected = true;
  return {
    isConnected: () => connected,
    async newBrowserCDPSession() {
      return {
        async send(command) {
          commands.push(command);
          if (command === "Browser.close") connected = false;
        },
      };
    },
    async close() {
      connected = false;
    },
  };
}

test("profile lifecycle lock serializes concurrent clients", async (t) => {
  const profile = temporaryProfile(t);
  let active = 0;
  let maxActive = 0;

  await Promise.all([
    withEdgeLifecycleLock(profile, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(60);
      active -= 1;
    }),
    withEdgeLifecycleLock(profile, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(10);
      active -= 1;
    }),
  ]);

  assert.equal(maxActive, 1);
});

test("stale lifecycle locks are recovered", async (t) => {
  const profile = temporaryProfile(t);
  const root = path.join(profile, ".responses-edge-browser");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "lifecycle.lock"), JSON.stringify({ pid: 999_999, nonce: "stale" }));

  const value = await withEdgeLifecycleLock(
    profile,
    async () => "recovered",
    { processAlive: () => false, timeoutMs: 500 },
  );

  assert.equal(value, "recovered");
});

test("managed owner and live leases are scoped to one browser identity", async (t) => {
  const profile = temporaryProfile(t);
  await withEdgeLifecycleLock(profile, async (paths) => {
    writeManagedOwner(paths, { browserKey: "browser-one", cdpUrl: "http://127.0.0.1:9333" });
    writeClientLease(paths, {
      leaseId: createLeaseId(),
      browserKey: "browser-one",
      pid: process.pid,
      createdAt: Date.now(),
    });
    writeClientLease(paths, {
      leaseId: createLeaseId(),
      browserKey: "browser-old",
      pid: process.pid,
      createdAt: Date.now(),
    });

    assert.equal(readManagedOwner(paths).browserKey, "browser-one");
    assert.equal(listLiveClientLeases(paths, "browser-one").length, 1);
  });
});

test("saved tab sessions are cleared without deleting login or history data", (t) => {
  const profile = temporaryProfile(t);
  const defaultProfile = path.join(profile, "Default");
  fs.mkdirSync(path.join(defaultProfile, "Sessions"), { recursive: true });
  fs.writeFileSync(path.join(defaultProfile, "Sessions", "Tabs_1"), "tabs");
  fs.writeFileSync(path.join(defaultProfile, "Last Tabs"), "last tabs");
  fs.writeFileSync(path.join(defaultProfile, "Cookies"), "login state");
  fs.writeFileSync(path.join(defaultProfile, "History"), "history");

  clearSavedTabSessions(profile);

  assert.equal(fs.existsSync(path.join(defaultProfile, "Sessions")), false);
  assert.equal(fs.existsSync(path.join(defaultProfile, "Last Tabs")), false);
  assert.equal(fs.readFileSync(path.join(defaultProfile, "Cookies"), "utf8"), "login state");
  assert.equal(fs.readFileSync(path.join(defaultProfile, "History"), "utf8"), "history");
});

test("saved tab cleanup refuses a filesystem root", () => {
  const root = path.parse(path.resolve(os.tmpdir())).root;
  assert.throws(() => clearSavedTabSessions(root), /filesystem root/);
});

test("only the last managed client closes the shared Edge browser", async (t) => {
  const profile = temporaryProfile(t);
  const browserKey = "shared-browser";
  const firstLease = createLeaseId();
  const secondLease = createLeaseId();
  await withEdgeLifecycleLock(profile, async (paths) => {
    writeManagedOwner(paths, { browserKey, cdpUrl: "http://127.0.0.1:9333" });
    for (const leaseId of [firstLease, secondLease]) {
      writeClientLease(paths, { leaseId, browserKey, pid: process.pid, createdAt: Date.now() });
    }
  });

  const commands = [];
  const firstSession = new EdgeSession(
    makeLifecycleBrowser(commands),
    null,
    makeLifecyclePage(),
    null,
    null,
    {
      lifecycle: { profileDirectory: profile, leaseId: firstLease, browserKey, managed: true },
    },
  );
  const secondSession = new EdgeSession(
    makeLifecycleBrowser(commands),
    null,
    makeLifecyclePage(),
    null,
    null,
    {
      lifecycle: { profileDirectory: profile, leaseId: secondLease, browserKey, managed: true },
    },
  );

  await firstSession.shutdown({ keepOpen: false });
  assert.deepEqual(commands, []);

  await secondSession.shutdown({ keepOpen: false });
  assert.deepEqual(commands, ["Browser.close"]);
});

test("an attached client never closes an unowned external Edge browser", async (t) => {
  const profile = temporaryProfile(t);
  const browserKey = "external-browser";
  const leaseId = createLeaseId();
  await withEdgeLifecycleLock(profile, async (paths) => {
    writeClientLease(paths, { leaseId, browserKey, pid: process.pid, createdAt: Date.now() });
  });

  const commands = [];
  const session = new EdgeSession(
    makeLifecycleBrowser(commands),
    null,
    makeLifecyclePage(),
    null,
    null,
    {
      lifecycle: { profileDirectory: profile, leaseId, browserKey, managed: false },
    },
  );

  await session.shutdown({ keepOpen: false });

  assert.deepEqual(commands, []);
  await withEdgeLifecycleLock(profile, async (paths) => {
    removeClientLease(paths, leaseId);
    assert.equal(listLiveClientLeases(paths, browserKey).length, 0);
  });
});

test("CDP browser identities are extracted without trusting the full URL", () => {
  assert.equal(
    browserKeyFromWebSocketUrl("ws://127.0.0.1:9333/devtools/browser/abc-123"),
    "abc-123",
  );
  assert.equal(browserKeyFromWebSocketUrl("not a URL"), "");
});

