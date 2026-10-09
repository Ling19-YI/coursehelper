import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

/**
 * 片头故事视频：黑底打字机 + 曼波口播
 *   promo/vertical/story.html  → 逐帧 → ffmpeg → mp4
 * 用法:
 *   node scripts/build-story.mjs            # 渲染并合成配音
 *   SKIP_FRAMES=1 node scripts/build-story.mjs
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vDir = path.join(root, 'promo', 'vertical');
const framesDir = path.join(vDir, 'story-frames');
const outDir = path.join(vDir, 'out');
mkdirSync(outDir, { recursive: true });
const SKIP = process.env.SKIP_FRAMES === '1';

// 总时长 = 最后一���结束 + 2.5s 留白
const sync = JSON.parse(readFileSync(path.join(vDir, 'story.sync.json'), 'utf-8'));
const DUR = Math.ceil((sync[sync.length - 1].t1 + 2.6) * 10) / 10;
const FPS = 30;

if (!SKIP) {
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ args: ['--force-device-scale-factor=1', '--hide-scrollbars'] });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  await page.goto('file:///' + path.join(vDir, 'story.html').replace(/\\/g, '/'));
  await page.waitForFunction(() => typeof window.seek === 'function');
  await page.evaluate(list => { window.STORY = list; }, sync);
  await page.evaluate(() => window.seek(0));
  await page.waitForTimeout(400);

  const total = Math.round(DUR * FPS);
  for (let i = 0; i < total; i++) {
    await page.evaluate(t => window.seek(t), i / FPS);
    await page.screenshot({ path: path.join(framesDir, `f${String(i).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 92 });
    if (i % 150 === 0) process.stdout.write(`  frame ${i}/${total}\n`);
  }
  await browser.close();
  console.log(`frames done (${total})`);
} else {
  console.log('SKIP_FRAMES=1');
}

const mp4 = path.join(outDir, 'coursehelper-story-intro.mp4');
const ff = spawnSync('ffmpeg', [
  '-y', '-framerate', String(FPS), '-i', path.join(framesDir, 'f%04d.jpg'),
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4,
], { stdio: 'inherit' });
if (ff.status !== 0) { console.error('ffmpeg failed'); process.exit(1); }
console.log('无声版:', mp4);

const vo = path.join(outDir, 'story-voiceover.m4a');
if (existsSync(vo)) {
  const withVo = path.join(outDir, 'coursehelper-story-intro-vo.mp4');
  const mux = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-i', vo, '-c:v', 'copy', '-c:a', 'copy', '-shortest', withVo], { encoding: 'utf-8' });
  if (mux.status === 0) console.log('成片:', withVo);
  else console.error('配音合成失败:', mux.stderr);
}

// SRT（外挂字幕）
const ts = s => {
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(Math.floor(s % 60)).padStart(2, '0');
  const ms = String(Math.round((s % 1) * 1000)).padStart(3, '0');
  return `${h}:${m}:${sec},${ms}`;
};
writeFileSync(
  path.join(outDir, 'story.srt'),
  sync.map((s, i) => `${i + 1}\n${ts(s.t0)} --> ${ts(s.t1)}\n${s.text}\n`).join('\n'),
  'utf-8'
);
console.log(`时长 ${DUR.toFixed(1)}s`);