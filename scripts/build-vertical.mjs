import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

/**
 * 竖版（抖音）宣传视频：1080x1920 · 30fps · 30s
 *   promo/vertical/render.html  → 逐帧 → ffmpeg → mp4（可含配音）
 * 用法:
 *   node scripts/build-vertical.mjs            # 渲染 + 合成（若已有配音轨）
 *   SKIP_FRAMES=1 node scripts/build-vertical.mjs
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const promo = path.join(root, 'promo');
const vDir = path.join(promo, 'vertical');
const framesDir = path.join(vDir, 'frames');
const outDir = path.join(vDir, 'out');
const W = 1080, H = 1920, FPS = 30, DUR = 30;
const SCALE = Number(process.env.V_VERTICAL_SCALE || 1);

mkdirSync(outDir, { recursive: true });
const SKIP = process.env.SKIP_FRAMES === '1';
if (!SKIP) {
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });
}

const { chromium } = await import('playwright-core');
if (!SKIP) {
  const browser = await chromium.launch({ args: ['--force-device-scale-factor=1', '--hide-scrollbars'] });
  const page = await browser.newPage({
    viewport: { width: Math.round(W * SCALE), height: Math.round(H * SCALE) },
    deviceScaleFactor: SCALE,
  });
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  await page.goto('file:///' + path.join(vDir, 'render.html').replace(/\\/g, '/'));
  await page.waitForFunction(() => typeof window.seek === 'function');
  // 注入字幕时间轴（与配音同一数据源）
  const syncF = path.join(vDir, 'narration.sync.json');
  const narrF = path.join(vDir, 'narration.json');
  const narration = JSON.parse(readFileSync(existsSync(syncF) ? syncF : narrF, 'utf-8'));
  await page.evaluate(n => {
    window.NARRATION = n.map((x, i, a) => ({
      t0: x.t0,
      t1: x.t1 ?? Math.min((a[i + 1]?.t0 ?? 30) - 0.08, x.t0 + Math.max(1.4, x.text.length / 4.6)),
      text: x.text,
    }));
  }, narration);
  await page.evaluate(() => window.seek(1));
  await page.waitForTimeout(700);

  const total = DUR * FPS;
  const t0 = Date.now();
  for (let i = 0; i < total; i++) {
    await page.evaluate(tt => window.seek(tt), i / FPS);
    await page.screenshot({
      path: path.join(framesDir, `f${String(i).padStart(4, '0')}.jpg`),
      type: 'jpeg',
      quality: 90,
    });
    if (i % 150 === 0) process.stdout.write(`  frame ${i}/${total}\n`);
  }
  await browser.close();
  console.log(`frames done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} else {
  console.log('SKIP_FRAMES=1');
}

// SRT
const syncF = path.join(vDir, 'narration.sync.json');
const narrF = path.join(vDir, 'narration.json');
const narration = JSON.parse(readFileSync(existsSync(syncF) ? syncF : narrF, 'utf-8'));
const ts = s => {
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(Math.floor(s % 60)).padStart(2, '0');
  const ms = String(Math.round((s % 1) * 1000)).padStart(3, '0');
  return `${h}:${m}:${sec},${ms}`;
};
writeFileSync(
  path.join(outDir, 'vertical.srt'),
  narration.map((n, i) => {
    const t1 = n.t1 ?? Math.min((narration[i + 1]?.t0 ?? DUR) - 0.08, n.t0 + Math.max(1.4, n.text.length / 4.6));
    return `${i + 1}\n${ts(+n.t0)} --> ${ts(+t1)}\n${n.text}\n`;
  }).join('\n'),
  'utf-8'
);

// 合成
const mp4 = path.join(outDir, 'coursehelper-vertical-30s.mp4');
const ff = spawnSync('ffmpeg', [
  '-y', '-framerate', String(FPS), '-i', path.join(framesDir, 'f%04d.jpg'),
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart', mp4,
], { stdio: 'inherit' });
if (ff.status !== 0) { console.error('ffmpeg failed'); process.exit(1); }
console.log('video:', mp4);

// 配音合成
const vo = path.join(vDir, 'out', 'voiceover.m4a');
if (existsSync(vo)) {
  const voVideo = path.join(outDir, 'coursehelper-vertical-30s-vo.mp4');
  const mux = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-i', vo, '-c:v', 'copy', '-c:a', 'copy', '-shortest', voVideo], { encoding: 'utf-8' });
  if (mux.status === 0) console.log('video+voice:', voVideo);
  else console.error('voice mux failed:', mux.stderr);
}