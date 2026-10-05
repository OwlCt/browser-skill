import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const scratch = 'C:\\Users\\owlci\\AppData\\Local\\Temp\\grok-goal-0384b3672a03\\implementer';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const context = browser.contexts()[0];
const pages = context.pages();
console.log('pages', pages.map(p => p.url()));
const page = pages[0];
await page.bringToFront();
const profile = await page.evaluate(async () => {
  try {
    const r = await fetch('https://api.bilibili.com/x/space/myinfo', { credentials: 'include' });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    return { error: String(e) };
  }
});
fs.writeFileSync(path.join(scratch, 'myinfo.json'), JSON.stringify(profile, null, 2));
console.log(profile.body ? profile.body.slice(0, 1500) : JSON.stringify(profile));
process.exit(0);
