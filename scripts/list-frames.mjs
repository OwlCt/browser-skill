import { chromium } from 'playwright-core';
import fs from 'node:fs';

const scratch = 'C:\\Users\\owlci\\AppData\\Local\\Temp\\grok-goal-0384b3672a03\\implementer';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const out = { contexts: [] };
for (const context of browser.contexts()) {
  const c = { pages: [] };
  for (const p of context.pages()) {
    const frames = [];
    for (const f of p.frames()) {
      let snippet = null, err = null;
      try { snippet = await f.evaluate(() => (document.body && document.body.innerText || '').slice(0, 400)); }
      catch (e) { err = String(e); }
      frames.push({ url: f.url(), name: f.name(), snippet, err });
    }
    c.pages.push({ url: p.url(), title: await p.title(), frames });
  }
  out.contexts.push(c);
}
fs.writeFileSync(scratch + '\\frames.json', JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify(out, null, 2));
process.exit(0);
