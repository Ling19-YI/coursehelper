import { mkdirSync } from 'node:fs';
import * as path from 'node:path';

/** 低分辨率抽查若干时间点，快速校验排版 */
const root = process.cwd();
const promo = path.join(root, 'promo');
mkdirSync(path.join(promo, 'out'), { recursive: true });

const times = (process.argv[2] || '1,4,8,13,17,21,25,29').split(',').map(Number);

const { chromium } = await import('playwright-core');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 0.5 });
page.on('pageerror', e => console.error('[pageerror]', e.message));
await page.goto('file:///' + path.join(promo, 'src', 'render.html').replace(/\\/g, '/'));
await page.waitForFunction(() => typeof window.seek === 'function');

for (const t of times) {
  const name = await page.evaluate(tt => window.seek(tt), t);
  await page.waitForTimeout(120);
  const f = path.join(promo, 'out', `preview-${String(t).replace('.', '_')}.png`);
  await page.screenshot({ path: f, type: 'png' });
  console.log(`${t}s [${name}] -> ${path.basename(f)}`);
}
await browser.close();