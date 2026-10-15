/**
 * 生成应用图标（build/icon.svg + build/icon.png）。
 *
 * 不用 AI 生图：「课」字笔画密集，生成模型容易糊、还会自发加装饰。
 * 也不用 ffmpeg —— 常见的 ffmpeg 发行版不带 SVG 解码器。
 * 这里用 Playwright（项目已有）把 SVG 栅格化，字形与排版完全可控。
 *
 * 与旧图标保持同一套设计语言（蓝紫渐变 + 大圆角 + 居中白色单字），
 * 只是把「刷」换成「课」——用户升级后靠轮廓和配色认得出是同一个软件。
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(root, 'build');
if (!existsSync(buildDir)) mkdirSync(buildDir, { recursive: true });

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#3b82f6"/>
      <stop offset="100%" stop-color="#8b5cf6"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="512" height="512" rx="112" fill="url(#g)"/>
  <text x="256" y="256" font-family="Microsoft YaHei, PingFang SC, Noto Sans SC, sans-serif"
        font-size="300" font-weight="700" fill="#ffffff"
        text-anchor="middle" dominant-baseline="central">课</text>
</svg>`;

const svgPath = path.join(buildDir, 'icon.svg');
const pngPath = path.join(buildDir, 'icon.png');
writeFileSync(svgPath, svg, 'utf-8');

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 512, height: 512 },
    deviceScaleFactor: 1,
  });
  // 用 about:blank + inline SVG，避免 file:// 的加载时序问题
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8">
     <style>html,body{margin:0;padding:0;width:512px;height:512px;overflow:hidden}</style>
     </head><body>${svg}</body></html>`,
    { waitUntil: 'load' }
  );
  await page.waitForTimeout(300); // 等字体就绪
  await page.screenshot({ path: pngPath, omitBackground: true });
} finally {
  await browser.close();
}

const size = readFileSync(pngPath).length;
console.log(`✓ build/icon.svg 与 build/icon.png 已更新（512×512，「课」字，${(size / 1024).toFixed(1)} KB）`);

// electron-builder 在 Windows 上优先用 build/icon.ico。
// 有则必须重新导出，否则会一直沿用旧图。
const icoPath = path.join(buildDir, 'icon.ico');
if (existsSync(icoPath)) {
  console.log('⚠ 发现 build/icon.ico —— 可能是旧图，electron-builder 会优先用它。');
  console.log('  请手动重新导出 ICO，或删除它让构建器从 PNG 生成。');
}