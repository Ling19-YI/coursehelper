/** 低分辨率抽查若干时间点，快速校验排版（B站正片专用） */
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const promo = path.join(root, 'promo', 'bilibili');
mkdirSync(path.join(promo, 'out'), { recursive: true });

const times = (process.argv[2] || '2,7,10,15,19,23,28,33,40,44,50,54,58,63,68,73').split(',').map(Number);
const narr = JSON.parse((await import('node:fs')).readFileSync(path.join(promo, 'src', 'narration.json'), 'utf-8'));

const { chromium } = await import('playwright-core');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 0.5 });
page.on('pageerror', e => console.error('[pageerror]', e.message));
await page.goto('file:///' + path.join(promo, 'src', 'render.html').replace(/\\/g, '/'));
await page.waitForFunction(() => typeof window.seek === 'function');
await page.evaluate(n => {
  window.NARRATION = n.map((x, i, a) => ({
    t0: x.t0,
    t1: x.t1 ?? Math.min((a[i + 1]?.t0 ?? 75) - 0.1, x.t0 + Math.max(1.6, x.text.length / 4.2)),
    text: x.text,
  }));
}, narr);
await page.evaluate(() => window.seek(1));
await page.waitForTimeout(500);

for (const t of times) {
  const name = await page.evaluate(tt => window.seek(tt), t);
  await page.waitForTimeout(120);
  const f = path.join(promo, 'out', `preview-${String(t).replace('.', '_')}.png`);
  await page.screenshot({ path: f, type: 'png' });
  console.log(`${t}s [${name}] -> ${path.basename(f)}`);
}
await browser.close();
