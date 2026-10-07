import { build } from 'esbuild';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const root = process.cwd();
const results = [];
const ok = (name, pass, detail = '') => results.push({ name, pass, detail });

await build({
  entryPoints: [{ in: 'src/main/spike.ts', out: 'spike' }],
  outdir: 'app/dist',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  logLevel: 'warning',
});

const pageUrl = pathToFileURL(path.join(root, 'src/main/testpage/index.html')).href;
const electronBin = require('electron');
const child = spawn(electronBin, [path.join('app/dist/spike.js'), pageUrl], {
  stdio: ['ignore', 'inherit', 'inherit'],
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForCdp(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:9222/json/version');
      if (res.ok) return true;
    } catch {}
    await sleep(400);
  }
  return false;
}

let browser;
try {
  const up = await waitForCdp();
  ok('CDP 端口 9222 就绪', up, up ? '' : 'timeout');
  if (!up) throw new Error('CDP not up');

  const { chromium } = await import('playwright');
  browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  ok('connectOverCDP 连接', true);

  const pages = browser.contexts().flatMap(c => c.pages());
  ok('发现页面(UI + 课程页)', pages.length >= 2, `pages=${pages.length}: ${pages.map(p => p.url().slice(0, 60)).join(' | ')}`);

  const page = pages.find(p => p.url().includes('index.html'));
  ok('定位测试页面', !!page, page ? page.url() : 'not found');
  if (!page) throw new Error('no test page');

  await sleep(800);
  const frames = page.frames();
  ok('frames() 嵌套遍历(>=3)', frames.length >= 3, `frames=${frames.length}: ${frames.map(f => f.url().split('/').pop()).join(',')}`);

  const f2 = frames.find(f => f.url().includes('frame2.html'));
  ok('定位嵌套 iframe(frame2)', !!f2);
  if (!f2) throw new Error('no frame2');

  const diag = await page.evaluate(() => ({
    title: document.title,
    w: innerWidth,
    ua: navigator.userAgent.includes('Chrome'),
  }));
  ok('主框架 evaluate', diag.title === 'spike-index' && diag.ua, JSON.stringify(diag));

  await sleep(2200);
  const phaseA = await f2.evaluate(() => ({
    paused: document.getElementById('v').paused,
    ct: document.getElementById('v').currentTime,
    state: document.getElementById('state').textContent,
  }));
  ok('平台模拟暂停生效(无 ticker)', phaseA.paused === true, phaseA.state);

  const TICKER = `(() => {
    if (window.__chTicker) return 'already';
    window.__chTicker = setInterval(() => {
      const v = document.querySelector('video');
      if (v && v.paused && v.readyState >= 2) v.play().catch(() => {});
      window.dispatchEvent(new Event('mousemove'));
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('mouseenter'));
    }, 300);
    return 'started';
  })()`;
  const t = await f2.evaluate(TICKER);
  ok('注入 keep-alive ticker', t === 'started', t);

  const before = await f2.evaluate(() => document.getElementById('v').currentTime);
  await sleep(2600);
  const after = await f2.evaluate(() => ({
    ct: document.getElementById('v').currentTime,
    paused: document.getElementById('v').paused,
    state: document.getElementById('state').textContent,
  }));
  ok('ticker 对抗暂停后视频前进', after.ct > before + 1.5, `ct ${before.toFixed(2)} -> ${after.ct.toFixed(2)} (${after.state})`);

  await page.mouse.move(120, 90);
  await page.mouse.move(300, 240);
  ok('page.mouse.move (CDP Input)', true);

  const btnProbe = await page.evaluate(() => {
    const el = document.getElementById('main-status');
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return el.textContent;
  });
  ok('事件派发', btnProbe === 'main ok', btnProbe);

  await page.screenshot({ path: path.join(root, 'app/spike-page.png') });
  ok('page.screenshot', true, 'app/spike-page.png');

  const viewDiag = await f2.evaluate(() => ({
    ct: document.getElementById('v').currentTime,
    paused: document.getElementById('v').paused,
  }));
  ok('最终状态仍在播放', viewDiag.paused === false, `ct=${viewDiag.ct.toFixed(2)}`);
} catch (e) {
  ok('spike 未抛异常', false, String(e && e.message || e));
} finally {
  try {
    if (browser) browser.close();
  } catch {}
  try {
    execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {}
}

console.log('\n=== SPIKE 结果 ===');
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
const failed = results.filter(r => !r.pass);
console.log(failed.length ? `\n${failed.length} 项失败` : '\n全部通过');
process.exit(failed.length ? 1 : 0);
