/**
 * B站正片配音（Edge TTS · M3）
 *
 * 1. 读 promo/bilibili/src/narration.json（唯一数据源）
 * 2. 每句调 edge-tts（zh-CN-XiaoxiaoNeural，rate +8%）生成单句 mp3
 * 3. ffprobe 量真实时长 → 依序排时间轴（句间停顿 0.35s，不早于原计划 t0）
 *    → 写 narration.sync.json（字幕/画面同步的唯一数据源）
 * 4. ffmpeg adelay + amix 混成 voiceover.m4a（build-bili-promo 自动合入成片）
 *
 * 前置：edge-tts 已装进受管 venv（scripts/capture-bili-shots.mjs 头注释有路径）。
 * 用法：node scripts/build-bili-voice.mjs [--rate +8%]
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const PY = 'C:\\Users\\colorful\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const promo = path.join(root, 'promo', 'bilibili');
const src = path.join(promo, 'src');
const voiceDir = path.join(promo, 'voice');
const outDir = path.join(promo, 'out');
const rate = process.argv.includes('--rate') ? process.argv[process.argv.indexOf('--rate') + 1] : '+8%';
mkdirSync(voiceDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const narration = JSON.parse(readFileSync(path.join(src, 'narration.json'), 'utf-8'));

const probe = f => {
  const r = spawnSync('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf-8' });
  return parseFloat(r.stdout.trim());
};

/* 1+2：逐句生成 */
const clips = [];
for (let i = 0; i < narration.length; i++) {
  const n = narration[i];
  const f = path.join(voiceDir, `line-${String(i).padStart(2, '0')}.mp3`);
  if (!existsSync(f) || process.env.REVOICE === '1') {
    const r = spawnSync(PY, ['-m', 'edge_tts', '--voice', 'zh-CN-XiaoxiaoNeural', `--rate=${rate}`, '--text', n.text, '--write-media', f], { encoding: 'utf-8', timeout: 120000 });
    if (r.status !== 0 || !existsSync(f)) {
      console.error(`✗ 第 ${i + 1} 句生成失败:`, (r.stderr || r.stdout || '').slice(-300));
      process.exit(1);
    }
  }
  const dur = probe(f);
  clips.push({ i, f, dur });
  console.log(`  ${i + 1}/${narration.length}  ${dur.toFixed(2)}s  ${n.text.slice(0, 24)}…`);
}

/* 3：排时间轴（句间 0.35s，且不早于原计划 t0 —— 跟场景对齐） */
const GAP = 0.35;
let cursor = 0;
const sync = clips.map((c, k) => {
  const start = Math.max(cursor, narration[k].t0);
  cursor = start + c.dur + GAP;
  return { t0: +start.toFixed(3), t1: +(start + c.dur).toFixed(3), text: narration[k].text };
});
writeFileSync(path.join(src, 'narration.sync.json'), JSON.stringify(sync, null, 2), 'utf-8');
console.log(`\nsync: narration.sync.json（末句结束 ${sync[sync.length - 1].t1.toFixed(1)}s）`);

/* 4：混音（adelay 各句 + amix 叠加），并补静音到画面全长。
   为什么要 apad：成片用 -shortest 合流，音轨短一截就会把片尾（结尾卡）削掉。
   这里补到 DUR+1s，片尾安静收尾，不会被切。 */
const DUR = 75;
const total = Math.max(sync[sync.length - 1].t1 + 1.2, DUR + 1);
const inputs = clips.flatMap(c => ['-i', c.f]);
const delays = clips.map((c, k) => `[${k}:a]adelay=${Math.round(sync[k].t0 * 1000)}|${Math.round(sync[k].t0 * 1000)}[d${k}]`);
const mix = `${clips.map((_, k) => `[d${k}]`).join('')}amix=inputs=${clips.length}:normalize=0[mix];[mix]apad[out]`;
const out = path.join(outDir, 'voiceover.m4a');
const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', [...delays, mix].join(';'), '-map', '[out]', '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2', '-t', String(total), out], { encoding: 'utf-8' });
if (r.status !== 0) { console.error('ffmpeg mix failed:', r.stderr); process.exit(1); }
console.log('voiceover:', out, `(${total.toFixed(1)}s，已补静音到画面全长 ${DUR}s)`);
console.log('\n下一步：node scripts/build-bili-promo.mjs → 重渲帧（字幕按实测时长）→ 自动合入配音成片');
