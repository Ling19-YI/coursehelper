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
 * 调用 OpenAI 兼容接口做纯文本答题，失败自动重试并清洗 JSON。
 *
 * 不硬编码 DeepSeek：用户通常只配了「多模态 API Key」，而多模态接口本身
 * 就是 OpenAI 兼容的 /chat/completions，纯文本问答无需图片参数，直接复用。
 */
export async function askAI(
  ch: AnswerChannel,
  questions: QuizQuestion[]
): Promise<Array<{ i: number; answer: string; note?: string }>> {
  const prompt = buildPrompt(questions);
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    // 必须有超时：否则接口不响应时会永久挂起，
    // 测验页的自动答题会卡在原地，只能强杀进程。
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
          temperature: attempt === 0 ? 0.1 : 0.3,
          max_tokens: 2000,
        }),
        signal: ctrl.signal,
      });
    } catch (e: any) {
      clearTimeout(timer);
      lastErr =
        e?.name === 'AbortError'
          ? `${ch.label} 超时（${LIMIT_MS / 1000}s）`
          : `${ch.label} 连接失败: ${String(e?.message || e).slice(0, 60)}`;
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      continue;
    }
    clearTimeout(timer);
    if (!resp.ok) {
      lastErr = `${ch.label} 接口 ${resp.status}`;
      if (resp.status === 401 || resp.status === 402) throw new Error(lastErr);
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      continue;
    }
    const raw = ((await resp.json()) as any).choices?.[0]?.message?.content || '';
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) {
      lastErr = 'AI 返回格式错误';
      continue;
    }
    try {
      const parsed = JSON.parse(m[0].replace(/,\s*]/g, ']'));
      if (Array.isArray(parsed) && parsed.length) return parsed;
      lastErr = 'AI 返回空数组';
    } catch (e: any) {
      lastErr = 'AI JSON 解析失败: ' + (e?.message || e);
    }
  }
  throw new Error(lastErr);
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
 */
export async function resolveAnswers(
  questions: QuizQuestion[],
  chain: Searcher[],
  onMiss?: (q: QuizQuestion) => void
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
    }
  }

  for (const q of pending) onMiss?.(q);
  return found;
}
