import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LIFECYCLE_DIRECTORY = ".responses-edge-browser";
const LOCK_FILENAME = "lifecycle.lock";
const OWNER_FILENAME = "owner.json";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function lifecyclePaths(profileDirectory) {
  const profile = path.resolve(profileDirectory);
  const root = path.join(profile, LIFECYCLE_DIRECTORY);
  const leases = path.join(root, "leases");
  return {
    profile,
    root,
    leases,
    lock: path.join(root, LOCK_FILENAME),
    owner: path.join(root, OWNER_FILENAME),
  };
}

function readJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filename, value) {
  fs.writeFileSync(filename, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

function removeFile(filename) {
  try {
    fs.unlinkSync(filename);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function lockOwnerIsStale(lockPath, staleAfterMs, processAlive) {
  const lock = readJson(lockPath);
  if (lock?.pid && processAlive(Number(lock.pid))) return false;
  try {
    const age = Date.now() - fs.statSync(lockPath).mtimeMs;
    return age >= staleAfterMs || Boolean(lock?.pid);
  } catch {
    return true;
  }
}

export async function withEdgeLifecycleLock(
  profileDirectory,
  callback,
  {
    timeoutMs = 30_000,
    pollMs = 50,
    staleAfterMs = 60_000,
    processAlive = isProcessAlive,
  } = {},
) {
  const paths = lifecyclePaths(profileDirectory);
  fs.mkdirSync(paths.leases, { recursive: true });

  const nonce = randomUUID();
  const deadline = Date.now() + timeoutMs;
  let descriptor;

  while (descriptor == null) {
    try {
      descriptor = fs.openSync(paths.lock, "wx", 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, nonce, acquiredAt: Date.now() })}\n`);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (lockOwnerIsStale(paths.lock, staleAfterMs, processAlive)) {
        removeFile(paths.lock);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the Edge lifecycle lock at ${paths.lock}.`);
      }
      await sleep(pollMs);
    }
  }

  try {
    return await callback(paths);
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch {
      // The descriptor may already be closed during process teardown.
    }
    const lock = readJson(paths.lock);
    if (lock?.nonce === nonce) removeFile(paths.lock);
  }
}

export function browserKeyFromWebSocketUrl(webSocketDebuggerUrl) {
  try {
    const url = new URL(webSocketDebuggerUrl);
    return url.pathname.split("/").filter(Boolean).at(-1) || "";
  } catch {
    return "";
  }
}

export function readManagedOwner(paths) {
  const owner = readJson(paths.owner);
  return owner?.v === 1 && owner.browserKey ? owner : null;
}

export function writeManagedOwner(paths, owner) {
  writeJson(paths.owner, { v: 1, managed: true, ...owner });
}

export function removeManagedOwner(paths) {
  removeFile(paths.owner);
}

function leaseFilename(paths, leaseId) {
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(leaseId)) throw new Error("Invalid Edge lifecycle lease id.");
  return path.join(paths.leases, `${leaseId}.json`);
}

export function writeClientLease(paths, lease) {
  writeJson(leaseFilename(paths, lease.leaseId), { v: 1, ...lease });
}

export function removeClientLease(paths, leaseId) {
  removeFile(leaseFilename(paths, leaseId));
}

export function listLiveClientLeases(
  paths,
  browserKey,
  { processAlive = isProcessAlive } = {},
) {
  fs.mkdirSync(paths.leases, { recursive: true });
  const live = [];
  for (const entry of fs.readdirSync(paths.leases, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filename = path.join(paths.leases, entry.name);
    const lease = readJson(filename);
    if (lease?.v !== 1 || !processAlive(Number(lease.pid)) || lease.browserKey !== browserKey) {
      removeFile(filename);
      continue;
    }
    live.push(lease);
  }
  return live;
}

export function clearLifecycleState(paths) {
  removeManagedOwner(paths);
  if (!fs.existsSync(paths.leases)) return;
  for (const entry of fs.readdirSync(paths.leases, { withFileTypes: true })) {
    if (entry.isFile()) removeFile(path.join(paths.leases, entry.name));
  }
}

export function createLeaseId() {
  return randomUUID().replaceAll("-", "");
}

