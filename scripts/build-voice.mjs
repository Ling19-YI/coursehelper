import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * 宣传视频中文配音：
 *  1) 用网关 TTS（默认 MiniMax Speech-2.8-HD）为每句文案生成 mp3
 *  2) 按字幕时间轴拼成 30s 配音轨（超长句自动 atempo 轻微加速以免重叠）
 *  3) 与成片合成 -vo 版 mp4
 *
 * 用法：
 *   $env:TTS_KEY='sk-xxx'; $env:TTS_BASE='https://tokendance.space'; node scripts/build-voice.mjs
 * 可选：$env:TTS_MODEL / $env:TTS_VOICE / $env:TTS_SPEED
 */
const root = process.cwd();
const promo = path.join(root, 'promo');
const voiceDir = path.join(promo, 'voice');
mkdirSync(voiceDir, { recursive: true });

const KEY = process.env.TTS_KEY || '';
const BASE = (process.env.TTS_BASE || 'https://tokendance.space').replace(/\/+$/, '');
const MODEL = process.env.TTS_MODEL || 'minimax-speech-2.8-hd';
const VOICE = process.env.TTS_VOICE || 'female-shaonv';
const SPEED = Number(process.env.TTS_SPEED || 1.05);
if (!KEY) {
  console.error('缺少 TTS_KEY 环境变量');
  process.exit(1);
}

/* 口播文案：唯一数据源 promo/src/narration.json（字幕与配音共用） */
const narrationFile = path.join(promo, 'src', 'narration.json');
const lines = JSON.parse(readFileSync(narrationFile, 'utf-8')).map(l => [l.t0, l.text]);
const DUR = 30;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tts(text, attempt = 0) {
  const body = {
    model: MODEL,
    text,
    stream: false,
    voice_setting: { voice_id: VOICE, speed: SPEED, vol: 1.0, pitch: 0 },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
  };
  const res = await fetch(`${BASE}/gateway/minimax/v1/t2a_v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  const audio = json?.data?.audio;
  if (audio) return audio;
  const msg = json?.base_resp?.status_msg || json?.error?.message || JSON.stringify(json).slice(0, 300);
  if (attempt === 0 && /voice|音色/i.test(msg)) {
    console.log(`  音色 ${VOICE} 不可用(${msg})，换 chinese_woman`);
    process.env.TTS_VOICE = 'chinese_woman';
    return tts(text, 1);
  }
  throw new Error(`TTS 失败: ${res.status} ${msg}`);
}

function saveAudio(raw, file) {
  if (/^https?:\/\//.test(raw)) {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', `(Invoke-WebRequest -Uri '${raw}' -OutFile '${file}')`], {
      encoding: 'utf-8',
    });
    if (r.status !== 0) throw new Error('下载音频失败');
    return;
  }
  const clean = raw.replace(/^data:audio\/\w+;base64,/, '');
  const isHex = /^[0-9a-f]+$/i.test(clean) && clean.length % 2 === 0;
  writeFileSync(file, isHex ? Buffer.from(clean, 'hex') : Buffer.from(clean, 'base64'));
}

const durOf = f => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], {
    encoding: 'utf-8',
  });
  return parseFloat(r.stdout.trim()) || 0;
};

// 1) 生成每句音频
const clips = [];
for (let i = 0; i < lines.length; i++) {
  const [t0, text] = lines[i];
  const file = path.join(voiceDir, `line-${i + 1}.mp3`);
  if (existsSync(file) && durOf(file) > 0.2 && process.env.FORCE_TTS !== '1') {
    console.log(`[${i + 1}] 复用已有音频`);
  } else {
    process.stdout.write(`[${i + 1}] TTS: ${text}\n`);
    let raw;
    for (let tries = 0; tries < 3; tries++) {
      try {
        raw = await tts(text);
        break;
      } catch (e) {
        if (tries === 2) throw e;
        console.log('  重试:', e.message);
        await sleep(1500);
      }
    }
    saveAudio(raw, file);
    await sleep(400);
  }
  clips.push({ t0, text, file, dur: durOf(file) });
}

// 2) 拼时间轴：超长句轻微加速，避免与下一句重叠
const inputs = [];
const filters = [];
let voiceIdx = 0;
for (let i = 0; i < clips.length; i++) {
  const c = clips[i];
  const next = i + 1 < clips.length ? clips[i + 1].t0 : DUR;
  const slot = next - c.t0 - 0.15;
  let tempo = 1;
  if (c.dur > slot) tempo = Math.min(1.45, c.dur / slot);
  const delay = Math.round(c.t0 * 1000);
  const chain = [];
  if (tempo > 1.001) chain.push(`atempo=${tempo.toFixed(3)}`);
  chain.push(`afade=t=in:st=0:d=0.06`, `afade=t=out:st=${(c.dur / tempo - 0.12).toFixed(2)}:d=0.12`);
  chain.push(`adelay=${delay}|${delay}`);
  filters.push(`[${voiceIdx}:a]${chain.join(',')}[a${i}]`);
  inputs.push('-i', c.file);
  voiceIdx++;
  c.tempo = tempo;
  c.finalDur = c.dur / tempo;
  console.log(
    `  ${i + 1}) ${c.t0.toFixed(1)}s +${c.finalDur.toFixed(2)}s` +
      (tempo > 1.001 ? ` (加速 x${tempo.toFixed(2)})` : '')
  );
}

// 静音底轨 + 各句混合
const mixInputs = ['-f', 'lavfi', '-t', String(DUR), '-i', 'anullsrc=r=44100:cl=stereo', ...inputs];
const mixFilter = `${filters.join(';')};${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0:dropout_transition=0[mixed]`;
const voiceOut = path.join(promo, 'out', 'voiceover.m4a');
const mix = spawnSync(
  'ffmpeg',
  ['-y', '-loglevel', 'error', ...mixInputs, '-filter_complex', mixFilter, '-map', '[mixed]', '-c:a', 'aac', '-b:a', '160k', voiceOut],
  { encoding: 'utf-8' }
);
if (mix.status !== 0) {
  console.error('混音失败:', mix.stderr);
  process.exit(1);
}
console.log('配音轨:', voiceOut);

// 2.5) 写出字幕时间轴（含每句真实时长）→ 供 render.html / SRT 使用，保证声画字幕一致
const sync = clips.map((c, i) => {
  const next = i + 1 < clips.length ? clips[i + 1].t0 : DUR;
  const t1 = Math.min(c.t0 + c.finalDur + 0.35, next - 0.05);
  return { t0: c.t0, t1: Math.max(t1, c.t0 + 1.2), text: c.text };
});
writeFileSync(path.join(promo, 'src', 'narration.sync.json'), JSON.stringify(sync, null, 2), 'utf-8');
console.log('字幕时间轴:', path.join(promo, 'src', 'narration.sync.json'));

console.log('下一步: node scripts/build-promo.mjs  (渲染画面并自动合成配音版)');