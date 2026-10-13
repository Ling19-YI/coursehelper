import type { AnswerChannel, QuizQuestion } from './quizTypes';
import type { TikuStore } from './tiku';

/**
 * 搜题器抽象。
 *
 * 「答案从哪来」是可替换的：本地题库、AI、在线题库 API 都是一个 Searcher。
 * `resolveAnswers` 按链的顺序依次询问，**已经拿到答案的题不会再传给后面的
 * 搜题器** —— 这就是「多级优先级」的实现方式：命中本地库就不烧 AI。
 */
export interface Searcher {
  readonly name: string;
  /**
   * 批量作答。
   * 返回 question.index -> 答案文本；答不出来的题**不要**放进结果里，
   * 交给链上下一个搜题器，不要用空串/猜测占位。
   */
  invokeAll(questions: QuizQuestion[]): Promise<Map<number, string>>;
}

/** 本地题库：命中即返回，不调接口 */
export class CacheSearcher implements Searcher {
  readonly name = '本地题库';
  constructor(private store: TikuStore) {}
  async invokeAll(questions: QuizQuestion[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    for (const q of questions) {
      const hit = this.store.get(q.stem);
      if (hit) out.set(q.index, hit);
    }
    return out;
  }
}

function buildPrompt(questions: QuizQuestion[]): string {
  const lines = questions.map(q => {
    const type =
      q.type === 'multi' ? '多选' : q.type === 'judge' ? '判断' : q.type === 'fill' ? '填空' : '单选';
    const opts = q.options.map(o => `  ${o.label}. ${o.text}`).join('\n');
    const fill = q.hasInput ? '（有填空输入框）' : '';
    return `第${q.index}题 [${type}] ${q.stem}${fill}\n${opts}`;
  });
  return (
    '请回答下面' +
    questions.length +
    '道超星学习通测验题。\n\n' +
    lines.join('\n\n') +
    '\n\n严格只输出JSON数组，不要任何其他文字。格式：' +
    '[{"i":1,"answer":"A","note":"理由"}]\n' +
    '规则：单选只给一个字母；多选给多个字母如"AB"；判断题answer用"对"或"错"；填空题answer写要填的内容。' +
    '完全无法确定时answer写"?"。'
  );
}

/**
 * 单次调用 OpenAI 兼容接口，返回 message.content 原文。
 *
 * 错误必须带响应体：只看 HTTP 400 分不清是模型名不认识、参数不支持还是
 * 请求格式错误，而这三者的修法完全不同（换模型名 / 用最小体重试 / 查地址）。
 * 这条路径上已经栽过：用户配了 key 但调用必失败，日志只有一个「接口 400」，
 * 对着状态码猜了一周，其实响应体里写着 model not found。
 */
async function callOnce(
  ch: AnswerChannel,
  prompt: string,
  maxTokens: number,
  minimal: boolean
): Promise<string> {
  const LIMIT_MS = 45000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LIMIT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${ch.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ch.apiKey}` },
      body: JSON.stringify({
        model: ch.model,
        messages: [
          {
            role: 'system',
            content:
              '你是超星学习通测验答题专家，擅长医学、马克思主义、护理、计算机等课程知识点。只输出JSON数组。',
          },
          { role: 'user', content: prompt },
        ],
        // 部分自建网关不收 temperature/max_tokens，minimal 时只发核心字段
        ...(minimal ? {} : { temperature: 0.1, max_tokens: maxTokens }),
      }),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    clearTimeout(timer);
    throw new Error(
      e?.name === 'AbortError'
        ? `${ch.label} 超时（${LIMIT_MS / 1000}s）`
        : `${ch.label} 连接失败: ${String(e?.message || e).slice(0, 80)}`
    );
  }
  clearTimeout(timer);

  if (!resp.ok) {
    let detail = '';
    try {
      detail = (await resp.text()).replace(/\s+/g, ' ').slice(0, 300);
    } catch {}
    throw new Error(`${ch.label} 接口 ${resp.status}${detail ? ' ' + detail : ''}`);
  }

  // 先取原文再解析：resp.json() 遇空体只抛 "Unexpected end of JSON input"，
  // 分不清是网关截断、返回了 SSE 还是真空。
  const raw = await resp.text();
  if (!raw.trim()) throw new Error(`${ch.label} 返回空响应体`);
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${ch.label} 返回非 JSON（前 120 字: ${raw.slice(0, 120)}）`);
  }
  const msg = json?.choices?.[0]?.message;
  const content = String(msg?.content ?? '');
  // 推理模型把 token 花在 reasoning_content 上，content 可能整段为空。
  // 那不是「答不出来」是预算不够——明确报出来，让上层加大预算重试。
  if (!content.trim() && msg?.reasoning_content) {
    throw new Error(
      `${ch.label} content 为空，只有 reasoning_content（${String(msg.reasoning_content).length} 字）——` +
        `max_tokens 被推理吃光了`
    );
  }
  return content;
}

/**
 * 调用 OpenAI 兼容接口做纯文本答题，失败自动重试并清洗 JSON。
 *
 * 不硬编码 DeepSeek：用户通常只配了「多模态 API Key」，而多模态接口本身
 * 就是 OpenAI 兼容的 /chat/completions，纯文本问答无需图片参数，直接复用。
 *
 * 重试策略（三次）：
 *   1. 标准参数（temperature 0.1 + max_tokens 2000）
 *   2. 加大预算到 6000 —— 防推理模型把预算花在 reasoning_content 上
 *   3. 最小体重试 —— 只发 model+messages，绕开不收这两个参数的网关
 * 401/402 是鉴权/余额问题，重试无意义，直接抛出。
 */
export async function askAI(
  ch: AnswerChannel,
  questions: QuizQuestion[]
): Promise<Array<{ i: number; answer: string; note?: string }>> {
  const prompt = buildPrompt(questions);
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const maxTokens = attempt === 0 ? 2000 : 6000;
    const minimal = attempt === 2;
    try {
      const content = await callOnce(ch, prompt, maxTokens, minimal);
      const m = content.match(/\[[\s\S]*\]/);
      if (!m) {
        lastErr = 'AI 返回格式错误（无 JSON 数组）';
      } else {
        try {
          const parsed = JSON.parse(m[0].replace(/,\s*]/g, ']'));
          if (Array.isArray(parsed) && parsed.length) return parsed;
          lastErr = 'AI 返回空数组';
        } catch (e: any) {
          lastErr = 'AI JSON 解析失败: ' + (e?.message || e);
        }
      }
    } catch (e: any) {
      lastErr = String(e?.message || e);
      // 鉴权失败/余额不足：重试三次也是同样结果，直接抛给上层亮出来
      if (/接口 (401|402)/.test(lastErr)) throw e;
    }
    await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
  }
  throw new Error(lastErr || 'AI 调用失败');
}

/** 大模型：一次请求处理整卷（比逐题请求便宜也更快） */
export class LlmSearcher implements Searcher {
  readonly name: string;
  constructor(private channel: AnswerChannel) {
    this.name = channel.label || 'AI';
  }
  async invokeAll(questions: QuizQuestion[]): Promise<Map<number, string>> {
    const raw = await askAI(this.channel, questions);
    const out = new Map<number, string>();
    for (const r of raw) {
      const v = String(r?.answer ?? '').trim();
      // 「?」/「？」是提示词里约定的「答不出来」，不能当成答案记下来
      if (v && v !== '?' && v !== '？') out.set(Number(r.i), v);
    }
    return out;
  }
}

/**
 * 依次问一串搜题器，返回最终答案表。
 *
 * 某个搜题器整体失败不中断整链 —— 一个接口 502 不该让本地题库里的答案也丢掉。
 *
 * ⚠️ 失败必须经 onError 报到界面上：这里以前只 console.warn，而那是主进程的
 * 终端输出，用户根本看不到。实际后果：key 过期、模型名写错、网关 400——
    日志里只剩「无解，留空」，用户对着「AI 没解题」干瞪眼，没人知道该查什么。
 * console.warn 保留给开发调试，onError 是给用户看的那一条。
 */
export async function resolveAnswers(
  questions: QuizQuestion[],
  chain: Searcher[],
  onMiss?: (q: QuizQuestion) => void,
  onError?: (searcherName: string, err: any) => void
): Promise<Map<number, string>> {
  const found = new Map<number, string>();
  let pending = questions;

  for (const s of chain) {
    if (!pending.length) break;
    try {
      const got = await s.invokeAll(pending);
      for (const [idx, ans] of got) {
        if (!found.has(idx)) found.set(idx, ans);
      }
      pending = pending.filter(q => !found.has(q.index));
    } catch (e: any) {
      console.warn(`[searcher] ${s.name} 失败:`, e?.message || e);
      onError?.(s.name, e);
    }
  }

  for (const q of pending) onMiss?.(q);
  return found;
}
