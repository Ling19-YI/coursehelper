import type { Page, Frame } from 'playwright';
import type { EngineHooks } from './hooks';

export type QType = 'single' | 'multi' | 'judge' | 'fill' | 'unknown';

export interface QuizOption {
  label: string;
  text: string;
}

export interface QuizQuestion {
  index: number;
  stem: string;
  type: QType;
  options: QuizOption[];
  hasInput: boolean;
}

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

/** 调用 DeepSeek，失败自动重试并清洗 JSON */
export async function askDeepSeek(
  apiKey: string,
  questions: QuizQuestion[]
): Promise<Array<{ i: number; answer: string; note?: string }>> {
  const prompt = buildPrompt(questions);
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
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
    });
    if (!resp.ok) {
      lastErr = `DeepSeek API ${resp.status}`;
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
        if (pick < 0) pick = target === 'right' ? 0 : 1;
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

/** 章节测验答题（章首作业/测验页） */
export async function handleQuiz(
  page: Page,
  h: EngineHooks,
  apiKey: string | undefined
): Promise<{ answered: number; success: boolean }> {
  h.log('info', '    \u2192 \u68c0\u6d4b\u5230\u7b54\u9898\u9875\u9762');
  if (!apiKey) {
    h.log('warn', '    \u26a0 \u672a\u914d\u7f6e DeepSeek API Key\uff0c\u8df3\u8fc7\u7b54\u9898');
    return { answered: 0, success: false };
  }
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
    h.log('warn', '    \u26a0 \u672a\u80fd\u89e3\u6790\u51fa\u9898\u76ee\uff08\u9875\u9762\u7ed3\u6784\u672a\u5339\u914d\uff09');
    return { answered: 0, success: false };
  }
  h.log('info', `    \u2192 \u89e3\u6790\u51fa ${questions.length} \u9898\uff0c\u8bf7\u6c42 AI`);
  let answers: Array<{ i: number; answer: string }>;
  try {
    answers = await askDeepSeek(apiKey, questions);
  } catch (e: any) {
    h.log('error', `    \u2717 AI: ${e.message}`);
    return { answered: 0, success: false };
  }
  h.log('info', `    \u2192 AI \u7ed9\u51fa ${answers.length} \u9898\u7b54\u6848`);
  const answered = await applyAnswers(page, frame, questions, answers, undefined, h);
  const success = answered > 0 && (await submitQuizIn(page, frame, undefined, h, '\u5df2\u63d0\u4ea4\u7ae0\u8282\u4f5c\u4e1a'));
  if (!answered) h.log('warn', '    \u26a0 \u4e00\u9898\u672a\u70b9\u5230');
  return { answered, success };
}

/** 视频中途随堂弹窗答题：可连续处理多个弹窗 */
export async function handleQuizPopup(
  page: Page,
  h: EngineHooks,
  apiKey: string | undefined
): Promise<{ answered: number; popups: number }> {
  let answered = 0;
  let popups = 0;
  if (!apiKey) return { answered, popups };

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
    h.log('info', `    \u2192 \u968f\u5802\u7ec3\u4e60\u5f39\u7a97\uff08${questions.length} \u9898\uff09`);
    try {
      const answers = await askDeepSeek(apiKey, questions);
      answered += await applyAnswers(page, popup.frame, questions, answers, popup.selector, h);
    } catch (e: any) {
      h.log('error', `    \u2717 AI: ${e.message}`);
      break;
    }
    const submitted = await submitQuizIn(page, popup.frame, popup.selector, h, '\u5f39\u7a97\u5df2\u63d0\u4ea4');
    await h.ctl.sleep(800);
    if (!submitted) break;
    // 关闭后确认弹窗真的消失
    let gone = false;
    for (let k = 0; k < 8; k++) {
      await h.ctl.sleep(500);
      if (!(await findQuizPopup(page))) {
        gone = true;
        break;
      }
    }
    if (!gone) break;
    h.log('ok', '    \u2713 \u5f39\u7a94\u5173\u95ed\uff0c\u7ee7\u7eed\u64ad\u653e\u89c6\u9891');
  }
  return { answered, popups };
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
  const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content:
            '\u4f60\u662f\u7b54\u9898\u52a9\u624b\u3002\u5206\u6790\u6d4b\u9a8c\u7f51\u9875\u6587\u672c\uff0c\u9009\u51fa\u6bcf\u9898\u6b63\u786e\u7b54\u6848\u3002\u8fd4\u56deJSON: [{"question":1,"answer":"A","note":"\u89e3\u91ca"}]\u3002answer: \u5355\u9009="A",\u591a\u9009="AB",\u5224\u65ad="\u5bf9"/"\u9519",\u586b\u7a7a\u5199\u6587\u5b57\u3002\u4e0d\u786e\u5b9a\u586b"?"\u3002\u53ea\u8f93\u51faJSON\u3002',
        },
        { role: 'user', content: `\u56de\u7b54\u4ee5\u4e0b\u6d4b\u9a8c:\n\n${pageText}` },
      ],
      temperature: 0.1,
      max_tokens: 2000,
    }),
  });
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