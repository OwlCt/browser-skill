import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const scratch = 'C:\\Users\\owlci\\AppData\\Local\\Temp\\grok-goal-0384b3672a03\\implementer';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts()[0].pages().find(p => p.url().includes('xujiayin-blank'))
  || browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.waitForTimeout(300);

const frames = page.frames();
let frame = frames[0];
for (const f of frames) {
  try {
    if (await f.evaluate(() => typeof uploadScore === 'function')) { frame = f; break; }
  } catch {}
}

const before = await frame.evaluate(() => {
  setAssets(16777215);
  setBestAssets(assets);
  if (typeof openRank === 'function') openRank();
  return { assets, best: bestAssets(), rankVisible: !document.getElementById('rank').classList.contains('hide') };
});
console.log('assets set', before);

await page.waitForTimeout(800);
await page.screenshot({ path: path.join(scratch, 'before-upload.png') });

// Click the visible 上传我的成绩 in #rank overlay.
const clicked = await frame.evaluate(async () => {
  const rank = document.getElementById('rank');
  const btn = rank && [...rank.querySelectorAll('button')].find(b => b.textContent.includes('上传我的成绩'));
  if (!btn) return { ok: false, reason: 'button not found' };
  btn.click();
  await new Promise(r => setTimeout(r, 1500));
  return {
    ok: true,
    saveHint: document.getElementById('save-hint') ? document.getElementById('save-hint').innerText : '',
    rankStatus: document.getElementById('rank-status') ? document.getElementById('rank-status').innerText : '',
  };
});
console.log('clicked', clicked);
fs.writeFileSync(path.join(scratch, 'upload-hint.txt'), (clicked.saveHint || '') + '\n' + JSON.stringify(clicked, null, 2), 'utf8');

await page.waitForTimeout(500);
await page.screenshot({ path: path.join(scratch, 'after-upload.png') });

// Click 刷新
const afterRefresh = await frame.evaluate(async () => {
  if (typeof refreshRank === 'function') await refreshRank();
  await new Promise(r => setTimeout(r, 1500));
  const t = T();
  let listRaw = null, myRankRaw = null;
  try { listRaw = await t.getRankList({ board: 1, limit: 10 }); } catch (e) { listRaw = { error: String(e) }; }
  try { myRankRaw = await t.getMyRank({ board: 1 }); } catch (e) { myRankRaw = { error: String(e) }; }
  return {
    saveHint: document.getElementById('save-hint') && document.getElementById('save-hint').innerText,
    rankStatus: document.getElementById('rank-status') && document.getElementById('rank-status').innerText,
    myrank: document.getElementById('myrank-line2') && document.getElementById('myrank-line2').innerText,
    rank2: [...document.querySelectorAll('#rank2')].map(el => el.innerText),
    listRaw,
    myRankRaw,
    assets,
  };
});

function pick(x) {
  const name = x.nickname || x.uname || x.name || '';
  return `${x.rank}. ${name}  代币 ${x.score}`;
}
let list = [];
const r = afterRefresh.listRaw;
if (Array.isArray(r)) list = r;
else if (r && Array.isArray(r.list)) list = r.list;

const lines = [];
lines.push(`saveHint: ${afterRefresh.saveHint}`);
lines.push(`rankStatus: ${afterRefresh.rankStatus}`);
lines.push(`myrank: ${afterRefresh.myrank}`);
lines.push(`myRankRaw: ${JSON.stringify(afterRefresh.myRankRaw)}`);
lines.push(`assets: ${afterRefresh.assets}`);
lines.push('--- top 10 ---');
list.slice(0, 10).forEach((it, i) => lines.push(pick(it) || JSON.stringify(it)));
if (!list.length) lines.push(JSON.stringify(afterRefresh.listRaw, null, 2));
const text = lines.join('\n');
fs.writeFileSync(path.join(scratch, 'board-after.txt'), text, 'utf8');
console.log(text);

await page.screenshot({ path: path.join(scratch, 'rank-first.png') });
process.exit(0);
