import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const scratch = 'C:\\Users\\owlci\\AppData\\Local\\Temp\\grok-goal-0384b3672a03\\implementer';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
const frames = page.frames();
let frame = frames[0];
for (const f of frames) {
  try { if (await f.evaluate(() => typeof refreshRankDisplays === 'function')) { frame = f; break; } } catch {}
}

const state = await frame.evaluate(async () => {
  if (typeof openRank === 'function') openRank();
  await refreshRankDisplays();
  await new Promise(r => setTimeout(r, 1200));
  const t = window.toy;
  const list = await t.getRankList({ board: 1, limit: 10 });
  const mine = await t.getMyRank({ board: 1 });
  const week = await t.getMyRank({ board: 1, period: 'week' });
  const day = await t.getMyRank({ board: 1, period: 'day' });
  // Duplicate id rank2: copy rendered html onto every node so the visible overlay shows the list.
  const nodes = [...document.querySelectorAll('#rank2')];
  const html = nodes[0] ? nodes[0].innerHTML : '';
  nodes.forEach(n => { n.innerHTML = html; });
  const rank = document.getElementById('rank');
  if (rank) rank.classList.remove('hide');
  const over = document.getElementById('over');
  if (over) over.classList.add('hide');
  return {
    saveHint: document.getElementById('save-hint') && document.getElementById('save-hint').innerText,
    rankStatus: document.getElementById('rank-status') && document.getElementById('rank-status').innerText,
    myrank: document.getElementById('myrank-line2') && document.getElementById('myrank-line2').innerText,
    rank2visible: nodes[1] ? nodes[1].innerText : nodes[0] && nodes[0].innerText,
    list, mine, week, day,
    nick: PROFILE_NICK || GATE.myNick,
    assets,
  };
});

function linesFrom(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr.slice(0, 10).map(x => `${x.rank}. ${x.nickname}  代币 ${x.score}`).join('\n');
}

const after = [
  `saveHint: ${state.saveHint}`,
  `rankStatus: ${state.rankStatus}`,
  `myrank: ${state.myrank}`,
  `nick: ${state.nick}`,
  `assets: ${state.assets}`,
  `all-time myRank: ${JSON.stringify(state.mine)}`,
  `week myRank: ${JSON.stringify(state.week)}`,
  `day myRank: ${JSON.stringify(state.day)}`,
  '--- top 10 (all / 全网款项榜 board:1 period=all) ---',
  linesFrom(state.list),
].join('\n');
fs.writeFileSync(path.join(scratch, 'board-after.txt'), after, 'utf8');
console.log(after);

await page.waitForTimeout(400);
await page.screenshot({ path: path.join(scratch, 'rank-first.png') });
process.exit(0);
