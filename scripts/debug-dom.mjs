import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const root = process.cwd();
const electronExe = require('electron');
const mainJs = path.join(root, 'app', 'dist', 'main', 'index.js');
if (!existsSync(mainJs)) { console.error('build first'); process.exit(1); }

const child = spawn(electronExe, [mainJs], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', d => (log += d));
child.stderr.on('data', d => (log += d));

const { chromium } = await import('playwright-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let browser = null;
for (let i = 0; i < 50 && !browser; i++) {
  await sleep(300);
  try { browser = await chromium.connectOverCDP('http://127.0.0.1:9333'); } catch {}
}
if (!browser) { console.log('no cdp\n' + log); process.exit(1); }

const ctx = browser.contexts()[0];
let page = null;
for (let i = 0; i < 40 && !page; i++) {
  await sleep(250);
  page = ctx.pages().find(p => p.url().includes('renderer/index.html')) || null;
}
if (!page) { console.log('no page'); child.kill(); process.exit(1); }

console.log('pages:', ctx.pages().map(p => p.url()));
const info = await page.evaluate(() => ({
  buttons: Array.from(document.querySelectorAll('button')).map(b => ({
    text: b.innerText,
    disabled: b.disabled,
    cls: b.className.slice(0, 60),
  })),
  inputs: Array.from(document.querySelectorAll('input')).map(i => ({
    ph: i.placeholder,
    type: i.type,
  })),
}));
console.log(JSON.stringify(info, null, 1));

const c1 = await page.locator('button:has-text("激活")').count();
console.log('count button:has-text(激活) =', c1);
const c2 = await page.locator('.ant-btn').count();
console.log('count .ant-btn =', c2);

const html = await page.evaluate(() => {
  const b = document.querySelector('.ant-btn');
  return b ? b.outerHTML : 'none';
});
console.log('btn html:', html);
const textContent = await page.evaluate(() => {
  const b = document.querySelector('.ant-btn');
  return JSON.stringify({ tc: b && b.textContent, it: b && b.innerText });
});
console.log('text:', textContent);

await browser.close().catch(() => {});
child.kill();
process.exit(0);
