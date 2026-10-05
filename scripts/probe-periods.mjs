import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const scratch = 'C:\\Users\\owlci\\AppData\\Local\\Temp\\grok-goal-0384b3672a03\\implementer';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts()[0].pages()[0];
const frames = page.frames();
let frame = frames[0];
for (const f of frames) {
  try { if (await f.evaluate(() => !!window.toy)) { frame = f; break; } } catch {}
}

const result = await frame.evaluate(async () => {
  const t = window.toy;
  const out = {};
  for (const board of [1, 2, 3]) {
    out['board'+board] = {};
    for (const period of [undefined, 'all', 'month', 'week', 'day']) {
      const key = String(period);
      try {
        const list = await t.getRankList({ board, limit: 5, period });
        const mine = await t.getMyRank({ board, period });
        const top = (Array.isArray(list) ? list : (list && list.list) || []).slice(0, 5)
          .map(x => ({ rank: x.rank, score: x.score, nickname: x.nickname }));
        out['board'+board][key] = { mine, top };
      } catch (e) {
        out['board'+board][key] = { error: String(e) };
      }
    }
  }
  return out;
});
fs.writeFileSync(path.join(scratch, 'periods.json'), JSON.stringify(result, null, 2), 'utf8');
console.log(JSON.stringify(result, null, 2));
process.exit(0);
