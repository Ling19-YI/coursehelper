import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

/**
 * 真实任务运行验证（走完整 UI 路径）：
 *  启动 → 拉课程 → 勾选1门 → 开始刷课 → 等 running + 日志流动
 *  → 视图页确认超星打开 → 停止 → 确认 stopped
 */
const require = createRequire(import.meta.url);
const root = process.cwd();
const electronExe = require('electron');
const mainJs = path.join(root, 'app', 'dist', 'main', 'index.js');
const licenseFile = path.join(process.env.APPDATA, '刷课助手 CourseHelper', 'license.json');

if (!existsSync(mainJs) || !existsSync(licenseFile)) {
  console.error('需要: npm run build 且已激活（先跑 verify-ui.mjs）');
  process.exit(1);
}

let child = null;
let browser = null;
const fail = msg => {
  console.log('FAIL:', msg);
  try { if (browser) browser.close(); } catch {}
  try { if (child) child.kill(); } catch {}
  process.exit(1);
};

child = spawn(electronExe, [mainJs], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', d => (log += d.toString()));
child.stderr.on('data', d => (log += d.toString()));

const { chromium } = await import('playwright-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));

for (let i = 0; i < 50 && !browser; i++) {
  await sleep(300);
  if (child.exitCode !== null) fail('electron 退出 code=' + child.exitCode + '\n' + log);
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  } catch {}
}
if (!browser) fail('CDP 连接失败\n' + log);

const ctx = browser.contexts()[0];
let page = null;
for (let i = 0; i < 40 && !page; i++) {
  await sleep(250);
  page = ctx.pages().find(p => p.url().includes('renderer/index.html')) || null;
}
if (!page) fail('未找到应用窗口页面');
page.setDefaultTimeout(60000);
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('console', m => {
  if (m.type() === 'error') console.log('[console.error]', m.text());
});

const getState = () => page.evaluate(() => window.ch.getState());

// [1] 课程列表
let courses = [];
try {
  courses = await page.evaluate(() => window.ch.listCourses());
} catch (e) {
  fail('listCourses: ' + e.message);
}
console.log(`[1] 课程 ${courses.length} 门`);

// [2] 勾选「劳动教育观」（有断点进度，续跑最快见效）
await page.getByText('课程', { exact: true }).click();
await sleep(600);
const row = page.locator('.ant-table-row:has-text("劳动教育观")').first();
if ((await row.count()) === 0) fail('未找到目标课程行');
await row.locator('.ant-checkbox-input').check({ force: true });
console.log('[2] 已勾选 劳动教育观');
await page.screenshot({ path: path.join(root, 'app', 'ui-6-selected.png') });

// [3] 开始
await page.getByText('任务', { exact: true }).click();
await sleep(400);
await page.locator('button:has-text("开始刷课")').click();
console.log('[3] 已点击 开始刷课');

// [4] 等 running（含登录+导航，允许 90s）
let st = null;
for (let i = 0; i < 90; i++) {
  await sleep(1000);
  st = (await getState()).state;
  if (st === 'running' || st === 'error') break;
}
console.log('[4] state =', st);
if (st !== 'running') {
  await page.screenshot({ path: path.join(root, 'app', 'ui-7-run-fail.png') });
  fail('未进入 running, state=' + st + '\n' + log.slice(-2500));
}

// [5] 等日志流动 + 章节/视频事件（最多 60s）
let sawChapter = false;
let sawVideo = false;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const snapshot = await page.evaluate(() => ({
    logs: document.querySelectorAll('.log-line').length,
  }));
  if (snapshot.logs >= 3 && !sawChapter) {
    await page.getByText('日志', { exact: true }).click();
    sawChapter = true;
    console.log('[5] 日志流动 OK');
  }
  // 直接查 engine 侧事件累计（renderer 无原生字段，改用 getState 细节判断）
  const s = await getState();
  if (s.running) {
    // 视图页应已打开超星
    const pages = ctx.pages().map(p => p.url());
    if (pages.some(u => u.includes('chaoxing') || u.includes('xuexi'))) {
      sawVideo = true;
      break;
    }
  }
  if (s.state === 'error') fail('运行中出错');
}
await page.screenshot({ path: path.join(root, 'app', 'ui-7-running.png') });

const viewPage = ctx
  .pages()
  .find(p => /chaoxing|xuexi/.test(p.url()) && !p.url().includes('renderer'));
if (viewPage) {
  await viewPage.screenshot({ path: path.join(root, 'app', 'ui-8-view.png') }).catch(() => {});
}
console.log('[5] 视图页超星打开 =', !!viewPage, sawChapter, 'logFlow=', sawChapter);

if (!viewPage) fail('未见超星页面在内嵌视图打开');

// [6] 停止
await page.getByText('任务', { exact: true }).click();
await sleep(300);
await page.locator('button:has-text("停止")').click();
console.log('[6] 已点击 停止');
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  const s = (await getState()).state;
  if (s === 'stopped' || s === 'idle' || s === 'error') {
    console.log('[6] 最终 state =', s);
    break;
  }
}
await page.screenshot({ path: path.join(root, 'app', 'ui-9-stopped.png') });

const final = await getState();
if (final.state === 'running') fail('停止失败，仍在 running');
console.log('PASS state=' + final.state);

try { if (browser) browser.close(); } catch {}
child.kill();
process.exit(0);
