import { chromium } from 'playwright-core';
import fs from 'node:fs';

const scratch = 'C:\\Users\\owlci\\AppData\\Local\\Temp\\grok-goal-0384b3672a03\\implementer';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts()[0].pages()[0];

const parentInfo = await page.evaluate(() => {
  const keys = Object.keys(window).filter(k => /toy|Toy|host|rank|sdk/i.test(k));
  const info = { keys };
  for (const k of ['ToyHost', 'toyHost', '__TOY_META__', '__toyInstall']) {
    const v = window[k];
    info[k] = v && typeof v === 'object' ? { type: typeof v, keys: Object.keys(v).slice(0, 40), proto: Object.getOwnPropertyNames(Object.getPrototypeOf(v) || {}).slice(0, 40) } : typeof v;
  }
  const scripts = [...document.querySelectorAll('script[src]')].map(s => s.src);
  return { ...info, scripts, href: location.href };
});
fs.writeFileSync(scratch + '\\host-info.json', JSON.stringify(parentInfo, null, 2), 'utf8');
console.log(JSON.stringify(parentInfo, null, 2));
process.exit(0);
