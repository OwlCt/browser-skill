import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const scratch = 'C:\\Users\\owlci\\AppData\\Local\\Temp\\grok-goal-0384b3672a03\\implementer';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const context = browser.contexts()[0];
const page = context.pages()[0];
await page.bringToFront();
page.setDefaultTimeout(15000);
await page.goto('https://space.bilibili.com/34976600', { waitUntil: 'commit', timeout: 20000 });
await page.waitForTimeout(3000);
const info = {
  url: page.url(),
  title: await page.title(),
  text: (await page.locator('body').innerText().catch(() => '')).slice(0, 2500),
};
await page.screenshot({ path: path.join(scratch, 'space.png') });
fs.writeFileSync(path.join(scratch, 'space.json'), JSON.stringify(info, null, 2));
console.log(JSON.stringify({ url: info.url, title: info.title, text: info.text.slice(0, 2000) }, null, 2));
process.exit(0);
