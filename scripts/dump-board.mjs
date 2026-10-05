import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const scratch = 'C:\\Users\\owlci\\AppData\\Local\\Temp\\grok-goal-0384b3672a03\\implementer';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts()[0].pages().find(p => p.url().includes('xujiayin-blank'))
  || browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.waitForTimeout(500);

const frames = page.frames();
let frame = frames[0];
for (const f of frames) {
  try {
    const hit = await f.evaluate(() => typeof uploadScore === 'function' && typeof T === 'function');
    if (hit) { frame = f; break; }
  } catch {}
}

const data = await frame.evaluate(async () => {
  const $ = (id) => document.getElementById(id);
  const text = (id) => ($ (id) ? $(id).innerText : null);
  const t = (typeof T === 'function') ? T() : (window.toy || null);
  let listRaw = null, myRankRaw = null, profile = null;
  const support = {};
  if (t) {
    support.getRankList = await t.isSupport('getRankList').catch(() => false);
    support.getMyRank = await t.isSupport('getMyRank').catch(() => false);
    support.submitScore = await t.isSupport('submitScore').catch(() => false);
    support.getUserProfile = await t.isSupport('getUserProfile').catch(() => false);
    try { listRaw = await t.getRankList({ board: 1, limit: 10 }); } catch (e) { listRaw = { error: String(e) }; }
    try { myRankRaw = await t.getMyRank({ board: 1 }); } catch (e) { myRankRaw = { error: String(e) }; }
    try { if (support.getUserProfile) profile = await t.getUserProfile(); } catch (e) { profile = { error: String(e) }; }
  }
  const rank2s = [...document.querySelectorAll('#rank2')].map(el => el.innerText);
  return {
    frameHref: location.href,
    rankStatus: text('rank-status'),
    myrank: text('myrank-line'),
    myrank2: text('myrank-line2'),
    saveHint: text('save-hint'),
    titleH: text('title-h'),
    assets: typeof assets === 'undefined' ? null : assets,
    GATE: typeof GATE === 'undefined' ? null : GATE,
    PROFILE_NICK: typeof PROFILE_NICK === 'undefined' ? null : PROFILE_NICK,
    ME: typeof ME === 'undefined' ? null : ME,
    support,
    listRaw,
    myRankRaw,
    profile,
    rank2s,
    rankVisible: $('rank') ? !$('rank').classList.contains('hide') : null,
    overVisible: $('over') ? !$('over').classList.contains('hide') : null,
    toyType: t ? typeof t : 'null',
  };
});

fs.writeFileSync(path.join(scratch, 'board-raw.json'), JSON.stringify(data, null, 2), 'utf8');

function pick(x) {
  if (!x || typeof x !== 'object') return { raw: x };
  const name = x.nickname || x.uname || x.name || x.user_name || x.userName || '';
  const score = x.score ?? x.value ?? x.point ?? x.rank_score ?? x.score_value;
  return { name, score, rank: x.rank, keys: Object.keys(x) };
}

let list = [];
const r = data.listRaw;
if (Array.isArray(r)) list = r;
else if (r && Array.isArray(r.list)) list = r.list;
else if (r && Array.isArray(r.items)) list = r.items;
else if (r && r.data && Array.isArray(r.data)) list = r.data;
else if (r && r.data && Array.isArray(r.data.list)) list = r.data.list;

const lines = [];
lines.push(`rank-status: ${data.rankStatus}`);
lines.push(`myrank: ${data.myrank2 || data.myrank}`);
lines.push(`assets: ${data.assets}`);
lines.push(`titleH: ${data.titleH}`);
lines.push(`PROFILE_NICK: ${data.PROFILE_NICK}`);
lines.push(`GATE: ${JSON.stringify(data.GATE)}`);
lines.push(`support: ${JSON.stringify(data.support)}`);
lines.push(`myRankRaw: ${JSON.stringify(data.myRankRaw)}`);
lines.push('--- top 10 ---');
if (!list.length) {
  lines.push('EMPTY listRaw=');
  lines.push(JSON.stringify(data.listRaw, null, 2));
  lines.push('rank2s=' + JSON.stringify(data.rank2s));
} else {
  list.slice(0, 10).forEach((it, i) => {
    const p = pick(it);
    lines.push(`${i + 1}. ${p.name}  代币 ${p.score}  rank=${p.rank}  keys=${(p.keys || []).join(',')}`);
  });
}
const text = lines.join('\n');
fs.writeFileSync(path.join(scratch, 'board-before.txt'), text, 'utf8');
console.log(text);
process.exit(0);
