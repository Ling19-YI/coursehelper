import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * 冒烟测试：启动 Electron 主进程（占位 renderer），验证
 * preload contextBridge、IPC 三个通道（app:info / license:info / settings:get）、
 * 以及 CDP 端口 9333 可连接。
 */
const require = createRequire(import.meta.url);
const root = process.cwd();
const electronExe = require('electron');
const mainJs = path.join(root, 'app', 'dist', 'main', 'index.js');

if (!existsSync(mainJs)) {
  console.error('请先运行: node scripts/build.mjs');
  process.exit(1);
}

const rendererDir = path.join(root, 'app', 'renderer');
mkdirSync(rendererDir, { recursive: true });
writeFileSync(
  path.join(rendererDir, 'index.html'),
  `<!doctype html><meta charset="utf-8"><body><script>
try {
  window.ch.getAppInfo().then(async info => {
    const lic = await window.ch.licenseInfo();
    const st = await window.ch.getSettings();
    document.title = 'SMOKE_OK ' + JSON.stringify({ v: info.version, legacy: !!info.legacy, lic: !!lic, dd: !!st.dataDir });
  }).catch(e => { document.title = 'SMOKE_ERR ' + e.message; });
} catch (e) { document.title = 'SMOKE_ERR ' + e.message; }
</script></body>`
);

const child = spawn(electronExe, [mainJs], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
});
let log = '';
child.stdout.on('data', d => (log += d.toString()));
child.stderr.on('data', d => (log += d.toString()));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = msg => {
  console.log('FAIL:', msg);
  if (log.trim()) console.log('--- main log ---\n' + log.trim());
  child.kill();
  process.exit(1);
};

const { chromium } = await import('playwright-core');
let browser = null;
for (let i = 0; i < 50 && !browser; i++) {
  await sleep(300);
  if (child.exitCode !== null) fail('electron 过早退出 code=' + child.exitCode);
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  } catch {}
}
if (!browser) fail('CDP 9333 连接失败');

let title = '';
for (let i = 0; i < 40 && !title.startsWith('SMOKE'); i++) {
  await sleep(250);
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      if (p.url().includes('renderer/index.html')) {
        try {
          title = await p.title();
        } catch {}
      }
    }
  }
}
await browser.close().catch(() => {});
child.kill();

if (title.startsWith('SMOKE_OK')) {
  console.log('PASS:', title);
  process.exit(0);
}
fail('renderer 未回报: title=' + JSON.stringify(title));
