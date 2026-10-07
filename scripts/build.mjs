import { build } from 'esbuild';
import { mkdirSync, copyFileSync } from 'node:fs';
import { esbuildOptions } from './esbuild-config.mjs';

mkdirSync('app/dist', { recursive: true });

// playwright-core 运行时按 __dirname/.. 读取自身信息
copyFileSync('node_modules/playwright-core/package.json', 'app/dist/package.json');
copyFileSync('node_modules/playwright-core/browsers.json', 'app/dist/browsers.json');

const watch = process.argv.includes('--watch');

const ctx = await import('esbuild').then(es => es.context(esbuildOptions));

if (watch) {
  await ctx.watch();
  console.log('[build] watching...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
