import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

/**
 * 宣传视频渲染：
 *  promo/src/render.html 提供 window.seek(t) 逐帧状态
 *  → Playwright 无头渲染 30fps 帧 → ffmpeg 合成 mp4（字幕已烧进画面）
 *  → 同时输出 promo/out/promo.srt
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const promo = path.join(root, 'promo');
const framesDir = path.join(promo, 'frames');
const outDir = path.join(promo, 'out');
const FPS = 30;
const DUR = 30;
const SCALE = Number(process.env.PROMO_SCALE || 1); // 1 = 1920x1080

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
    viewport: { width: Math.round(1920 * SCALE), height: Math.round(1080 * SCALE) },
    deviceScaleFactor: SCALE,
  });
  page.on('pageerror', e => console.error('[pageerror]', e.message));

  await page.goto('file:///' + path.join(promo, 'src', 'render.html').replace(/\\/g, '/'));
  await page.waitForFunction(() => typeof window.seek === 'function');
  // 注入字幕时间轴（与配音同一数据源）
  const syncFile0 = path.join(promo, 'src', 'narration.sync.json');
  const narrFile0 = path.join(promo, 'src', 'narration.json');
  const narration0 = JSON.parse(readFileSync(existsSync(syncFile0) ? syncFile0 : narrFile0, 'utf-8'));
  await page.evaluate(n => {
    window.NARRATION = n.map((x, i, a) => ({
      t0: x.t0,
      t1: x.t1 ?? Math.min((a[i + 1]?.t0 ?? 30) - 0.1, x.t0 + Math.max(1.6, x.text.length / 4.2)),
      text: x.text,
    }));
  }, narration0);
  // 预热字体/图片
  await page.evaluate(() => window.seek(1));
  await page.waitForTimeout(600);

  const total = DUR * FPS;
  const t0 = Date.now();
  for (let i = 0; i < total; i++) {
    const t = i / FPS;
    await page.evaluate(tt => window.seek(tt), t);
    const f = path.join(framesDir, `f${String(i).padStart(4, '0')}.jpg`);
    await page.screenshot({ path: f, type: 'jpeg', quality: 92 });
    if (i % 150 === 0) process.stdout.write(`  frame ${i}/${total}\n`);
  }
  await browser.close();
  console.log(`frames done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} else {
  console.log('SKIP_FRAMES=1 → 复用已有帧');
}

// SRT（优先用配音后写出的 narration.sync.json，保证字幕与语音同步）
const syncFile = path.join(promo, 'src', 'narration.sync.json');
const narrFile = path.join(promo, 'src', 'narration.json');
const narration = JSON.parse(
  readFileSync(existsSync(syncFile) ? syncFile : narrFile, 'utf-8')
);
const estEnd = (n, i, arr) => n.t1 ?? Math.min((arr[i + 1]?.t0 ?? DUR) - 0.1, n.t0 + Math.max(1.6, n.text.length / 4.2));
const ts = s => {
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(Math.floor(s % 60)).padStart(2, '0');
  const ms = String(Math.round((s % 1) * 1000)).padStart(3, '0');
  return `${h}:${m}:${sec},${ms}`;
};
writeFileSync(
  path.join(outDir, 'promo.srt'),
  narration
    .map((n, i) => `${i + 1}\n${ts(+n.t0)} --> ${ts(+estEnd(n, i, narration))}\n${n.text}\n`)
    .join('\n'),
  'utf-8'
);
console.log(`srt: ${narration.length} lines (${existsSync(syncFile) ? 'synced with voice' : 'estimated'})`);

// 合成
const mp4 = path.join(outDir, 'coursehelper-promo-30s.mp4');
const args = [
  '-y',
  '-framerate', String(FPS),
  '-i', path.join(framesDir, 'f%04d.jpg'),
  '-c:v', 'libx264',
  '-preset', 'medium',
  '-crf', '20',
  '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart',
  mp4,
];
const ff = spawnSync('ffmpeg', args, { stdio: 'inherit' });
if (ff.status !== 0) {
  console.error('ffmpeg failed');
  process.exit(1);
}
console.log('video:', mp4);

// 若配音轨已存在（先跑 build-voice.mjs），自动合成带配音版
const voTrack = path.join(outDir, 'voiceover.m4a');
if (existsSync(voTrack)) {
  const voVideo = path.join(outDir, 'coursehelper-promo-30s-vo.mp4');
  const mux = spawnSync(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-i', mp4, '-i', voTrack, '-c:v', 'copy', '-c:a', 'copy', '-shortest', voVideo],
    { encoding: 'utf-8' }
  );
  if (mux.status === 0) console.log('video+voice:', voVideo);
  else console.error('voice mux failed:', mux.stderr);
}