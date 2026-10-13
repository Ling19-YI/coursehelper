/**
 * 真实接口探针：查清「推理吃光预算」该怎么修。
 *
 * 背景：用户日志里截图识别两次都 HTTP 200、content 为空、只有 reasoning_content
 * （7544 字 / 4440 字），max_tokens 800 → 3200 加倍也不够。
 *
 * 要问清楚四件事：
 *   1. 截断时 finish_reason 是不是 'length'（我们目前完全没读它）
 *   2. 到底要多大预算才够输出 content —— 是否随题目数线性膨胀
 *   3. 有没有参数能关掉/压低思考（enable_thinking / thinking / reasoning_effort…）
 *   4. content 被吃光时，reasoning_content 里有没有可直接取的完整答案 JSON
 *
 * 必须在 Electron 里跑（safeStorage 才能解密 vision.enc）：
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/probe-reasoning-budget.mjs
 * 只打印统计量，绝不打印 API Key。
 */
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

app.setName('刷课助手 CourseHelper');
app.setPath('userData', path.join(process.env.APPDATA, '刷课助手 CourseHelper'));
// 沙箱里 GPU 进程会反复崩（gpu_data_manager FATAL）把主进程带走，与接口无关
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

const SYSTEM = [
  '你是课程章节练习答题助手。只输出 JSON 对象，格式为',
  '{"answers":[{"id":1,"choices":["A"]}]}。',
  '单选和判断题只能给一个 choices，多选题可给多个，字母大写。',
  '你会同时看到题号、题干描述，以及该题的完整截图。',
  '题干或选项显示「见截图」时，一律以截图渲染出来的内容为准。',
  '不要输出解释，不要补造截图里没有的选项。',
  '无法判断时不要返回这道题，而不是猜一个。',
].join('');

function userPrompt(n) {
  const lines = ['请根据题号与对应截图作答。'];
  for (let i = 1; i <= n; i++) lines.push(`题目 ID ${i}：［题干见截图］`);
  return lines.join('\n');
}

/** 默认用例：前三个是核心证据链，后四个是备选方向 */
const DEFAULT_CASES = [
  { label: '[0] max_tokens=800（复现用户日志：必然撞顶，content 0 字）', images: 'distinct', extra: { temperature: 0, max_tokens: 800 } },
  { label: '[1] max_tokens=3200（旧的重试档，用户日志里同样撞顶）', images: 'distinct', extra: { temperature: 0, max_tokens: 3200 } },
  { label: '[2] max_tokens=16000（现用的首发档：应 finish=stop 并给出答案）', images: 'distinct', extra: { temperature: 0, max_tokens: 16000 } },
  { label: '[3] enable_thinking=false（关掉思考，看网关认不认）', images: 'distinct', extra: { temperature: 0, max_tokens: 800, enable_thinking: false } },
  { label: '[4] thinking={type:disabled}', images: 'distinct', extra: { temperature: 0, max_tokens: 800, thinking: { type: 'disabled' } } },
  { label: '[5] reasoning_effort=minimal', images: 'distinct', extra: { temperature: 0, max_tokens: 800, reasoning_effort: 'minimal' } },
  { label: '[6] max_tokens=32000（升档档位，确认网关天花板）', images: 'distinct', extra: { temperature: 0, max_tokens: 32000 } },
];

function readKey() {
  const f = path.join(app.getPath('userData'), 'vision.enc');
  const buf = fs.readFileSync(f);
  const raw = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf-8');
  return String(JSON.parse(raw) || '').trim();
}

const settings = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf-8'));
const BASE = String(settings.visionBaseUrl).replace(/\/$/, '');
const MODEL = settings.visionModel;

async function call(key, extra, imgs, itemCount) {
  const content = [{ type: 'text', text: userPrompt(itemCount) }];
  for (const u of imgs) content.push({ type: 'image_url', image_url: { url: u } });

  const payload = { model: MODEL, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }], stream: false, ...extra };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  const t0 = Date.now();
  try {
    const resp = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const ms = Date.now() - t0;
    const raw = await resp.text();
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {}
    if (!resp.ok) return { status: resp.status, ms, err: raw.replace(/\s+/g, ' ').slice(0, 200) };
    const choice = json?.choices?.[0];
    const msg = choice?.message;
    const c = msg?.content;
    const contentText = typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : p?.text ?? '')).join('') : '';
    const reason = String(msg?.reasoning_content || '');
    const u = json?.usage;
    // reasoning 里有没有完整的答案 JSON（贪心取最后一个 } 结尾的对象）
    let salvage = null;
    if (reason) {
      const m = reason.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          const o = JSON.parse(m[0]);
          if (Array.isArray(o?.answers)) salvage = o.answers.length;
        } catch {}
      }
    }
    return {
      status: resp.status,
      ms,
      finish: choice?.finish_reason,
      contentLen: contentText.length,
      reasonLen: reason.length,
      reasonTok: u?.completion_tokens_details?.reasoning_tokens,
      inTok: u?.prompt_tokens,
      outTok: u?.completion_tokens,
      salvage,
      head: contentText.replace(/\s+/g, ' ').slice(0, 160),
      reasonTail: reason.replace(/\s+/g, ' ').slice(-200),
      msgKeys: Object.keys(msg || {}).join(','),
    };
  } catch (e) {
    return { status: -1, ms: Date.now() - t0, err: String(e?.message || e).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

const show = (label, r) => {
  if (r.err) return console.log(`${label}\n   ✗ status=${r.status} ${r.ms}ms ${r.err}`);
  console.log(
    `${label}\n   status=${r.status} ${r.ms}ms finish=${r.finish} 入${r.inTok}/出${r.outTok}` +
      `(推理${r.reasonTok ?? '?'})\n   content=${r.contentLen}字 reasoning=${r.reasonLen}字` +
      ` 可取答案=${r.salvage ?? '无'} msg键=[${r.msgKeys}]` +
      (r.contentLen ? `\n   content头: ${r.head}` : `\n   reasoning尾: …${r.reasonTail}`)
  );
};

app.whenReady().then(async () => {
  const key = readKey();
  const dir = path.join(process.cwd(), '.probe');
  // 用例文件不存在就写一份默认的，让探针可独立复跑
  const casesFile = path.join(dir, 'cases.json');
  if (!fs.existsSync(casesFile)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(casesFile, JSON.stringify(DEFAULT_CASES, null, 2));
    console.log('已写入默认用例 .probe/cases.json');
  }
  if (!fs.existsSync(path.join(dir, 'q1.png'))) {
    console.log('缺题图，请先跑：node scripts/probe-gen-quiz-images.mjs');
    app.exit(1);
    return;
  }
  const durl = f => `data:image/png;base64,${fs.readFileSync(path.join(dir, f)).toString('base64')}`;
  const SAME = Array.from({ length: 5 }, () => durl('quiz.png'));
  const DISTINCT = ['q1.png', 'q2.png', 'q3.png', 'q4.png', 'q5.png'].map(durl);
  console.log(`model=${MODEL} base=${BASE} keyLen=${key.length}\n`);

  // 用例从文件读：把 JSON 塞进 env 在 Git Bash 里会被吃了
  const all = JSON.parse(fs.readFileSync(casesFile, 'utf-8'));
  // 一次只跑一个用例：连跑多个会让 Electron 主进程中途崩掉（exit 3）
  const only = process.argv[2] ? Number(process.argv[2]) : null;
  const CASES = only == null ? all : [all[only]];
  console.log(`共 ${all.length} 个用例，本次跑 ${only == null ? '全部' : only}\n`);

  process.on('unhandledRejection', e => console.log('UNHANDLED', String(e?.message || e)));
  for (const c of CASES) {
    console.log(`▶ 发起 ${c.label}`);
    const imgs = c.images === 'distinct' ? DISTINCT : SAME.slice(0, c.images ?? 5);
    try {
      show(c.label, await call(key, c.extra, imgs, c.items ?? 5));
    } catch (e) {
      console.log(`✗ ${c.label} 异常：${String(e?.stack || e).slice(0, 400)}`);
    }
  }
  app.exit(0);
}).catch(e => {
  console.log('whenReady 失败', String(e?.stack || e).slice(0, 600));
  app.exit(1);
});
