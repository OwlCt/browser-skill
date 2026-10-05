import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const scratch = 'C:\\Users\\owlci\\AppData\\Local\\Temp\\grok-goal-0384b3672a03\\implementer';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const context = browser.contexts()[0];
const pages = context.pages();
const report = { pages: [] };

for (const p of pages) {
  const frames = p.frames().map(f => ({ url: f.url(), name: f.name() }));
  report.pages.push({ url: p.url(), title: await p.title(), frames });
}

const page = pages.find(p => p.url().includes('xujiayin-blank')) || pages[0];
await page.bringToFront();
await page.waitForTimeout(2000);

function walkFrames(p) {
  return p.frames();
}

const allFrames = walkFrames(page);
const frame = allFrames.find(f => f.url().includes('bilibilitoy.com'))
  || allFrames.find(f => f.url().includes('xujiayin'))
  || page.mainFrame();

let info = { frameUrl: frame.url() };
try {
  info = await frame.evaluate(() => {
    const $ = (id) => document.getElementById(id);
    const text = (id) => ($ (id) ? $(id).innerText : null);
    const T = window.T || window.toyHost || window.ToyHost || null;
    return {
      href: location.href,
      title: document.title,
      startHidden: $('start') ? $('start').classList.contains('hide') : null,
      overHidden: $('over') ? $('over').classList.contains('hide') : null,
      rankHidden: $('rank') ? $('rank').classList.contains('hide') : null,
      rankStatus: text('rank-status'),
      myrank: text('myrank-line'),
      myrank2: text('myrank-line2'),
      saveHint: text('save-hint'),
      assetsH: text('assets-h'),
      titleH: text('title-h'),
      rankHtml: $('rank2') ? $('rank2').innerText : null,
      rankSdk: $('rank-sdk') ? $('rank-sdk').innerText : ($('rank1') ? $('rank1').innerText : null),
      bodySnippet: (document.body && document.body.innerText || '').slice(0, 2500),
      GATE: typeof GATE === 'undefined' ? null : GATE,
      PROFILE_NICK: typeof PROFILE_NICK === 'undefined' ? null : PROFILE_NICK,
      ME: typeof ME === 'undefined' ? null : ME,
      assets: typeof assets === 'undefined' ? null : assets,
      hasT: typeof T === 'function',
    };
  });
} catch (e) {
  info.evalError = String(e);
  info.frameUrl = frame.url();
}

await page.screenshot({ path: path.join(scratch, 'gate-now.png') });
const out = { report, info, frameUrl: frame.url(), pageUrl: page.url() };
fs.writeFileSync(path.join(scratch, 'inspect.json'), JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify(out, null, 2));
process.exit(0);
