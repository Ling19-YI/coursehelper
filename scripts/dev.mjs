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
const DEV_URL = 'http://localhost:5173';

mkdirSync('app/dist', { recursive: true });
copyFileSync('node_modules/playwright-core/package.json', 'app/dist/package.json');
copyFileSync('node_modules/playwright-core/browsers.json', 'app/dist/browsers.json');

const vite = spawn('npx', ['vite'], { stdio: 'inherit', shell: true });
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

const electron = spawn(electronExe, ['app/dist/main/index.js'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: DEV_URL },
});

function shutdown() {
  electron.kill();
  vite.kill();
  ctx.dispose();
  process.exit(0);
}
electron.on('exit', shutdown);
process.on('SIGINT', shutdown);
