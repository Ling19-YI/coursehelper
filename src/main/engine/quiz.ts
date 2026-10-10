import type { Page, Frame } from 'playwright';
import type { EngineHooks } from './hooks';
import type { AnswerChannel, QType, QuizOption, QuizQuestion } from './quizTypes';
import { CacheSearcher, LlmSearcher, askAI, resolveAnswers, type Searcher } from './searcher';
import type { TikuStore } from './tiku';

export type { QType, QuizOption, QuizQuestion, AnswerChannel } from './quizTypes';

const MARK_ATTR = 'data-qh';
const FILL_ATTR = 'data-qhf';

const QUIZ_WORDS = /随堂练习|章节测验|单元测验|作业|待完成|请作答|限时答题|回答下列|选择题|判断题|单选题|多选题/;
const SUBMIT_WORDS = /提交|确定|确认|交卷|完成/;

/** 弹窗/答题容器选择器（超星工作界面与随堂弹窗） */
const POPUP_SELECTORS = [
  '#divVideoQuestion',
  '#divExamWork',
  '.layui-layer',
  '.layui-dialog',
  '[role="dialog"]',
  '.van-popup',
  '.modal',
  '.popup',
  '.dialog',
  '.mask',
];

const TEXT_CLEAN = (s: string) => (s || '').replace(/\u00a0/g, ' ').replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

/** 在页面内提取题目结构，并给可点击项打 data-qh 标记 */
function extractInPage(): { questions: QuizQuestion[] } {
  const clean = (s: string) => (s || '').replace(/\u00a0/g, ' ').replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const isQStem = (t: string) =>
    /^\(?\d{1,3}\s*[\.\u3001\uff0e,)）:\uff1a]/.test(t) || /^\s*[\uff08(]?\d{1,3}[\uff09)]\s*/.test(t);

  const nodes = Array.from(document.querySelectorAll('div,li,td,section,p,dd,article,form')) as HTMLElement[];
  const cand: HTMLElement[] = [];
  for (const el of nodes) {
    const t = clean(el.innerText || el.textContent || '');
    if (t.length < 4 || t.length > 1200) continue;
    if (!isQStem(t) && !/[\u5355\u591a\u5224]?\u9009[\u9898]|\u586b\u7a7a|\u4e0b\u62c9\u9898|\u5224\u65ad/.test(t)) continue;
    const hasChoice = el.querySelector('input[type="radio"],input[type="checkbox"],label,[aria-label]');
    if (!hasChoice && !el.querySelector('input[type="text"],textarea')) continue;
    cand.push(el);
  }
  const inner = cand.filter(el => !cand.some(o => o !== el && el.contains(o)));
  const picked = inner.length ? inner : cand.slice(0, 30);

  const questions: QuizQuestion[] = [];
  picked.slice(0, 60).forEach((el, qi) => {
    const full = clean(el.innerText || el.textContent || '');
    let type: QType = 'unknown';
    if (/\u591a\u9009|\u591a\u9879/.test(full)) type = 'multi';
    else if (/\u5224\u65ad/.test(full)) type = 'judge';
    else if (/\u586b\u7a7a|\u8f93\u5165|\u7b54\u6848\u586b\u5199|\u4e0b\u62c9/.test(full)) type = 'fill';
    else if (/\u5355\u9009|\u5355\u9879/.test(full)) type = 'single';
    else if (el.querySelector('input[type="checkbox"]')) type = 'multi';
    else if (el.querySelector('input[type="radio"]')) type = 'single';

    const optionEls: HTMLElement[] = [];
    const inputs = Array.from(
      el.querySelectorAll('input[type="radio"],input[type="checkbox"]')
    ) as HTMLInputElement[];
    for (const inp of inputs) {
      const host = inp.closest('label') as HTMLElement | null;
      if (!host) continue;
      if (!optionEls.includes(host)) optionEls.push(host);
      if (inp.id) {
        const lbl = el.querySelector('label[for="' + inp.id + '"]') as HTMLElement | null;
        if (lbl && !optionEls.includes(lbl)) optionEls.unshift(lbl);
      }
    }
    if (optionEls.length < 2) {
      const lettered = Array.from(el.querySelectorAll('li,label,div,span,p,td')) as HTMLElement[];
      for (const c of lettered) {
        const t = clean(c.innerText || c.textContent || '');
        if (t.length > 0 && t.length <= 300 && /^[A-Ha-h]\s*[\.\u3001\uff0e,)）:\uff1a]/.test(t)) {
          if (!optionEls.includes(c)) optionEls.push(c);
        }
      }
    }

    const options: QuizOption[] = [];
    optionEls.slice(0, 8).forEach((oe, oi) => {
      const label = String.fromCharCode(65 + oi);
      oe.setAttribute('data-qh', qi + ':' + label);
      const text = clean(oe.innerText || oe.textContent || '')
        .replace(new RegExp('^' + label + '\\s*[\\.\\u3001\\uff0e,)）:\\uff1a]?\\s*'), '')
        .slice(0, 200);
      options.push({ label, text });
    });

    // 页面已透露的答案：已勾选的 input，或带正确答案标记 class 的选项。
    // 超星在「查看答案/已提交」状态下会把正确项标出来，此时不该再去问 AI。
    let revealed: string | undefined;
    for (const inp of inputs) {
      if (!inp.checked) continue;
      const host = inp.closest('label') as HTMLElement | null;
      const m = options.find(o => o.label === (host?.getAttribute('data-qh') || '').split(':')[1]);
      revealed = (m?.label || 'A') as string;
      break;
    }
    if (!revealed) {
      for (const o of options) {
        const host = optionEls[options.indexOf(o)];
        const cls = String((host?.className || '') + ' ' + Array.from(host?.querySelectorAll('[class]') || [])
          .map(e => String((e as HTMLElement).className || ''))
          .join(' '));
        if (/(?:right|correct|daan|answer[-_]?right|is[-_]?right|success)/i.test(cls)) {
          revealed = o.label;
          break;
        }
      }
    }

    const fillInputs = Array.from(
      el.querySelectorAll('input[type="text"],input:not([type]),textarea')
    ) as HTMLInputElement[];
    fillInputs.forEach((inp, fi) => inp.setAttribute('data-qhf', String(qi) + ':' + fi));

    let stem = full;
    for (const o of options) {
      if (o.text && stem.includes(o.text)) stem = stem.replace(o.text, ' ');
    }
    stem = clean(stem).slice(0, 400);

    questions.push({
      index: qi + 1,
      stem: stem || ('\u7b2c' + (qi + 1) + '\u9898'),
      type,
      options,
      hasInput: fillInputs.length > 0,
      revealed,
    });
  });

  return { questions };
}

/** 找到含题目的 frame（含主页面） */
export async function findQuizFrames(page: Page): Promise<Frame[]> {
  const out: Frame[] = [];
  for (const frame of page.frames()) {
    try {
      const hit = await frame.evaluate((words: string) => {
        const re = new RegExp(words);
        const t = (document.body && document.body.innerText) || '';
        return re.test(t) && t.length > 20;
      }, QUIZ_WORDS.source);
      if (hit) out.push(frame);
    } catch {}
  }
  return out;
}

/** 找弹窗式答题容器（随堂练习弹窗等），返回 frame + 容器选择器 */
export async function findQuizPopup(
  page: Page
): Promise<{ frame: Frame; selector: string; text: string } | null> {
  for (const frame of page.frames()) {
    try {
      const found = await frame.evaluate(
        (args: { sels: string[]; quiz: string; submit: string }) => {
          const clean = (s: string) =>
            (s || '').replace(/\u00a0/g, ' ').replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
          const quizRe = new RegExp(args.quiz);
          const subRe = new RegExp(args.submit);
          let best: { el: HTMLElement; t: string } | null = null;
          for (const sel of args.sels) {
            let els: HTMLElement[] = [];
            try {
              els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
            } catch {
              continue;
            }
            for (const el of els) {
              if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
              const t = clean(el.innerText || el.textContent || '');
              if (!t || t.length < 8 || t.length > 6000) continue;
              const hasChoice = el.querySelector('input[type="radio"],input[type="checkbox"]');
              const hasText = el.querySelector('input[type="text"],textarea');
              if (!hasChoice && !hasText) continue;
              if (!quizRe.test(t) && !subRe.test(t)) continue;
              if (!best || t.length < best.t.length) best = { el, t };
            }
          }
          if (!best) return null;
          const id = best.el.id;
          if (id) {
            try {
              const probe = document.querySelector('#' + CSS.escape(id));
              if (probe === best.el) return { selector: '#' + CSS.escape(id), text: best.t };
            } catch {}
          }
          best.el.setAttribute('data-qh-popup', '1');
          return { selector: '[data-qh-popup="1"]', text: best.t };
        },
        { sels: POPUP_SELECTORS, quiz: QUIZ_WORDS.source, submit: SUBMIT_WORDS.source }
      );
      if (found) return { frame, selector: found.selector, text: found.text };
    } catch {}
  }
  return null;
}

/** 从 frame+容器提取题目 */
export async function extractQuestions(
  frame: Frame,
  containerSelector?: string
): Promise<QuizQuestion[]> {
  const { questions } = await frame.evaluate(
    (args: { sel?: string; fn: string }) => {
      const root = args.sel ? (document.querySelector(args.sel) as HTMLElement | null) : null;
      // eslint-disable-next-line no-new-func
      const fn = new Function('return (' + args.fn + ')()') as () => { questions: unknown[] };
      const res = fn();
      return res as { questions: QuizQuestion[] };
    },
    { sel: containerSelector, fn: extractInPage.toString() }
  );
  return questions;
}

/** 判断题归一化 */
function judgeTarget(answer: string): 'right' | 'wrong' | null {
  const a = answer.trim();
  if (/^(对|正确|是|T|true|right|correct)$/i.test(a)) return 'right';
  if (/^(错|错误|否|F|false|wrong|incorrect)$/i.test(a)) return 'wrong';
  return null;
}

/** 把答案点到页面上，返回点击/填写数量 */
export async function applyAnswers(
  page: Page,
  frame: Frame,
  questions: QuizQuestion[],
  answers: Array<{ i: number; answer: string }>,
  containerSelector: string | undefined,
  h: EngineHooks
): Promise<number> {
  const scope = (sel: string) =>
    containerSelector ? frame.locator(containerSelector).locator(sel) : frame.locator(sel);

  let done = 0;
  for (const item of answers) {
    h.ctl.throwIfStopped();
    const q = questions.find(x => x.index === item.i);
    if (!q) continue;
    const ans = String(item.answer || '').trim();
    if (!ans || ans === '?' || ans === '\uff1f') {
      h.log('info', `      Q${q.index} \u8df3\u8fc7`);
      continue;
    }

    let ok = 0;
    const letters = (ans.match(/[A-Ha-h]/g) || []).map(c => c.toUpperCase());

    if (q.type === 'fill' || (q.hasInput && !letters.length)) {
      const inputs = scope(`[${FILL_ATTR}^="${q.index}:"]`);
      const n = await inputs.count().catch(() => 0);
      const parts = ans.split(/[\uff1b;\uff0c,]/).map(s => s.trim()).filter(Boolean);
      for (let k = 0; k < n; k++) {
        const v = parts[k] || parts[0] || ans;
        try {
          await inputs.nth(k).fill(v, { timeout: 2000 });
          ok++;
          h.log('info', `      Q${q.index} \u586b\u7a7a "${v}" \u2713`);
        } catch {}
      }
      done += ok;
      if (ok) continue;
    }

    if (q.type === 'judge') {
      const target = judgeTarget(ans);
      const opts = q.options;
      let pick = -1;
      if (target) {
        pick = opts.findIndex(o => {
          const t = o.text.replace(/[.\u3001\uff0e,)）:\uff1a]/g, '').trim();
          return target === 'right'
            ? /(\u6b63\u786e|\u5bf9|\u662f)$/.test(t) || t === '\u6b63\u786e' || t === '\u5bf9'
            : /(\u9519\u8bef|\u9519|\u5426)$/.test(t) || t === '\u9519\u8bef' || t === '\u9519';
        });
        if (pick < 0) {
          pick = opts.findIndex(o =>
            target === 'right' ? /\u6b63\u786e|\u5bf9/.test(o.text) : /\u9519\u8bef|\u9519/.test(o.text)
          );
        }
        // 匹配不到选项文本就放弃：原来的写法是 `pick = target==='right'?0:1`，
        // 等于用「第一个选项就是对/错」的假设蒙一枪 —— 猜错就是实打实的错题，
        // 且日志上看不出它只是猜的。这里宁可留空让覆盖率闸门去拦。
        if (pick < 0) {
          h.log('info', `      Q${q.index} 判断题选项文本对不上，跳过`);
          continue;
        }
      } else if (letters[0]) {
        pick = 'ABCDEFGH'.indexOf(letters[0]);
      }
      if (pick >= 0 && pick < opts.length) {
        const label = opts[pick].label;
        try {
          await scope(`[${MARK_ATTR}="${q.index}:${label}"]`).first().click({ force: true, timeout: 2500 });
          ok++;
          h.log('info', `      Q${q.index} ${label} (\u5224\u65ad) \u2713`);
        } catch {}
      }
      done += ok;
      if (ok) continue;
    }

    const list = letters.length ? letters : ['A'];
    for (const ch of list) {
      try {
        await scope(`[${MARK_ATTR}="${q.index}:${ch}"]`).first().click({ force: true, timeout: 2500 });
        ok++;
        h.log('info', `      Q${q.index} ${ch} \u2713`);
      } catch {}
    }

    if (!ok) {
      // 兜底：按文本前缀找选项
      for (const ch of list) {
        try {
          const t = scope(`text=/^\\s*${ch}\\s*[\\.\\u3001\\uff0e,)）:]/`).first();
          if (await t.count()) {
            await t.click({ force: true, timeout: 2000 });
            ok++;
            h.log('info', `      Q${q.index} ${ch} (\u6587\u672c\u5339\u914d) \u2713`);
          }
        } catch {}
      }
    }
    done += ok;
  }
  return done;
}

/** 点击提交/确定并等待弹窗关闭 */
export async function submitQuizIn(
  page: Page,
  frame: Frame,
  containerSelector: string | undefined,
  h: EngineHooks,
  label: string
): Promise<boolean> {
  const scope = (sel: string) =>
    containerSelector ? frame.locator(containerSelector).locator(sel) : frame.locator(sel);
  const btns = [
    'button:has-text("\u786e\u5b9a")',
    'button:has-text("\u63d0\u4ea4")',
    'a:has-text("\u63d0\u4ea4")',
    'button:has-text("\u4ea4\u5377")',
    'button:has-text("\u786e\u8ba4")',
    'button:has-text("\u5b8c\u6210")',
    'button:has-text("\u63d0\u4ea4\u7b54\u6848")',
  ];
  for (const b of btns) {
    try {
      const loc = scope(b);
      const n = await loc.count();
      for (let i = n - 1; i >= 0; i--) {
        try {
          await loc.nth(i).click({ force: true, timeout: 2000 });
          await h.ctl.sleep(1200);
          const confirm = page.locator(
            '.layui-layer-btn0, .layui-layer-btn1, button:has-text("\u786e\u5b9a"), .el-message-box__btns button'
          );
          if (await confirm.count()) {
            await confirm.last().click({ force: true, timeout: 2000 }).catch(() => {});
            await h.ctl.sleep(1000);
          }
          h.log('ok', `    \u2713 ${label}`);
          return true;
        } catch {}
      }
    } catch {}
  }
  return false;
}

export interface QuizOptions {
  /** 本地题库：命中则不调用 AI */
  tiku?: TikuStore | null;
  /**
   * 交卷前要求的最低答案覆盖率（0~1）。低于则不交卷，只留给人核对。
   * 0 = 关闭闸门。默认 0.8 与 Tide 同取值。
   */
  submitCoverRate?: number;
}

export const DEFAULT_SUBMIT_COVER_RATE = 0.8;

export interface QuizOutcome {
  answered: number;
  success: boolean;
  /** 实际答案覆盖率 */
  coverage: number;
}

/**
 * 章节测验答题（章首作业/测验页）
 *
 * 答案走四级优先级链：
 *   1. 页面已透露（已勾选 / 正确项 class）→ 不花钱
 *   2. 本地题库 tiku.json → 不花钱
 *   3. AI 通道 → 花钱
 *   4. 都拿不到 → 留空，由覆盖率闸门决定要不要交卷
 */
export async function handleQuiz(
  page: Page,
  h: EngineHooks,
  apiKey: string | undefined,
  ch?: AnswerChannel | null,
  opts?: QuizOptions
): Promise<QuizOutcome> {
  h.log('info', '    \u2192 \u68c0\u6d4b\u5230\u7b54\u9898\u9875\u9762');
  const options = opts ?? {};
  const store = options.tiku ?? null;

  const frames = await findQuizFrames(page);
  let questions: QuizQuestion[] = [];
  let frame: Frame | null = null;
  for (const f of frames) {
    const qs = await extractQuestions(f).catch(() => [] as QuizQuestion[]);
    if (qs.length > questions.length) {
      questions = qs;
      frame = f;
    }
  }
  if (!frame || !questions.length) {
    h.log('warn', '    \u26a0 \u672a\u80fd\u89e3\u6790\u51fa\u9898\u76ee');
    return { answered: 0, success: false, coverage: 0 };
  }

  // ─\u2500\u2500 第 1 级：页面自己已经透露的答案 ─────────────────────────
  const answers = new Map<number, string>();
  for (const q of questions) {
    if (q.revealed) answers.set(q.index, q.revealed);
  }
  const pending = questions.filter(q => !answers.has(q.index));
  h.log(
    'info',
    `    \u2192 \u89e3\u6790\u51fa ${questions.length} \u9898` +
      (answers.size ? `\uff0c\u5176\u4e2d ${answers.size} \u9898\u9875\u9762\u5df2\u7ed9\u51fa\u7b54\u6848` : '')
  );

  // ─\u2500\u2500 第 2/3 级：本地题库 \u2192 AI ──────────────────────────────────
  if (pending.length) {
    const chain: Searcher[] = [];
    if (store) chain.push(new CacheSearcher(store));

    const channel: AnswerChannel | null = ch
      ? ch
      : apiKey
        ? { baseUrl: 'https://api.deepseek.com/v1', apiKey, model: 'deepseek-chat', label: 'DeepSeek' }
        : null;
    if (!channel?.apiKey) {
      h.log('warn', '    \u26a0 \u672a\u914d\u7f6e AI \u63a5\u53e3');
    } else {
      chain.push(new LlmSearcher(channel));
    }

    if (!chain.length) {
      h.log('warn', '    \u26a0 \u6ca1\u6709\u53ef\u7528\u641c\u9898\u5668\uff0c\u5168\u90e8\u7559\u7a7a');
    } else {
      const got = await resolveAnswers(pending, chain, q =>
        h.log('info', `      Q${q.index} \u65e0\u89e3\uff0c\u7559\u7a7a`)
      );
      for (const [k, v] of got) answers.set(k, v);
    }
  }

  // ─\u2500\u2500 \u8986\u76d6\u7387\u95f8\u95e8 ─────────────────────────────────────────
  // \u641c\u4e0d\u5168\u5c31\u4ea4\u5377 = \u628a\u786e\u5b9a\u7684\u9519\u9898\u4e00\u8d77\u4ea4\u4e0a\u53bb\uff0c\u5224\u5206\u6bd4\u7559\u7a7a\u66f4\u7cdf\uff08\u53ef\u80fd\u5931\u53bb\u91cd\u505a\u673a\u4f1a\uff09\u3002
  const answeredRatio = questions.length ? answers.size / questions.length : 0;
  const coverRate = options.submitCoverRate ?? DEFAULT_SUBMIT_COVER_RATE;
  const shouldSubmit = coverRate <= 0 || answeredRatio >= coverRate;

  h.log(
    'ok',
    `    \u2192 \u7b54\u6848\u8986\u76d6 ${answers.size}/${questions.length} ` +
      `(${Math.round(answeredRatio * 100)}%)\uff0c\u95f8\u95e8 ${coverRate <= 0 ? '\u5173\u95ed' : Math.round(coverRate * 100) + '%'}`
  );
  if (!shouldSubmit) {
    h.log(
      'warn',
      `    \u26a0 \u8986\u76d6\u7387\u4e0d\u8db3\uff08${Math.round(answeredRatio * 100)}% < ` +
        `${Math.round(coverRate * 100)}%\uff09\uff0c\u672c\u8f6e\u4e0d\u4ea4\u5377\uff0c\u7b49\u4eba\u5de5\u6838\u5bf9`
    );
    return { answered: 0, success: false, coverage: answeredRatio };
  }

  const payload = [...answers.entries()].map(([i, answer]) => ({ i, answer })).sort((a, b) => a.i - b.i);
  const answered = await applyAnswers(page, frame, questions, payload, undefined, h);

  // ─\u2500\u2500 \u6c89\u6dc0\uff1a\u53ea\u6709\u771f\u6b63\u70b9\u5230\u9875\u9762\u4e0a\u7684\u7b54\u6848\u624d\u5165\u5e93 ─────────────────────────
  if (store) {
    for (const [i, a] of answers) {
      if (payload.some(p => p.i === i) && a) {
        store.put(questions.find(q => q.index === i)?.stem ?? '', a);
      }
    }
    store.flush();
    h.log('info', `    \u00b7 \u672c\u5730\u9898\u5e93\u73b0\u6709 ${store.size()} \u9898`);
  }

  const success =
    answered > 0 && (await submitQuizIn(page, frame, undefined, h, '\u5df2\u63d0\u4ea4\u7ae0\u8282\u4f5c\u4e1a'));
  if (!answered) h.log('warn', '    \u26a0 \u4e00\u9898\u672a\u70b9\u5230');
  return { answered, success, coverage: answeredRatio };
}

/**
 * 视频中途随堂弹窗答题：可连续处理多个弹窗。
 *
 * 与 handleQuiz 共用同一条答案链和覆盖率闸门 —— 弹窗同样不该「猜」。
 * 单个弹窗答不全时按选项闸门处理：默认不提交，关掉它让视频继续，
 * 总比提交一份确定错误的答案强。
 */
export async function handleQuizPopup(
  page: Page,
  h: EngineHooks,
  apiKey: string | undefined,
  channel?: AnswerChannel | null,
  opts?: QuizOptions
): Promise<{ answered: number; popups: number; submitted: number }> {
  const options = opts ?? {};
  const store = options.tiku ?? null;
  let answered = 0;
  let popups = 0;
  let submitted = 0;

  const ch: AnswerChannel | null = channel
    ? channel
    : apiKey
      ? { baseUrl: 'https://api.deepseek.com/v1', apiKey, model: 'deepseek-chat', label: 'DeepSeek' }
      : null;
  if (!ch?.apiKey) return { answered, popups, submitted };

  for (let round = 0; round < 6; round++) {
    h.ctl.throwIfStopped();
    const popup = await findQuizPopup(page);
    if (!popup) break;

    const questions = await extractQuestions(popup.frame, popup.selector).catch(() => [] as QuizQuestion[]);
    if (!questions.length) {
      h.log('warn', '    \u26a0 \u5f39\u7a97\u5185\u672a\u89e3\u6790\u51fa\u9898\u76ee');
      break;
    }
    popups++;

    // 同一套优先级：页面已给出 > 本地题库 > AI
    const answers = new Map<number, string>();
    for (const q of questions) if (q.revealed) answers.set(q.index, q.revealed);
    const pending = questions.filter(q => !answers.has(q.index));
    const chain: Searcher[] = [];
    if (store) chain.push(new CacheSearcher(store));
    chain.push(new LlmSearcher(ch));
    const got = await resolveAnswers(pending, chain);
    for (const [k, v] of got) answers.set(k, v);

    const ratio = questions.length ? answers.size / questions.length : 0;
    const gate = options.submitCoverRate ?? DEFAULT_SUBMIT_COVER_RATE;
    h.log(
      'info',
      `    \u2192 \u968f\u5802\u7ec3\u4e60\u5f39\u7a97\uff08${questions.length} \u9898\uff0c\u8986\u76d6 ${Math.round(ratio * 100)}%\uff09`
    );
    if (gate > 0 && ratio < gate) {
      h.log(
        'warn',
        `    \u26a0 \u5f39\u7a97\u8986\u76d6\u7387\u4e0d\u8db3\uff08${Math.round(ratio * 100)}% < ${Math.round(gate * 100)}%\uff09\uff0c\u4e0d\u63d0\u4ea4\uff0c\u4ec0\u4e48\u90fd\u4e0d\u70b9`
      );
      break;
    }

    try {
      const payload = [...answers.entries()].map(([i, answer]) => ({ i, answer }));
      answered += await applyAnswers(page, popup.frame, questions, payload, popup.selector, h);
      if (store) {
        for (const [i, a] of answers) store.put(questions.find(q => q.index === i)?.stem ?? '', a);
      }
    } catch (e: any) {
      h.log('error', `    \u2717 \u5f39\u7a97\u7b54\u9898: ${e.message}`);
      break;
    }

    const ok = await submitQuizIn(page, popup.frame, popup.selector, h, '\u5f39\u7a97\u5df2\u63d0\u4ea4');
    if (!ok) break;
    submitted++;
    await h.ctl.sleep(800);
    // 关闭后确认弹窗真的消失，否则会对着同一个弹窗重复提交
    let gone = false;
    for (let k = 0; k < 8; k++) {
      await h.ctl.sleep(500);
      if (!(await findQuizPopup(page))) {
        gone = true;
        break;
      }
    }
    if (!gone) break;
    h.log('ok', '    \u2713 \u5f39\u7a97\u5173\u95ed\uff0c\u7ee7\u7eed\u64ad\u653e\u89c6\u9891');
  }
  return { answered, popups, submitted };
}

/** 兼容旧调用 */
export async function isQuizPage(page: Page): Promise<boolean> {
  if (await findQuizPopup(page)) return true;
  const frames = await findQuizFrames(page);
  for (const f of frames) {
    const qs = await extractQuestions(f).catch(() => [] as QuizQuestion[]);
    if (qs.length) return true;
  }
  return false;
}

export async function getQuizPageText(page: Page): Promise<string> {
  const frames = await findQuizFrames(page);
  for (const f of frames) {
    try {
      const t = await f.evaluate(() => (document.body && document.body.innerText) || '');
      if (t) return t;
    } catch {}
  }
  return '';
}

export async function getQuizFrame(page: Page) {
  return page
    .frameLocator('#iframe')
    .frameLocator('iframe')
    .frameLocator('iframe[name="frame_content"], iframe');
}

export async function askDeepSeekForPage(apiKey: string, pageText: string): Promise<any[]> {
  const LIMIT_MS = 45000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LIMIT_MS);
  let resp: Response;
  try {
    resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content:
              '\u4f60\u662f\u7b54\u9898\u52a9\u624b\u3002\u5206\u6790\u6d4b\u9a8c\u7f51\u9875\u6587\u672c\uff0c\u9009\u51fa\u6bcf\u9898\u6b63\u786e\u7b54\u6848\u3002\u8fd4\u56deJSON: [{"question":1,"answer":"A","note":"\u89e3\u91ca"}]\u3002answer: \u5355\u9009="A", \u591a\u9009="AB", \u5224\u65ad="\u5bf9"/"\u9519", \u586b\u7a7a\u5199\u6587\u5b57\u3002\u4e0d\u786e\u5b9a\u586b"?"\u3002\u53ea\u8f93\u51faJSON\u3002',
          },
          { role: 'user', content: `\u56de\u7b54\u4ee5\u4e0b\u6d4b\u9a8c:\n\n${pageText}` },
        ],
        temperature: 0.1,
        max_tokens: 2000,
      }),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    clearTimeout(timer);
    throw new Error(
      e?.name === 'AbortError'
        ? `DeepSeek 超时（${LIMIT_MS / 1000}s）`
        : `DeepSeek 连接失败: ${String(e?.message || e).slice(0, 60)}`
    );
  }
  clearTimeout(timer);
  if (!resp.ok) throw new Error(`DeepSeek API ${resp.status}`);
  const raw = ((await resp.json()) as any).choices?.[0]?.message?.content || '';
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('AI \u683c\u5f0f\u9519\u8bef: ' + raw.substring(0, 100));
  return JSON.parse(m[0]);
}

export async function clickAnswersByLabel(
  page: Page,
  h: EngineHooks,
  answers: any[]
): Promise<number> {
  const frames = await findQuizFrames(page);
  let frame: Frame | null = null;
  let questions: QuizQuestion[] = [];
  for (const f of frames) {
    const qs = await extractQuestions(f).catch(() => [] as QuizQuestion[]);
    if (qs.length > questions.length) {
      questions = qs;
      frame = f;
    }
  }
  if (!frame) return 0;
  return applyAnswers(
    page,
    frame,
    questions,
    answers.map(a => ({ i: Number(a.question) || 0, answer: String(a.answer || '') })),
    undefined,
    h
  );
}

export async function submitQuiz(page: Page, h: EngineHooks): Promise<boolean> {
  const frames = await findQuizFrames(page);
  const frame = frames[frames.length - 1] || page.mainFrame();
  return submitQuizIn(page, frame, undefined, h, '\u5df2\u63d0\u4ea4');
}