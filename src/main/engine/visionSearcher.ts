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
    const ch = this.o.channel;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 60000);
    try {
      const resp = await fetch(`${ch.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ch.apiKey}` },
        body: JSON.stringify({
          model: ch.model,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content },
          ],
          temperature: 0,
          max_tokens: 800,
        }),
        signal: ctrl.signal,
      });
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
      if (!raw.trim()) {
        throw new Error(`HTTP ${resp.status} 空响应体 content-type=${ct}`);
      }
      let json: any;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error(`HTTP ${resp.status} 非 JSON 响应 content-type=${ct} 前 200 字: ${raw.slice(0, 200)}`);
      }
      const msg = json?.choices?.[0]?.message;
      const out = msg?.content || '';
      // 推理模型会把 token 花在 reasoning_content 上，content 可能整段为空。
      // 这不是失败，但必须报出来，否则会误判成「模型答不出来」。
      if (!out && msg?.reasoning_content) {
        throw new Error(
          `HTTP ${resp.status} content 为空，只有 reasoning_content（${String(msg.reasoning_content).length} 字）——` +
            `max_tokens 太小被推理吃光了`
        );
      }
      return out;
    } finally {
      clearTimeout(timer);
    }
  }
}