import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';

/**
 * 安装包验证:
 *  1. NSIS 静默安装
 *  2. 启动已安装应用 → CDP 连接 → 确认 UI 加载（生产模式，无 vite）
 *  3. 截图 → 静默卸载
 */
const require = createRequire(import.meta.url);
const root = process.cwd();

const releaseDir = path.join(root, 'release');
if (!existsSync(releaseDir)) {
  console.error('请先运行: npm run dist');
  process.exit(1);
}
const setup = readdirSync(releaseDir).find(f => /^CourseHelper-Setup-.*\.exe$/.test(f));
if (!setup) {
  console.error('未找到安装包');
  process.exit(1);
}
const setupPath = path.join(releaseDir, setup);
console.log('[0] 安装包:', setup);

let child = null;
let browser = null;
const fail = msg => {
  console.log('FAIL:', msg);
  try { if (browser) browser.close(); } catch {}
  try { if (child) child.kill(); } catch {}
  process.exit(1);
};

// [1] 静默安装（默认目录 %LOCALAPPDATA%\Programs\...）
console.log('[1] 静默安装中…');
const inst = spawnSync(setupPath, ['/S'], { stdio: 'ignore', windowsHide: true });
if (inst.status !== 0) fail('安装器退出码 ' + inst.status);

// 找安装目录
const localAppData = process.env.LOCALAPPDATA;
const candidates = [
  path.join(localAppData, 'Programs', '刷课助手 CourseHelper'),
  path.join(localAppData, 'Programs', 'coursehelper'),
];
const installDir = candidates.find(d => existsSync(path.join(d, '刷课助手 CourseHelper.exe')));
if (!installDir) fail('未找到安装目录, candidates=' + candidates.join('; '));
console.log('[1] 安装目录:', installDir);

// [2] 启动
const exe = path.join(installDir, '刷课助手 CourseHelper.exe');
child = spawn(exe, [], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', d => (log += d));
child.stderr.on('data', d => (log += d));

const { chromium } = await import('playwright-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));

for (let i = 0; i < 60 && !browser; i++) {
  await sleep(300);
  if (child.exitCode !== null) fail('应用退出 code=' + child.exitCode + '\n' + log);
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  } catch {}
}
if (!browser) fail('CDP 连接失败\n' + log);
console.log('[2] 应用已启动，CDP 已连接');

const ctx = browser.contexts()[0];
let page = null;
for (let i = 0; i < 40 && !page; i++) {
  await sleep(250);
  page = ctx.pages().find(p => p.url().includes('renderer/index.html')) || null;
}
if (!page) fail('未找到 UI 页面; pages=' + ctx.pages().map(p => p.url()).join(' | '));
page.setDefaultTimeout(60000);

// UI 状态：激活页 或 任务页 都算加载成功（dev userData 共享 → 应为任务页）
let ui = '';
for (let i = 0; i < 40 && !ui; i++) {
  await sleep(500);
  ui = await page.evaluate(() => document.body.innerText.slice(0, 200));
}
await page.screenshot({ path: path.join(root, 'app', 'ui-10-packaged.png') });
console.log('[3] UI 概要:', JSON.stringify(ui.replace(/\n/g, ' | ').slice(0, 160)));

if (!/开始刷课|激活/.test(ui)) fail('UI 未加载到位: ' + ui);

// 生产模式确认：页面是 file:// 且无 vite
if (page.url().startsWith('http://localhost')) fail('走了 dev 模式?!');

try { await browser.close(); } catch {}
child.kill();
console.log('[4] 静默卸载中…');
const unins = readdirSync(installDir).find(f => /^Un.*\.exe$/i.test(f));
if (unins) {
  spawnSync(path.join(installDir, unins), ['/S'], { stdio: 'ignore', windowsHide: true });
  await sleep(2000);
}
console.log(unins ? '[4] 已卸载 ' + unins : '[4] 未发现卸载器（跳过）');
console.log('PASS');
process.exit(0);
