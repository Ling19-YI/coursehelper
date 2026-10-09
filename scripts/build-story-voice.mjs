import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

/**
 * 片头故事音轨：raw-*.mp3 → 曼波变声(rubberband 音高+EQ) → 按时间轴拼轨
 * 环境变量:
 *   V_PITCH  音高倍率(默认 1.30 曼波风格)
 *   V_TEMPO  语速倍率(默认 1.16)
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vDir = path.join(root, 'promo', 'vertical');
const rawDir = path.join(vDir, 'story-voice');
const outDir = path.join(vDir, 'out');
mkdirSync(outDir, { recursive: true });
mkdirSync(rawDir, { recursive: true });

const PITCH = Number(process.env.V_PITCH || 1.0);   // 1.0 = 原声（不再做哈基米变声）
const TEMPO = Number(process.env.V_TEMPO || 1.0);
const lines = JSON.parse(readFileSync(path.join(vDir, 'story.json'), 'utf-8'));

/**
 * 变声滤镜链：仅在 V_PITCH>1 时启用（哈基米风格可选，默认关闭＝正常人声）
 */
function manboChain(pitch, tempo) {
  const f = [];
  if (pitch > 1.001) f.push(`rubberband=pitch=${Math.log2(pitch).toFixed(5)}`);
  if (tempo > 1.001) f.push(`atempo=${tempo}`);
  f.push(
    'equalizer=f=200:t=q:w=1:g=-3',
    'equalizer=f=3000:t=q:w=1.5:g=3',
    'acompressor=threshold=-18dB:ratio=3:attack=5:release=80',
    'alimiter=limit=0.95'
  );
  return f.join(',');
}

const durOf = f => {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f],
    { encoding: 'utf-8' }
  );
  const v = parseFloat((r.stdout || '').trim());
  return Number.isFinite(v) && v > 0 ? v : 0;
};

const clips = [];
for (let i = 0; i < lines.length; i++) {
  const raw = path.join(rawDir, `raw-${i + 1}.mp3`);
  if (!existsSync(raw)) {
    console.error(`缺少 ${raw}`);
    process.exit(1);
  }
  const rawDur = durOf(raw);
  if (rawDur <= 0) {
    console.error(`无法读取时长: ${raw}`);
    process.exit(1);
  }
  const fx = path.join(rawDir, `manbo-${i + 1}.wav`);
  const r = spawnSync(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-i', raw, '-af', manboChain(PITCH, TEMPO), '-ar', '44100', '-ac', '1', fx],
    { encoding: 'utf-8' }
  );
  if (r.status !== 0) {
    console.error(`变声失败 #${i + 1}: ${r.stderr}`);
    process.exit(1);
  }
  const fxDur = durOf(fx);
  if (fxDur <= 0) {
    console.error(`变声输出无效 #${i + 1}`);
    process.exit(1);
  }
  clips.push({ t0: lines[i].t0, text: lines[i].text, file: fx, dur: fxDur });
  console.log(`[${i + 1}] ${rawDur.toFixed(2)}s → ${fxDur.toFixed(2)}s  ${lines[i].text}`);
}

// 拼 30s+ 音轨（片头 26s 左右，留白）
const TOTAL = Math.max(28, ...clips.map((c, i) => (i + 1 < clips.length ? clips[i + 1].t0 : 0) + 26));
const inputs = ['-f', 'lavfi', '-t', String(TOTAL), '-i', 'anullsrc=r=44100:cl=stereo'];
const filters = [];
clips.forEach((c, i) => {
  const next = i + 1 < clips.length ? clips[i + 1].t0 : TOTAL;
  const slot = next - c.t0 - 0.15;
  let tempo = c.dur > slot ? Math.min(1.4, c.dur / slot) : 1;
  const delay = Math.round(c.t0 * 1000);
  const chain = [];
  if (tempo > 1.001) chain.push(`atempo=${tempo.toFixed(3)}`);
  chain.push('afade=t=in:st=0:d=0.05', `afade=t=out:st=${(c.dur / tempo - 0.1).toFixed(2)}:d=0.1`, `adelay=${delay}|${delay}`);
  filters.push(`[${i}:a]${chain.join(',')}[a${i}]`);
  inputs.push('-i', c.file);
  c.finalDur = c.dur / tempo;
});
const mix = `${filters.join(';')};${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0[mixed]`;
const voiceOut = path.join(outDir, 'story-voiceover.m4a');
const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', mix, '-map', '[mixed]', '-c:a', 'aac', '-b:a', '160k', voiceOut], { encoding: 'utf-8' });
if (r.status !== 0) { console.error('混音失败', r.stderr); process.exit(1); }

// 写出精确时间轴（供打字机字幕逐字对齐）
const sync = clips.map((c, i) => {
  const next = i + 1 < clips.length ? clips[i + 1].t0 : TOTAL;
  return { t0: c.t0, t1: Math.min(c.t0 + c.finalDur + 0.35, next - 0.05), text: c.text, chars: [...c.text] };
});
writeFileSync(path.join(vDir, 'story.sync.json'), JSON.stringify(sync, null, 2), 'utf-8');
console.log('故事音轨:', voiceOut);
console.log('时间轴: promo/vertical/story.sync.json');
sync.forEach(c => console.log(`  ${c.t0.toFixed(1)}-${c.t1.toFixed(1)}s  ${c.text}`));
console.log(`总时长 ${TOTAL.toFixed(1)}s`);