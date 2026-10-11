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
  // 不要把 '#workpop' / '#hintPop' / '.popDiv' 加进来：这些容器在超星页面上是常驻的，
  // 页面一打开就存在（内容只有「提示」），按它们判断会永远误报。
  // 视频随堂弹题另有一套契约，见 videoQuiz.ts。
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

/**
 * 超星的题目容器。
 *
 * 抓包实测（mooc-ans/work/selectWorkQuestionYiPiYue）：
 *   <div id="question210712502" class="TiMu newTiMu ans-cc singleQuesId">
 *     <div class="Zy_TItle">1 【单选题】 ...</div>
 *     <span class="newZy_TItle">【单选题】</span>
 *     <div class="answerScore">10.0分</div>
 *   </div>
 *
 * ⚠️ 下面的 extractInPage 通过 `fn.toString()` 注入页面执行，页面里没有模块
 * 作用域。所以它用到的一切常量都必须定义在函数体内部 —— 提到模块级会直接
 * ReferenceError。这一点是实际踩过坑的，不要「顺手」把常量提出去。
 */
/** 在页面内提取题目结构，并给可点击项打 data-qh 标记 */
function extractInPage(): { questions: QuizQuestion[] } {
  // ⚠️ 以下常量必须留在函数体内：本函数会被 toString() 后注入页面执行
  const QUESTION_SELECTORS = [
    '.TiMu.newTiMu',
    '.TiMu',
    '.Zi_mu',
    '.newTiMu',
    '[id^="question"]',
    '.TiMuList li',
    '.mark_letter',
    '.ZYAnswer .clearfix',
  ];
  /** 选项行：`A、xxx` / `B.xxx` / `C)` 等超星与通用写法 */
  const OPTION_LINE = /^\s*([A-Ha-h])\s*[\.\u3001\uff0e,)）:\uff1a]\s*(\S[^\n]{0,200}?)\s*$/;
  /**
   * 跨行扫描选项。
   *
   * 超星有两种渲染：
   *   可作答态  <li class="before-after" role="radio">A attainable</li>
   *   回看态    纯文本，且四个选项可能挤在同一行（"A attainable B endurable ..."）
   * 后者按行切分完全失效，必须全局扫描，靠「下一个字母标记」断边界。
   */
  const scanOptions = (text: string) => {
    const out: Array<{ label: string; text: string }> = [];
    const re =
      /(?:^|[\s\u3000])([A-Ha-h])\s*[\.\u3001\uff0e,)）:\uff1a]\s*([^\s\u3000][^]*?)(?=(?:[\s\u3000][A-Ha-h]\s*[\.\u3001\uff0e,)）:\uff1a])|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        // 回看态每个选项后面跟着「我的答案：X」，别把它算进选项正文
        const t = (m[2] || '').split(/\s*我的答案\s*[:：]?/)[0].trim().slice(0, 200);
        out.push({ label: m[1].toUpperCase(), text: t });
      if (out.length >= 8) break;
    }
    return out;
  };
  const TYPE_BADGE = /[\uff08(]?\s*(单选|多选|判断|填空|问答|简答|论述|选择)[\uff09)]?\s*题?/;

  const clean = (s: string) => (s || '').replace(/\u00a0/g, ' ').replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  // 备选行数：>=2 行才认为是选择题。超星的回看态没有 input/label，
  // 只靠「有没有可点元素」判断会把整份卷子漏掉。
  const countOptionLines = (t: string) => {
    let n = 0;
    for (const line of (t || '').split(/[\n\r]+/)) {
      if (OPTION_LINE.test(line.trim())) n++;
    }
    return n;
  };

  // ── 收集候选：先显式选择器，再全文启发式 ──────────────────────────
  const picked: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  for (const sel of QUESTION_SELECTORS) {
    let els: HTMLElement[] = [];
    try {
      els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
    } catch {
      continue;
    }

  // 包含关系去重。超星的结构是
  //   <div id="question404390558" class="singleQuesId"><div class="TiMu newTiMu">…</div></div>
  // 外层命中 [id^=question]、内层命中 .TiMu，是两个不同元素，seen 去不了重。
  // 不去重会有两个后果：每道题被数两遍；后一轮写 data-qh 时覆盖前一轮的索引，
  // 于是靠前的那一半题目 applyAnswers 找不到标记、静默点不动。只保留最外层。
  const outermost = picked.filter(el => !picked.some(o => o !== el && o.contains(el)));
  picked.length = 0;
  picked.push(...outermost);
    for (const el of els) {
      const t = clean(el.innerText || el.textContent || '');
      // 显式命中 .TiMu 之类的题目容器时不做长度上限：含 MathML/公式的题
      // innerText 轻易超过 1200（公式注解文本全算进去），一旦按上限过滤就会
      // 整题丢失，只剩下被误当成题目的选项容器。
      if (t.length < 4) continue;
      if (seen.has(el)) continue;
      seen.add(el);
      picked.push(el);
    }
  }

  if (!picked.length) {
    // 启发式兜底：题干以序号开头，或文本里出现题型关键词，且能判定为选择/填空
    const isQStem = (t: string) =>
      /^\s*[\uff08(]?\s*\d{1,3}\s*[\.\u3001\uff0e,)）:\uff1a\u3011\uFF3D\s*]/.test(t) ||
      /^\s*\d{1,3}\s+[\u3010\[\uff08(]/.test(t) ||      // "1 【单选题】"
      TYPE_BADGE.test(t);
    const nodes = Array.from(document.querySelectorAll('div,li,td,section,p,dd,article,form')) as HTMLElement[];
    const cand: HTMLElement[] = [];
    for (const el of nodes) {
      const t = clean(el.innerText || el.textContent || '');
      if (t.length < 4 || t.length > 1200) continue;
      if (!isQStem(t)) continue;
      const hasChoice =
        el.querySelector('input[type="radio"],input[type="checkbox"],label,[aria-label],[role=radio],[role=checkbox]') ||
        el.querySelector('input[type="text"],input:not([type]),textarea') ||
        countOptionLines(el.innerText || el.textContent || '') >= 2;
      if (!hasChoice) continue;
      cand.push(el);
    }
    const inner = cand.filter(el => !cand.some(o => o !== el && el.contains(o)));
    picked.push(...(inner.length ? inner : cand.slice(0, 30)));
  }

  // 先清掉上一轮提取留下的标记。extractQuestions 会对多个 frame 各跑一遍，
  // 同一批 DOM 元素会被反复重写标记；不清的话会出现「某些题目的标记来自
  // 另一次提取、索引刚好对得上」的假象 —— 症状是点选时灵时不灵。
  document.querySelectorAll('[data-qh],[data-qhf]').forEach(n => {
    n.removeAttribute('data-qh');
    n.removeAttribute('data-qhf');
  });

  const questions: QuizQuestion[] = [];
  picked.slice(0, 60).forEach((el, qi) => {
    const qIdx = qi + 1;
    const raw = el.innerText || el.textContent || '';
    const full = clean(raw);
    const rawLines = raw.split(/[\n\r]+/).map(s => s.trim()).filter(Boolean);

    // ── 题型：优先取角标，其次题干里的关键词 ───────────────────────
    let type: QType = 'unknown';
    const badgeEl = el.querySelector('.newZy_TItle, .Zy_TItle, .tiMuTitle');
    const badge = clean(badgeEl?.textContent || '') || full.slice(0, 40);
    if (/多选|多项/.test(badge)) type = 'multi';
    else if (/判断/.test(badge)) type = 'judge';
    else if (/填空|输入|下拉/.test(badge)) type = 'fill';
    else if (/单选|单项/.test(badge)) type = 'single';
    else if (/问答|简答|论述/.test(badge)) type = 'fill';
    else if (/多选|多项/.test(full)) type = 'multi';
    else if (/判断/.test(full)) type = 'judge';
    else if (/填空|输入|答案填写|下拉/.test(full)) type = 'fill';
    else if (/单选|多项/.test(full)) type = 'single';
    else if (el.querySelector('input[type="checkbox"]')) type = 'multi';
    else if (el.querySelector('input[type="radio"]')) type = 'single';

    // ── 选项 ────────────────────────────────────────────────────────
    // 实测（doHomeWorkNew）：选项是 <li class="before-after" role="radio">，
    // 文本自带字母前缀（"A attainable"），既没有 input[type=radio] 也没有 aria-checked；
    // 同级的 <label class="fl"> 只有字母，不能当选项。
    const optionEls: HTMLElement[] = [];
    const inputs = Array.from(
      el.querySelectorAll('input[type="radio"],input[type="checkbox"]')
    ) as HTMLInputElement[];
    for (const inp of inputs) {
      const host = inp.closest('label') as HTMLElement | null;
      if (host && !optionEls.includes(host)) optionEls.push(host);
      if (inp.id) {
        const lbl = el.querySelector('label[for="' + inp.id + '"]') as HTMLElement | null;
        if (lbl && !optionEls.includes(lbl)) optionEls.unshift(lbl);
      }
    }
    if (optionEls.length < 2) {
      const roleOpts = Array.from(
        el.querySelectorAll('li[role="radio"],li[role="checkbox"],[role="radio"],[role="checkbox"],li.before-after')
      ) as HTMLElement[];
      // 过滤掉只含单个字母的徽标（超星的 <label class="fl before">A</label>）
      for (const o of roleOpts) {
        const t = clean(o.textContent || '');
        if (t.length <= 2 && !/\b[A-H]\b/.test(t)) continue;
        if (!optionEls.includes(o)) optionEls.push(o);
      }
    }
    // 文字版选项：元素一个都没有时，从纯文本里扫
    const textOptions = optionEls.length >= 2 ? null : scanOptions(raw);
    if (optionEls.length < 2) {
      // 回看态没有 label/li，选项就是纯文本行 `A、xxx`
      for (const line of rawLines) {
        const m = line.match(OPTION_LINE);
        if (!m) continue;
        const node = Array.from(el.querySelectorAll('li,label,div,span,p,td')).find(
          c => clean(c.textContent || '') === clean(line)
        ) as HTMLElement | undefined;
        const host = node || el;
        if (!optionEls.includes(host)) optionEls.push(host);
      }
    }

    const options: QuizOption[] = [];
    const optionTexts: string[] = [];
    if (optionEls.length >= 2) {
      optionEls.slice(0, 8).forEach((oe, oi) => {
        const label = String.fromCharCode(65 + oi);
        oe.setAttribute('data-qh', qIdx + ':' + label);
        const text = clean(oe.innerText || oe.textContent || '')
          .replace(new RegExp('^' + label + '\\s*[\\.\\u3001\\uff0e,)）:\\uff1a]?\\s*'), '')
          .slice(0, 200);
        options.push({ label, text });
        optionTexts.push(text);
      });
    } else if (textOptions && textOptions.length >= 2) {
      // 文字版：只有文本、没有元素可点。回看态本来也不作答，能解析出来主要是
      // 为了让 AI 搜题与题库沉淀可用；applyAnswers 因缺 data-qh 会点不到，
      // 日志里体现为「一题未点到」，不会误判成已答。
      for (const o of textOptions) {
        options.push({ label: o.label, text: o.text });
        optionTexts.push(o.text);
      }
    }

    const fillInputs = Array.from(
      el.querySelectorAll('input[type="text"],input:not([type]),textarea')
    ) as HTMLInputElement[];
    fillInputs.forEach((inp, fi) => inp.setAttribute('data-qhf', String(qIdx) + ':' + fi));

    // ── 题干 ────────────────────────────────────────────────────────
    // 实测 .Zy_TItle 里混着三样东西：题号 <i class="fl">1</i>、题型角标
    // <span class="newZy_TItle">【单选题】</span>、以及真正的题干。直接取
    // textContent 会得到「单选题】Part I: ...」这种带残缺括号的开头，
    // 污染题干也污染题库归一化，所以先克隆再剔除。
    let stem = '';
    const titleEl = el.querySelector('.Zy_TItle, .tiMuTitle, .mark_letter');
    if (titleEl) {
      const clone = titleEl.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('i.fl, .newZy_TItle, .answerScore, .newAnswerScore').forEach(n => n.remove());
      stem = clean(clone.textContent || '');
    }
    if (!stem) {
      stem = rawLines.filter(l => !OPTION_LINE.test(l) && !/^\s*(我的答案|得分|分值)/.test(l)).join(' ');
    }
    if (stem === full) {
      for (const t of optionTexts) if (t && stem.includes(t)) stem = stem.replace(t, ' ');
    }
    stem = clean(stem).replace(/^\s*\d{1,3}\s*[\.\u3001\uff0e,)）:\uff1a\u3010\[\s]*/, '').slice(0, 400);

    // ── 页面已透露的答案 ───────────────────────────────────────────
    // 仅取「已勾选」和「正确项 class」两种硬标记。
    // 回看态的「我的答案：X」是学生当初选的，不是正确答案，不能当答案用。
    let revealed: string | undefined;
    for (const inp of inputs) {
      if (!inp.checked) continue;
      const host = inp.closest('label') as HTMLElement | null;
      const m = options.find(o => o.label === (host?.getAttribute('data-qh') || '').split(':')[1]);
      revealed = m?.label || 'A';
      break;
    }
    if (!revealed) {
      for (const o of options) {
        const host = optionEls[options.indexOf(o)];
        const cls = [host?.className || '', ...Array.from(host?.querySelectorAll('[class]') || []).map(e => String((e as HTMLElement).className || ''))].join(' ');
        // aria-checked 是标准做法；超星实测没给，退而看选中态 class
        if (host?.getAttribute('aria-checked') === 'true') {
          revealed = o.label;
          break;
        }
        if (/\b(checked|selected|active|on)\b/i.test(cls)) {
          revealed = o.label;
          break;
        }
      }
    }
    if (!revealed) {
      // 只认明确的「正确答案」标记，不把学生自己选的那项当答案 ——
      // 回看态里「我的答案：X」是当初选的，不是对的。
      const rightRe = /(?:right|correct|daan|ansRight|isRight|success)/i;
      for (const o of options) {
        const host = optionEls[options.indexOf(o)];
        const cls = [host?.className || '', ...Array.from(host?.querySelectorAll('[class]') || []).map(e => String((e as HTMLElement).className || ''))].join(' ');
        if (rightRe.test(cls)) {
          revealed = o.label;
          break;
        }
      }
    }

    questions.push({
      index: qIdx,
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
/**
 * 超星的测验/作业 frame。
 *
 * 实测这两个 URL 比「正文里出现『单选题』」可靠得多 —— 后者在看完的课程里
 * 整页正文都有这个词，会把非测验 frame 也拖进来。
 */
const QUIZ_FRAME_URL = /selectWorkQuestion|work\/work|VideoQuestion|ExamWork|\/(work|exam)\/(start|answer|question)/i;

export async function findQuizFrames(page: Page): Promise<Frame[]> {
  const out: Frame[] = [];
  for (const frame of page.frames()) {
    if (QUIZ_FRAME_URL.test(frame.url())) {
      out.push(frame);
      continue;
    }
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