import assert from "node:assert/strict";
import test from "node:test";
import { createIdleTabScheduler } from "../src/idle-tab-scheduler.mjs";

function fakeTimers() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    setTimer(callback) {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    },
    clearTimer(id) {
      callbacks.delete(id);
    },
    runAll() {
      for (const [id, callback] of [...callbacks]) {
        callbacks.delete(id);
        callback();
      }
    },
    get size() {
      return callbacks.size;
    },
  };
}

test("idle cleanup waits until every concurrent browser call finishes", async () => {
  const timers = fakeTimers();
  let cleanups = 0;
  const scheduler = createIdleTabScheduler({
    timeoutMs: 60_000,
    onIdle: async () => { cleanups += 1; },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  scheduler.begin();
  scheduler.begin();
  scheduler.end();
  assert.equal(timers.size, 0);
  timers.runAll();
  assert.equal(cleanups, 0);

  scheduler.end();
  assert.equal(timers.size, 1);
  timers.runAll();
  await Promise.resolve();
  assert.equal(cleanups, 1);
});

test("new browser activity cancels a pending idle cleanup", async () => {
  const timers = fakeTimers();
  let cleanups = 0;
  const scheduler = createIdleTabScheduler({
    timeoutMs: 60_000,
    onIdle: async () => { cleanups += 1; },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  scheduler.begin();
  scheduler.end();
  assert.equal(timers.size, 1);
  scheduler.begin();
  assert.equal(timers.size, 0);
  timers.runAll();
  await Promise.resolve();
  assert.equal(cleanups, 0);

  scheduler.end();
  timers.runAll();
  await Promise.resolve();
  assert.equal(cleanups, 1);
});

