import type { Page } from 'playwright';
import type { AnswerChannel, QuizOption, QuizQuestion } from './quizTypes';
import type { Searcher } from './searcher';
import { assertPngDataUrl, captureElement } from './capture';

/**
 * 截图搜题器：处理文字链处理不了的题。
 *
 * 触发条件是 quiz.ts 打上的 encrypted 标记，两种成因（实测自线性代数）：
 *   - 题干本身是 <img>，页面里没有文字
 *   - 超星字体替换，DOM 文本是错字而渲染出来才对
 *
 * 两种情况都只能看**渲染后的画面**。这不是兜底策略，是唯一可行解。
 *
 * 两条硬规则：
 *   1. 答案必须在给出的选项里，否则丢弃这道题（不硬塞一个字母）。
 *   2. 模型说「不确定」时返回空，由覆盖率闸门决定要不要交卷。
 *      乱填比留空危险得多——错的答案会留在平台上，是实打实的扣分。
 */
export interface VisionSearcherOpts {
  /** 多模态通道 */
  channel: AnswerChannel;
  /** 取每道题在 DOM 里的定位选择器 */
  selectorFor: (q: QuizQuestion) => string;
  /** 取到承载题目的 iframe */
  frameFor: () => any | null;
  page: Page;
  timeoutMs?: number;
  maxPerCall?: number;
  log?: (level: 'info' | 'warn' | 'ok', msg: string) => void;
}

const SYSTEM = [
  '你是课程章节练习答题助手。只输出 JSON 对象，格式为',
  '{"answers":[{"id":1,"choices":["A"]}]}。',
  '单选和判断题只能给一个 choices，多选题可给多个，字母大写。',
  '你会同时看到题号、题干描述，以及该题的完整截图。',
  '题干或选项显示「见截图」时，一律以截图渲染出来的内容为准。',
  '不要输出解释，不要补造截图里没有的选项。',
  '无法判断时不要返回这道题，而不是猜一个。',
].join('');

/**
 * 首次请求的输出预算。
 *
 * 推理模型把输出预算先花在 reasoning_content 上，content 是「剩下的」；
 * 预算给不够就一个字都不剩（HTTP 200、finish_reason=length、content 空）。
 * 实测（deepseek-v4.1-flash，5 张不同的题图，真实网关）：
 *
 *   max_tokens=800    → finish=length，content 0 字，推理 1772 字就撞顶
 *   max_tokens=3200   → 用户日志里同样撞顶（推理 4440 字）
 *   max_tokens=16000  → finish=stop，出 11404 token（其中 11358 全是推理）、84 秒
 *
 * 所以第一发就按 16000 发。上限是天花板不是账单——给大了只在真需要时多花，
 * 给小了必然白烧一整轮：800 那档花掉 800 token 换回 0 字 content，再升档重来一遍，
 * 既多花钱又让用户多等一轮。
 */
const VISION_MAX_TOKENS = 16000;

/** 撞顶后的升档上限（题量偏大时推理还会继续膨胀） */
const VISION_MAX_TOKENS_HARD = 32000;

/**
 * 单次请求的超时。
 *
 * 跟预算一起抬高：实测 16000 预算下这一批 5 题跑了 84 秒，而原来的 60 秒超时
 * 会让「不给够预算」的故障换一副面孔出现——变成「请求超时」。两处必须同改。
 */
const VISION_TIMEOUT_MS = 180000;

/**
 * 推理把输出预算吃光了（finish_reason=length）。
 *
 * 单独一个类型，是因为它不算「调用失败」而是「预算不够」：上层要能认出来去
 * 升档重试，而不是当成模型答不出来把整批题一起废掉。
 */
export class ReasoningBudgetError extends Error {
  constructor(
    message: string,
    /** 被截断时已经吐出来的 content（可能为空） */
    readonly partial: string
  ) {
    super(message);
    this.name = 'ReasoningBudgetError';
  }
}

function buildUserPrompt(items: Array<{ id: number; stem: string; options: QuizOption[] }>): string {
  const lines: string[] = ['请根据题号与对应截图作答。'];
  for (const it of items) {
    lines.push(`题目 ID ${it.id}：${it.stem || '［题干见截图］'}`);
    if (it.options.length) lines.push(`  可选项：${it.options.map(o => `${o.label}.${o.text}`).join('  ')}`);
  }
  return lines.join('\n');
}

/** 从模型的 JSON 里取答案，容错解析（模型偶尔会包 markdown 围栏） */
export function parseAnswers(text: string): Map<number, string> {
  const out = new Map<number, string>();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return out;
  let obj: any;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return out;
  }
  for (const a of obj?.answers || []) {
    const id = Number(a?.id);
    if (!Number.isFinite(id)) continue;
    const choices = Array.isArray(a.choices) ? a.choices : a.choices ? [a.choices] : [];
    const letters = choices
      .map((c: any) => String(c).trim().toUpperCase().replace(/[^A-H]/g, ''))
      .filter(Boolean);
    if (letters.length) out.set(id, letters.join(''));
  }
  return out;
}

/** 答案必须落在选项范围内，否则丢弃 */
export function validate(answer: string, q: QuizQuestion): boolean {
  if (!answer) return false;
  const valid = new Set(q.options.map(o => o.label.toUpperCase()));
  if (!valid.size) return false;
  return answer
    .toUpperCase()
    .split('')
    .every(c => valid.has(c));
}

/**
 * 从响应里取文本，兼容各家 OpenAI 兼容实现的差异。
 *
 * 标准形态是 string，但不少网关/推理模型给的是分段数组：
 *   content: [{ type: 'text', text: '...' }]
 * 直接当字符串用会在 parseAnswers 里炸掉（数组没有 .match），所以必须归一。
 */
export function extractText(json: any): string {
  const msg = json?.choices?.[0]?.message;
  const c = msg?.content ?? '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((p: any) => (typeof p === 'string' ? p : p?.text ?? ''))
      .join('');
  }
  return c == null ? '' : String(c);
}

export class VisionSearcher implements Searcher {
  readonly name = '截图识别';

  constructor(private readonly o: VisionSearcherOpts) {}

  async invokeAll(questions: QuizQuestion[]): Promise<Map<number, string>> {
    const todo = questions.filter(q => q.encrypted && q.options.length > 0);
    if (!todo.length) return new Map();

    const frame = this.o.frameFor();
    if (!frame) return new Map();

    const result = new Map<number, string>();
    const perCall = this.o.maxPerCall ?? 5;

    for (let i = 0; i < todo.length; i += perCall) {
      const batch = todo.slice(i, i + perCall);

      const images: string[] = [];
      const items: Array<{ id: number; stem: string; options: QuizOption[] }> = [];

      for (const q of batch) {
        try {
          const url = await captureElement(this.o.page, frame, this.o.selectorFor(q));
          assertPngDataUrl(url);
          images.push(url);
          items.push({ id: q.index, stem: q.stem, options: q.options });
        } catch (e: any) {
          this.o.log?.('warn', `  \u26a0 \u7b2c ${q.index} \u9898\u622a\u56fe\u5931\u8d25\uff1a${String(e?.message || e).slice(0, 50)}`);
        }
      }

      if (!items.length) continue;

      const content: any[] = [{ type: 'text', text: buildUserPrompt(items) }];
      for (const img of images) {
        content.push({ type: 'image_url', image_url: { url: img } });
      }

      let text = '';
      try {
        text = await this.callApi(content);
      } catch (e: any) {
        this.o.log?.('warn', `  \u26a0 \u622a\u56fe\u8bc6\u522b\u8bf7\u6c42\u5931\u8d25\uff1a${String(e?.message || e).slice(0, 500)}`);
        continue;
      }

      const got = parseAnswers(text);
      let hit = 0;
      for (const [id, answer] of got) {
        const q = batch.find(x => x.index === id);
        if (!q) continue;
        if (!validate(answer, q)) {
          this.o.log?.('warn', `  \u26a0 \u7b2c ${id} \u9898\u6a21\u578b\u7ed9\u7684\u9009\u9879 ${answer} \u4e0d\u5728\u9009\u9879\u8303\u56f4\u5185\uff0c\u4e22\u5f03`);
          continue;
        }
        result.set(id, answer);
        hit++;
      }
      if (hit) this.o.log?.('info', `  \u2713 \u622a\u56fe\u8bc6\u522b ${hit}/${items.length}`);
    }
    return result;
  }

  private async callApi(content: any[]): Promise<string> {
    // 第一发就给足预算，不再「先饿一次再补」——实测 800 和 3200 都会被推理吃光，
    // 饿那一轮纯属白花：烧掉整轮预算、拿回 0 字 content，然后升档再烧一遍。
    try {
      return await this.callOnce(content, VISION_MAX_TOKENS);
    } catch (e) {
      if (!(e instanceof ReasoningBudgetError)) throw e;
      this.o.log?.(
        'warn',
        `  ⚠ 推理把 ${VISION_MAX_TOKENS} token 预算吃光了，升到 ${VISION_MAX_TOKENS_HARD} 重试一次`
      );
      try {
        return await this.callOnce(content, VISION_MAX_TOKENS_HARD);
      } catch (e2) {
        // 升档后还是被截断：宁可把已经吐出来的那部分答案拿去解析，也别整批丢空。
        // 越界的选项会在 invokeAll 的 validate 里被丢掉，不会硬塞错误答案。
        const partial = e2 instanceof ReasoningBudgetError ? e2.partial : '';
        if (partial) {
          this.o.log?.('warn', `  ⚠ 升到 ${VISION_MAX_TOKENS_HARD} 仍被截断，改用已吐出的部分内容`);
          return partial;
        }
        throw e2;
      }
    }
  }

  private async callOnce(content: any[], maxTokens: number): Promise<string> {
    const ch = this.o.channel;
    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content },
    ];
    // 只用 OpenAI 兼容格式的核心字段。用户可以填任意支持 chat/completions
    // 与 image_url 的模型（DeepSeek、通义、GLM、豆包、自建代理都行），所以
    // temperature / max_tokens 不能写死——部分实现不收这两个参数。
    // 先按标准发，400 了再用最小体重试一次，而不是让用户去猜该配哪个模型。
    const payload = (extra: Record<string, unknown>) => ({
      model: ch.model,
      messages,
      stream: false,
      ...extra,
    });

    let resp = await this.post(payload({ temperature: 0, max_tokens: maxTokens }));
    if (resp.status === 400) resp = await this.post(payload({}));

    if (!resp.ok) {
      // 必须带上响应体：只看 HTTP 400 无法区分是模型名错、参数不支持还是格式错误
      let detail = '';
      try {
        detail = (await resp.text()).replace(/\s+/g, ' ').slice(0, 700);
      } catch {}
      throw new Error(`HTTP ${resp.status}${detail ? ' ' + detail : ''}`);
    }

    // 先取原文再解析：resp.json() 遇到空体只抛 "Unexpected end of JSON input"，
    // 完全看不出是网关截断了、返回了 SSE、还是真返回了空。
    const raw = await resp.text();
    const ct = resp.headers.get('content-type') || '';
    if (!raw.trim()) throw new Error(`HTTP ${resp.status} 空响应体 content-type=${ct}`);
    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`HTTP ${resp.status} 非 JSON 响应 content-type=${ct} 前 200 字: ${raw.slice(0, 200)}`);
    }

    // 用量要记下来。截图识别是按图计费的，用户会关心「一次测验花多少」，
    // 而响应里本来就带 usage，以前直接丢掉了。
    // 实测 5 题打包成一次请求约 1.3K 输入 token。
    const usage = json?.usage;
    if (usage && usage.prompt_tokens != null) {
      const parts = [`入 ${usage.prompt_tokens}`, `出 ${usage.completion_tokens ?? '?'}`];
      const cached = usage.prompt_tokens_details?.cached_tokens;
      if (cached) parts.push(`缓存命中 ${cached}`);
      this.o.log?.('info', `  · 用量：${parts.join(' / ')} tokens`);
    }

    const out = extractText(json);
    const msg = json?.choices?.[0]?.message;
    const finish = json?.choices?.[0]?.finish_reason;
    const usageNote = `本次 入 ${usage?.prompt_tokens ?? '?'} / 出 ${usage?.completion_tokens ?? '?'}`;
    // 撞上输出上限。推理模型会把预算先花在 reasoning_content 上，content 是
    // 「剩下的」——吃光了就一个字都不剩，日志里只剩 reasoning_content。
    // 必须报成专门的错误类型（而不是普通失败）让上层升档重试，
    // 否则会被误判成「模型答不出来」，整批题一起丢空。
    // finish_reason 必须看：光看 content 为空分不清是撞顶、网关截断还是真空。
    if (finish === 'length') {
      throw new ReasoningBudgetError(
        (!out && msg?.reasoning_content
          ? `HTTP ${resp.status} content 为空，只有 reasoning_content（${String(msg.reasoning_content).length} 字）`
          : `HTTP ${resp.status} 输出被截断`) +
          `——max_tokens ${maxTokens} 被推理吃光了（finish=length，${usageNote}）`,
        out
      );
    }
    return out;
  }

  /** 单次 POST，自带超时 */
  private async post(payload: any): Promise<Response> {
    const ch = this.o.channel;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? VISION_TIMEOUT_MS);
    try {
      return await fetch(`${ch.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ch.apiKey}` },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
