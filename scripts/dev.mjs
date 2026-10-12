import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, copyFileSync } from 'node:fs';
import { context } from 'esbuild';
import { esbuildOptions } from './esbuild-config.mjs';

/**
 * 开发循环: vite dev server + esbuild watch + electron
 *   npm run dev
 */
const require = createRequire(import.meta.url);
const electronExe = require('electron');

// 显式用 127.0.0.1，不要写 localhost。
//
// 踩过的坑：vite 在 Windows 上默认只绑 IPv6 的 ::1。而 waitVite() 用 Node 的
// fetch 探测，localhost 会解析成 ::1 —— 于是它判定「vite 已就绪」；但
// Electron 的 Chromium 走的是 127.0.0.1（IPv4），连接被拒，表现为
//   [main] 创建窗口失败: Error: ERR_FAILED (-2) loading 'http://localhost:5173'
// 而日志里 vite 明明 ready、端口也空着，极难定位。
// 显式指定 host 后两边必然同一地址；--strictPort 保证端口被占时直接报错，
// 而不是悄悄换到 5174 让 DEV_URL 失配。
const DEV_HOST = '127.0.0.1';
const DEV_PORT = 5173;
const DEV_URL = `http://${DEV_HOST}:${DEV_PORT}`;

mkdirSync('app/dist', { recursive: true });
copyFileSync('node_modules/playwright-core/package.json', 'app/dist/package.json');
copyFileSync('node_modules/playwright-core/browsers.json', 'app/dist/browsers.json');

const vite = spawn(
  'npx',
  ['vite', '--host', DEV_HOST, '--port', String(DEV_PORT), '--strictPort'],
  { stdio: 'inherit', shell: true }
);
const ctx = await context(esbuildOptions);
await ctx.watch();

async function waitVite() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(DEV_URL);
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

if (!(await waitVite())) {
  console.error('vite 启动超时');
  process.exit(1);
}

// 必须摘掉 ELECTRON_RUN_AS_NODE：带着它 electron.exe 会以纯 Node 模式启动，
// require('electron') 返回的是可执行文件路径字符串而不是 API，
// 于是 app.isPackaged 直接抛
//   TypeError: Cannot read properties of undefined (reading 'isPackaged')
// ——报错完全看不出真因，排查成本很高。
// 从 Electron 应用（VS Code 扩展、各类编辑器/Agent 宿主）里起的终端常带着这个变量。
const devEnv = { ...process.env, VITE_DEV_SERVER_URL: DEV_URL };
delete devEnv.ELECTRON_RUN_AS_NODE;

// 允许透传额外的 Electron 开关，例如无 GPU 的环境要 --disable-gpu。
// 默认不传，不影响正常开发机的硬件加速。
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || '').split(/\s+/).filter(Boolean);
if (extraArgs.length) console.log('[dev] Electron 额外参数:', extraArgs.join(' '));

const electron = spawn(electronExe, [...extraArgs, 'app/dist/main/index.js'], {
  stdio: 'inherit',
  env: devEnv,
});

function shutdown() {
  electron.kill();
  vite.kill();
  ctx.dispose();
  process.exit(0);
}
electron.on('exit', shutdown);
process.on('SIGINT', shutdown);
