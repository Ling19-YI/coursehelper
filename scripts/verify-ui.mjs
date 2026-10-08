import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';

/**
 * 端到端验证:
 *  1. 启动正式构建的 Electron 主进程
 *  1. 启动后首屏应直接是任务页（免费版无激活页）→ 截图
 *  2. 关于页应包含微信收款码
 *  3. window.ch.listCourses() 真实登录超星 → 返回课程列表
 *  4. 逐页截图
 */
const require = createRequire(import.meta.url);
const root = process.cwd();
const electronExe = require('electron');
const mainJs = path.join(root, 'app', 'dist', 'main', 'index.js');
const shotDir = path.join(root, 'app');
mkdirSync(shotDir, { recursive: true });

if (!existsSync(mainJs) || !existsSync(path.join(root, 'app', 'renderer', 'index.html'))) {
  console.error('请先运行: npm run build');
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
let appPage = null;
for (let i = 0; i < 40 && !appPage; i++) {
  await sleep(250);
  appPage = ctx.pages().find(p => p.url().includes('renderer/index.html')) || null;
}
if (!appPage) fail('未找到应用窗口页面\n' + log);
appPage.setDefaultTimeout(120000);
appPage.on('pageerror', e => console.log('[pageerror]', e.message));
appPage.on('console', m => {
  if (m.type() === 'error') console.log('[console.error]', m.text());
});

// 首屏应直接进入任务页（免费版，无激活页）
try {
  await appPage.waitForSelector('text=开始刷课', { timeout: 25000 });
} catch {
  const t = await appPage.evaluate(() => document.body.innerText);
  await appPage.screenshot({ path: path.join(shotDir, 'ui-2a-fail.png') });
  fail('首屏未进入任务页, body=' + JSON.stringify(t.slice(0, 400)));
}
console.log('[1] 首屏直接进入任务页（免费版，无激活页）');

await appPage.screenshot({ path: path.join(shotDir, 'ui-2-dashboard.png') });
console.log('[2] 任务页截图 ui-2-dashboard.png');

// 「关于」页应包含支持作者收款码
await appPage.getByText('关于', { exact: true }).click();
await sleep(700);
const hasQr = await appPage.locator('img[alt="微信收款码"]').count();
console.log('[3] 关于页收款码数量:', hasQr);
await appPage.screenshot({ path: path.join(shotDir, 'ui-6-about.png') });
if (!hasQr) fail('关于页缺少微信收款码');
await appPage.getByText('任务', { exact: true }).click();
await sleep(500);

// 真实拉取课程列表（内嵌视图登录）
console.log('[4] 正在登录超星并拉取课程列表…');
let courses = [];
try {
  courses = await appPage.evaluate(() => window.ch.listCourses());
} catch (e) {
  console.log('listCourses 报错:', e.message);
}
console.log(`    课程数: ${courses.length}`);
if (!courses.length) {
  await appPage.screenshot({ path: path.join(shotDir, 'ui-5-fail.png') });
  fail('课程列表为空\nmain log:\n' + log.slice(-3000));
}

// 切到课程页
await appPage.getByText('课程', { exact: true }).click();
await sleep(800);
await appPage.screenshot({ path: path.join(shotDir, 'ui-3-courses.png') });
console.log('[5] 课程页截图 ui-3-courses.png');

// 设置页
await appPage.getByText('设置', { exact: true }).click();
await sleep(500);
await appPage.screenshot({ path: path.join(shotDir, 'ui-4-settings.png') });
console.log('[6] 设置页截图 ui-4-settings.png');

// 日志页
await appPage.getByText('日志', { exact: true }).click();
await sleep(300);
await appPage.screenshot({ path: path.join(shotDir, 'ui-5-monitor.png') });
console.log('[7] 日志页截图 ui-5-monitor.png');

await browser.close().catch(() => {});
child.kill();
console.log('PASS');
process.exit(0);
