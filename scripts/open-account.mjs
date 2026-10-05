import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const scratch = 'C:\\Users\\owlci\\AppData\\Local\\Temp\\grok-goal-0384b3672a03\\implementer';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const context = browser.contexts()[0];
const page = await context.newPage();
await page.goto('https://account.bilibili.com/account/info', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(2500);
const info = {
  url: page.url(),
  title: await page.title(),
  text: (await page.locator('body').innerText().catch(() => '')).slice(0, 3000),
};
await page.screenshot({ path: path.join(scratch, 'account-info.png'), fullPage: false });
fs.writeFileSync(path.join(scratch, 'account-info.json'), JSON.stringify(info, null, 2), 'utf8');
console.log(JSON.stringify({ url: info.url, title: info.title, text: info.text.slice(0, 1800) }, null, 2));
process.exit(0);
