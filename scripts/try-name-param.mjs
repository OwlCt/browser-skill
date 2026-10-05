import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const scratch = 'C:\\Users\\owlci\\AppData\\Local\\Temp\\grok-goal-0384b3672a03\\implementer';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts()[0].pages().find(p => p.url().includes('xujiayin-blank'))
  || browser.contexts()[0].pages()[0];
await page.bringToFront();

const frames = page.frames();
let frame = frames[0];
for (const f of frames) {
  try { if (await f.evaluate(() => !!window.toy && typeof uploadScore === 'function')) { frame = f; break; } } catch {}
}

const hooked = await page.evaluate(() => {
  if (window.__nameHook) return { already: true };
  window.__nameHook = [];
  const patchBody = (body) => {
    if (!body) return body;
    if (typeof body === 'string') {
      try {
        const o = JSON.parse(body);
        o.nickname = 'forsaken';
        o.name = 'forsaken';
        o.uname = 'forsaken';
        o.user_name = 'forsaken';
        return JSON.stringify(o);
      } catch { return body; }
    }
    if (typeof body === 'object' && !(body instanceof FormData)) {
      body.nickname = 'forsaken';
      body.name = 'forsaken';
      body.uname = 'forsaken';
      return body;
    }
    return body;
  };
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || '');
    if (url.includes('rank/submit') && init) {
      init = { ...init, body: patchBody(init.body) };
      window.__nameHook.push({ via: 'fetch', url, body: String(init.body).slice(0, 400) });
    }
    return origFetch(input, init);
  };
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__url = String(url || '');
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(body) {
    if (this.__url && this.__url.includes('rank/submit')) {
      body = patchBody(body);
      window.__nameHook.push({ via: 'xhr', url: this.__url, body: String(body).slice(0, 400) });
    }
    return origSend.call(this, body);
  };
  return { hooked: true };
});

const submit = await frame.evaluate(async () => {
  try {
    const t = window.toy;
    const res = await t.submitScore({
      board: 1,
      score: 16777215,
      nickname: 'forsaken',
      name: 'forsaken',
      uname: 'forsaken',
    });
    return { ok: true, res };
  } catch (e) {
    return { ok: false, error: String(e), message: e && e.message };
  }
});

await page.waitForTimeout(800);
const hookLog = await page.evaluate(() => window.__nameHook || []);
const after = await frame.evaluate(async () => {
  const t = window.toy;
  const list = await t.getRankList({ board: 1, limit: 10 });
  const mine = await t.getMyRank({ board: 1 });
  return { list: (Array.isArray(list) ? list : []).slice(0, 5), mine, saveHint: document.getElementById('save-hint') && document.getElementById('save-hint').innerText };
});

const out = { hooked, submit, hookLog, after };
fs.writeFileSync(path.join(scratch, 'rename-try.json'), JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify(out, null, 2));
process.exit(0);
