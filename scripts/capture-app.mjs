import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

/**
 * 抓取「真实整窗」宣传素材：左边控制台 + 右边真实学习通页面
 * 流程：启动已安装应用 → CDP 驱动 UI → 每个场景调 capture-window.ps1 抓整窗
 *      → 启动一门课的任务，运行中再抓一张 → 停止
 */
const root = process.cwd();
const ps = (name) =>
  execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'capture-window.ps1'), '-Out', name],
    { cwd: root, encoding: 'utf-8' }
  ).trim();

const exe = path.join(process.env.LOCALAPPDATA, 'Programs', 'coursehelper', '刷课助手 CourseHelper.exe');
if (!existsSync(exe)) {
  console.error('app not installed');
  process.exit(1);
}

const app = spawn(exe, [], { stdio: 'ignore' });
const { chromium } = await import('playwright-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let browser = null;
for (let i = 0; i < 50 && !browser; i++) {
  await sleep(300);
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  } catch {}
}
if (!browser) {
  console.error('CDP fail');
  app.kill();
  process.exit(1);
}

const ctx = browser.contexts()[0];
let page = null;
for (let i = 0; i < 40 && !page; i++) {
  await sleep(250);
  page = ctx.pages().find(p => p.url().includes('renderer/index.html')) || null;
}
if (!page) {
  console.error('ui page not found');
  app.kill();
  process.exit(1);
}
page.setDefaultTimeout(60000);

const shot = name => {
  try {
    console.log('  ' + ps(name));
  } catch (e) {
    console.log('  capture failed: ' + name + ' ' + (e.stdout || e.message));
  }
};

const goto = async label => {
  await page.getByText(label, { exact: true }).click();
  await sleep(700);
};

// 1. 任务页
await sleep(2500);
shot('app-1-dashboard');

// 2. 课程页（用「全选」按钮，勾选交互更可靠）
await goto('课程');
await sleep(600);
await page.locator('button:has-text("全选")').click();
await sleep(500);
const selText = await page.evaluate(() => document.body.innerText.match(/已选\s*(\d+)\s*门/)?.[1]);
console.log('selected =', selText);
shot('app-2-courses');

// 3. 设置页
await goto('设置');
await sleep(500);
shot('app-3-settings');

// 4. 真实跑一门课 → 整窗（面板 + 学习通页面同时出现）
await goto('任务');
await page.locator('button:has-text("开始刷课")').click();
console.log('started task, waiting for running...');
let running = false;
const states = [];
for (let i = 0; i < 120; i++) {
  await sleep(1000);
  const st = await page.evaluate(() => window.ch.getState());
  const tag = `${st.state}${st.running ? '*' : ''}`;
  if (states[states.length - 1] !== tag) states.push(tag);
  if (st.state === 'running') {
    running = true;
    break;
  }
  if (st.state === 'error' || st.state === 'done' || st.state === 'stopped') break;
}
console.log('running =', running, '| states:', states.join(' → '));
if (running) {
  await sleep(12000); // 让它进入章节页/视频
  await goto('日志');
  await sleep(500);
  shot('app-4-running');

  // 若右侧已打开超星，再抓一张纯视图
  const view = ctx.pages().find(p => /chaoxing|xuexi/.test(p.url()) && !p.url().includes('renderer'));
  if (view) {
    await view.screenshot({ path: path.join(root, 'promo', 'shots', 'app-5-chaoxing.png') }).catch(() => {});
    console.log('  captured app-5-chaoxing.png');
  }

  await goto('任务');
  await page.locator('button:has-text("停止")').click();
  await sleep(4000);
  shot('app-6-stopped');
}

try { await browser.close(); } catch {}
app.kill();
console.log('DONE');
process.exit(0);