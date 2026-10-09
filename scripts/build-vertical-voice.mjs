import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

/**
 * 竖版口播配音：读取 promo/vertical/narration.json，TTS → 拼 30s 轨 → 写 sync 时间轴
 * 用法: $env:TTS_KEY='sk-xxx'; node scripts/build-vertical-voice.mjs
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vDir = path.join(root, 'promo', 'vertical');
const voiceDir = path.join(vDir, 'voice');
mkdirSync(voiceDir, { recursive: true });

const KEY = process.env.TTS_KEY || '';
const BASE = (process.env.TTS_BASE || 'https://tokendance.space').replace(/\/+$/, '');
const MODEL = process.env.TTS_MODEL || 'minimax-speech-2.8-hd';
const VOICE = process.env.TTS_VOICE || 'female-shaonv';
const SPEED = Number(process.env.TTS_SPEED || 1.12); // 竖版节奏更快
if (!KEY) { console.error('缺少 TTS_KEY'); process.exit(1); }

const lines = JSON.parse(readFileSync(path.join(vDir, 'narration.json'), 'utf-8'));
const DUR = 30;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tts(text) {
  const res = await fetch(`${BASE}/gateway/minimax/v1/t2a_v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL, text, stream: false,
      voice_setting: { voice_id: VOICE, speed: SPEED, vol: 1.0, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
    }),
  });
  const j = await res.json().catch(() => ({}));
  const a = j?.data?.audio;
  if (a) return a;
  throw new Error(j?.base_resp?.status_msg || JSON.stringify(j).slice(0, 200));
}
function save(raw, file) {
  const clean = raw.replace(/^data:audio\/\w+;base64,/, '');
  const hex = /^[0-9a-f]+$/i.test(clean) && clean.length % 2 === 0;
  writeFileSync(file, hex ? Buffer.from(clean, 'hex') : Buffer.from(clean, 'base64'));
}
const durOf = f => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf-8' });
  return parseFloat(r.stdout.trim()) || 0;
};

// 生成每句
const clips = [];
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  const file = path.join(voiceDir, `line-${i + 1}.mp3`);
  if (existsSync(file) && durOf(file) > 0.2 && process.env.FORCE_TTS !== '1') {
    console.log(`[${i + 1}] 复用`);
  } else {
    process.stdout.write(`[${i + 1}] ${l.text}\n`);
    let raw;
    for (let k = 0; k < 3; k++) { try { raw = await tts(l.text); break; } catch (e) { if (k === 2) throw e; await sleep(1500); } }
    save(raw, file);
    await sleep(350);
  }
  clips.push({ t0: l.t0, text: l.text, file, dur: durOf(file) });
}

// 拼轨（超长句轻微加速避免重叠）
const inputs = ['-f', 'lavfi', '-t', String(DUR), '-i', 'anullsrc=r=44100:cl=stereo'];
const filters = [];
clips.forEach((c, i) => {
  const next = i + 1 < clips.length ? clips[i + 1].t0 : DUR;
  const slot = next - c.t0 - 0.12;
  let tempo = c.dur > slot ? Math.min(1.5, c.dur / slot) : 1;
  const delay = Math.round(c.t0 * 1000);
  const chain = [];
  if (tempo > 1.001) chain.push(`atempo=${tempo.toFixed(3)}`);
  chain.push('afade=t=in:st=0:d=0.05', `afade=t=out:st=${(c.dur / tempo - 0.1).toFixed(2)}:d=0.1`, `adelay=${delay}|${delay}`);
  filters.push(`[${i}:a]${chain.join(',')}[a${i}]`);
  inputs.push('-i', c.file);
  c.finalDur = c.dur / tempo;
});
const mix = `${filters.join(';')};${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0[mixed]`;
mkdirSync(path.join(vDir, 'out'), { recursive: true });
const voOut = path.join(vDir, 'out', 'voiceover.m4a');
const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', mix, '-map', '[mixed]', '-c:a', 'aac', '-b:a', '160k', voOut], { encoding: 'utf-8' });
if (r.status !== 0) { console.error('混音失败:', r.stderr); process.exit(1); }
console.log('配音轨:', voOut);

// 写 sync 时间轴
const sync = clips.map((c, i) => {
  const next = i + 1 < clips.length ? clips[i + 1].t0 : DUR;
  return { t0: c.t0, t1: Math.min(c.t0 + c.finalDur + 0.3, next - 0.05), text: c.text };
});
writeFileSync(path.join(vDir, 'narration.sync.json'), JSON.stringify(sync, null, 2), 'utf-8');
console.log('时间轴已写');
console.log('下一步: node scripts/build-vertical.mjs');