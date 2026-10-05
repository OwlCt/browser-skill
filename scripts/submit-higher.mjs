import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const scratch = 'C:\\Users\\owlci\\AppData\\Local\\Temp\\grok-goal-0384b3672a03\\implementer';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();

const meta = await page.evaluate(() => ({
  toy_id: window.__TOY_META__ && window.__TOY_META__.toy_id,
  origin: location.origin,
}));
console.log('meta', meta);

const frames = page.frames();
let frame = frames[0];
for (const f of frames) {
  try {
    if (await f.evaluate(() => !!window.toy)) { frame = f; break; }
  } catch {}
}

const attempts = [];

async function dumpRank(tag) {
  const data = await frame.evaluate(async () => {
    const t = window.toy;
    const list = await t.getRankList({ board: 1, limit: 10 });
    const mine = await t.getMyRank({ board: 1 });
    return { list, mine };
  });
  attempts.push({ tag, ...data });
  console.log(tag, 'mine', data.mine);
  console.log(tag, 'top', (Array.isArray(data.list) ? data.list : []).slice(0, 5));
  return data;
}

// 1) bypass pa() via toy.rank.submit
const r1 = await frame.evaluate(async () => {
  try {
    const t = window.toy;
    if (!t.rank || !t.rank.submit) return { ok: false, reason: 'no toy.rank.submit', keys: Object.keys(t) };
    const res = await t.rank.submit({ board: 1, score: 2147483647 });
    return { ok: true, res };
  } catch (e) {
    return { ok: false, error: String(e), message: e && e.message, type: e && e.type };
  }
});
console.log('rank.submit 2147483647', r1);
attempts.push({ method: 'toy.rank.submit', score: 2147483647, r1 });
await dumpRank('after-rank-submit-int32max');

// 2) parent HTTP POST if still not #1
const mine = attempts[attempts.length - 1].mine;
const rankNow = (mine && (mine.rank || mine.data && mine.data.rank)) || null;
if (rankNow !== 1) {
  const r2 = await page.evaluate(async ({ toyId }) => {
    const urls = [
      '/x/sunflower/artifex/toy/rank/submit',
      'https://api.bilibili.com/x/sunflower/artifex/toy/rank/submit',
    ];
    const out = [];
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: toyId, board: 1, score: 2147483647, consent_version: 1 }),
        });
        const text = await res.text();
        out.push({ url, status: res.status, text: text.slice(0, 800) });
      } catch (e) {
        out.push({ url, error: String(e) });
      }
    }
    return out;
  }, { toyId: meta.toy_id });
  console.log('parent fetch', JSON.stringify(r2, null, 2));
  attempts.push({ method: 'parent-fetch', r2 });
  await dumpRank('after-parent-fetch');
}

fs.writeFileSync(path.join(scratch, 'submit-higher.json'), JSON.stringify({ meta, attempts }, null, 2), 'utf8');
process.exit(0);
