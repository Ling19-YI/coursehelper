import type { Frame, Page } from 'playwright';
import type { EngineHooks } from './hooks';
import type { AnswerChannel, QuizOption, QuizQuestion } from './quizTypes';
import { CacheSearcher, LlmSearcher, resolveAnswers, type Searcher } from './searcher';
import type { TikuStore } from './tiku';

/**
 * 视频播放期间的随堂弹题（超星「视频答题」）。
 *
 * 与章节测验是两套完全不同的 DOM，判定依据是提交按钮而不是文本：
 *   #videoquiz-submit      提交按钮，弹题存在的必要条件
 *   .tkTopic               弹题容器（提交按钮的祖先）
 *   li.ans-videoquiz-opt   每个选项一行，行内有 label 与 input[name=ans-videoquiz-opt]
 *   #spanHas               反馈：答对
 *   #spanNot / #spanNotBack  反馈：答错
 *   #videoquiz-continue    反馈：继续（点一次即可关掉弹题）
 *   #videoquiz-submitting  反馈：提交中（此时不能再点提交，否则重复提交）
 *
 * 没有「反馈」这一层是这类功能最容易翻车的地方：点完提交就当成了，
 * 实际答错了页面还在那儿干等，于是下一个视频节点的进度判定全乱。
 */
export type VideoPopupFeedback = 'open' | 'submitting' | 'correct' | 'incorrect' | 'continue';

const OPT_SEL = 'li.ans-videoquiz-opt';
const SUBMIT_SEL = '#videoquiz-submit';

export interface VideoPopupState {
  present: boolean;
  /** 弹题容器所在的 frame（弹题可能出现在播放器 iframe 内） */
  frame: Frame | null;
  question: QuizQuestion | null;
  feedback: VideoPopupFeedback;
  /** 提交按钮当前是否可见。超星提交后会把 submit 置为 display:none，
   *  此时弹题还在（等「继续学习」点掉），但已经不能也不该再提交一次。 */
  submitVisible: boolean;
  /** 选项数，2 时才允许自动改选 */
  optionCount: number;
}

/** 可见性判定：超星很多容器 display:none 却仍占布局，必须自己判 */
const VISIBLE_FN = `(el) => {
  if (!el) return false;
  const st = getComputedStyle(el);
  if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  return !!(el.offsetParent || st.position === 'fixed' || st.position === 'absolute');
}`;

/**
 * ⚠️ 下面几个 helper 必须以**字符串**形式传进 evaluate，不能写成
 * `const q = (e) => ...` 这样的具名箭头函数。
 *
 * 原因：evaluate 是把函数**序列化成字符串**发到浏览器执行的，而
 * tsx/esbuild（keepNames）会给具名函数注入 `__name(fn, "fn")` 包装，
 * 浏览器侧没有 __name 这个符号 → 整个 evaluate 抛
 * `ReferenceError: __name is not defined`。
 * 更糟的是外层 catch {} 会把它吞掉，表现为「这个检测功能整体失效」，
 * 日志里毫无痕迹。生产构建没开 keepNames（线上一直正常），但用 tsx
 * 跑的真机/DOM 测试会全红 —— 于是同一份代码在两种环境里行为不同。
 *
 * 这个坑项目里已经踩过一次，见 src/main/engine/quiz.ts 顶部注释
 * 与 scripts/test-evaluate-safety.ts。
 */
const Q_FN = `(e) => (e ? (e.textContent || '').replace(/\\s+/g, ' ').trim() : '')`;

/** 「可点元素」用的宽松可见性：面积够大即可，不看 offsetParent */
const VISIBLE_LOOSE_FN = `(el) => {
  if (!el) return false;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
  const r = el.getBoundingClientRect();
  return r.width > 6 && r.height > 6;
}`;


/** 读当前弹题状态。不存在弹题时 present=false。 */
export async function readVideoPopup(page: Page): Promise<VideoPopupState> {
  for (const frame of page.frames()) {
    let st: any;
    try {
      st = await frame.evaluate(
        ({ visibleSrc, qSrc, optSel, submitSel }) => {
          // ⚠️ 这几个 helper 必须用 eval 从字符串取，不能写成
          // `const q = (e) => ...`：打包器（tsx/esbuild 的 keepNames）会给
          // 具名函数注入 `__name(fn, "fn")` 包装，而 evaluate 是把函数
          // **序列化成字符串**发到浏览器执行的，浏览器侧没有 __name →
          // ReferenceError: __name is not defined。
          // 外层 catch {} 会把它吞掉，表现为「这个检测整体失效」，日志毫无痕迹。
          // 这个坑项目里已踩过一次，见 src/main/engine/quiz.ts 顶部注释。
          const visible = eval(visibleSrc) as (el: Element | null) => boolean;
          const q = eval(qSrc) as (e: Element | null) => string;

          const submit = document.querySelector(submitSel);
          const submitVisible = visible(submit);

          // ⚠️ 弹题「存在」不能只看提交按钮可见。
          // 超星 InteractiveQuiz（视频互动测验）提交后会把 #videoquiz-submit
          // 置为 display:none，同时显示 #videoquiz-continue —— 弹题**还在**，
          // 要等玩家点「继续学习」才收尾。若按旧逻辑（submit 不可见就认为
          // 弹题没了），引擎会以为弹题已自动收起，从而永远不去点那个按钮，
          // 弹层就一直盖在页面上挡住后续点击（用户看到的「答完却不动」）。
          const roots: Element[] = [];
          const r1 = (submit as Element | null)?.closest?.('.tkTopic') ?? null;
          if (r1 && roots.indexOf(r1) < 0) roots.push(r1);
          const r2 = document.querySelector('#videoquiz-continue')?.closest('.tkTopic') ?? null;
          if (r2 && roots.indexOf(r2) < 0) roots.push(r2);
          for (const el of Array.from(document.querySelectorAll('.tkTopic'))) {
            if (roots.indexOf(el) < 0) roots.push(el);
          }

          let root: Element | null = null;
          let opts: Element[] = [];
          for (const r of roots) {
            if (!visible(r)) continue;
            const os = Array.from(r.querySelectorAll(optSel)).filter(visible);
            if (os.length < 2) continue;
            // 必须含有弹题自己的控件（提交/继续/提交中），否则只是页面上一个
            // 长得像的空容器（超星页面上常驻一堆空 .tkTopic）
            const hasCtl =
              !!r.querySelector(submitSel) ||
              !!r.querySelector('#videoquiz-continue') ||
              !!r.querySelector('#videoquiz-submitting');
            if (!hasCtl) continue;
            root = r;
            opts = os;
            break;
          }
          if (!root) return null;

          // 反馈判定。顺序要紧：
          //  1) 答错优先（错题要重选）
          //  2) 「继续学习」按钮：InteractiveQuiz 答对后它与「恭喜你，答对了！」同时可见，
          //     走到这一步说明已经答完，只等点掉
          //  3) 提交中
          //  4) 答对（必须同时匹配「答对/恭喜」字样 —— #spanHas 区域里还挂着
          //     「共 X 题，已答对 Y 题」的进度计数，不能只看它可见就当答对了）
          //
          // ⚠️ 选择器要同时容忍 id 与 class 两种写法。
          // 源码模板（videojs-ext.min.js）实证：
          //   答错 → <span class="spanNotBack fr" id="spanNotBackPoint">
          //   答对 → Ext.get('spanHas').setHTML('<span class="spanHas fr" ...><span id="InteractiveQuizTip">…')
          // 后者是「把 #spanHas 的 innerHTML 整个换掉」，所以 #spanHas 元素还在，
          // 但真正显示文字的可能是它的子节点。只认一个 id/class 都会漏判。
          let feedback = 'open';
          {
            // ⚠️ 这里刻意**不写** `const hit = (sels) => ...` 这样的函数变量：
            // 打包器会给具名函数注入 __name(...) 包装，浏览器侧没有这个符号，
            // 整个 evaluate 会抛 ReferenceError 并被外层 catch 吞掉。
            // 所以一律用内联循环。
            const NOT_SELS = ['#spanNot', '#spanNotBack', '#spanNotBackPoint', '.spanNot', '.spanNotBack'];
            const CONT_SELS = ['#videoquiz-continue', '.ans-videoquiz-continue'];
            const SUBMITTING_SELS = ['#videoquiz-submitting', '.ans-videoquiz-submitting'];
            const HAS_SELS = ['#spanHas', '.spanHas', '#InteractiveQuizTip', '.ans-videoquiz-tip'];
            const HAS_TEXT_SELS = ['#spanHas', '.spanHas', '#InteractiveQuizTip'];

            let hit = false;
            for (const s of NOT_SELS) {
              const el = document.querySelector(s);
              if (el && visible(el)) { hit = true; break; }
            }
            if (hit) {
              feedback = 'incorrect';
            } else {
              hit = false;
              for (const s of CONT_SELS) {
                const el = document.querySelector(s);
                if (el && visible(el)) { hit = true; break; }
              }
              if (hit) {
                feedback = 'continue';
              } else {
                hit = false;
                for (const s of SUBMITTING_SELS) {
                  const el = document.querySelector(s);
                  if (el && visible(el)) { hit = true; break; }
                }
                if (hit) {
                  feedback = 'submitting';
                } else {
                  let tipText = '';
                  for (const s of HAS_TEXT_SELS) {
                    const el = document.querySelector(s);
                    if (el) tipText += ' ' + q(el);
                  }
                  // 「共 X 题，已答对 Y 题」这个进度计数里也含「答对」二字，
                  // 剔掉它，否则未作答时也会被误判成「已答对」
                  tipText = tipText.replace(/共\s*\d+\s*题[，,]?\s*已答对\s*\d+\s*题/g, ' ');
                  let hasVisible = false;
                  for (const s of HAS_SELS) {
                    const el = document.querySelector(s);
                    if (el && visible(el)) { hasVisible = true; break; }
                  }
                  if (hasVisible && /答对|恭喜|回答正确/.test(tipText)) {
                    feedback = 'correct';
                  } else if (!submitVisible) {
                    // 提交按钮已经不见了、又没有任何反馈元素 → 多半是答完正在自动收起
                    feedback = 'correct';
                  }
                }
              }
            }
          }

          // 题干：排除选项行之后剩下的文字
          const optTexts = opts.map(o => q(o));
          let stem = q(root);
          for (const t of optTexts) if (t) stem = stem.replace(t, ' ');
          // 隐藏的反馈元素也在 root 里，不剔就会混进题干。真机实测（基础英语读写 3.2）
          // 抽出来原本是：「……will be great. 提交提交中继续回答正确回答错误回答错误，回看  分钟」
          // InteractiveQuiz 还要额外剔掉两处（文案表 VideoExtLang 实证）：
          //   「共 X 题，已答对 Y 题」→ qTotal+qs / qAnsweR+qs
          //   「恭喜你，答对了！」   → corretTip1
          stem = stem
            .replace(/共\s*\d+\s*题[，,]?\s*已答对\s*\d+\s*题/g, ' ')
            .replace(/恭喜你[，,]?\s*答对了[！!]?/g, ' ')
            .replace(/(提交中|回答正确|回答错误|继续学习|继续下一节|继续|回看|提交)+/g, ' ')
            .replace(/\s*\d+(\.\d+)?\s*分\s*钟?/g, ' ')
            .replace(/\s*\d+(\.\d+)?\s*分(?!钟)/g, ' ')
            // 倒计时秒数为 0 时只剩一个「， 分钟」，正则带不上数字，单独清
            .replace(/[，,、;；]?\s*分钟?/g, ' ')
            .replace(/[\[\]【】（）()]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 300);

          // 题型靠 input 的 type 判定，不信可能被字体加密的文字
          const firstInput = opts[0].querySelector('input') as HTMLInputElement | null;
          const anyChecked = opts.some(o => {
            const i = o.querySelector('input') as HTMLInputElement | null;
            return i ? i.checked : false;
          });
          const boxCount = opts.filter(o => {
            const i = o.querySelector('input') as HTMLInputElement | null;
            return i && (i.type === 'checkbox' || i.getAttribute('type') === 'checkbox');
          }).length;
          let type: 'single' | 'multi' | 'judge' | 'unknown' = 'unknown';
          if (anyChecked) type = firstInput?.type === 'checkbox' ? 'multi' : 'single';
          else if (boxCount >= 2) type = 'multi';
          else if (opts.length === 2 && /对|错|\\u6b63\\u786e|\\u9519\\u8bef|\\u662f\\u5426/.test(stem + optTexts.join(''))) type = 'judge';
          else if (firstInput?.type === 'radio') type = 'single';

          const options: Array<{ label: string; text: string }> = opts.map((o, i) => {
            const raw = q(o);
            return {
              label: String.fromCharCode(65 + i),
              text: raw.replace(new RegExp('^\\s*' + String.fromCharCode(65 + i) + '\\s*[.、．)]?\\s*'), '').slice(0, 120),
            };
          });

          return {
            stem: stem || root.getAttribute('data-question') || '\\u968f\\u5802\\u9898',
            type,
            options,
            feedback,
            submitVisible,
          };
        },
        { visibleSrc: VISIBLE_FN, qSrc: Q_FN, optSel: OPT_SEL, submitSel: SUBMIT_SEL }
      );
    } catch {
      continue;
    }
    if (!st) continue;
    return {
      present: true,
      frame,
      feedback: st.feedback as VideoPopupFeedback,
      submitVisible: !!st.submitVisible,
      optionCount: st.options.length,
      question: {
        index: 1,
        stem: st.stem,
        type: st.type,
        options: st.options as QuizOption[],
        hasInput: false,
      },
    };
  }
  return {
    present: false,
    frame: null,
    question: null,
    feedback: 'open',
    submitVisible: false,
    optionCount: 0,
  };
}

/**
 * 「答完之后那个按钮」的文案。
 *
 * ⚠️ 为什么按文案而不是按 id：超星的弹窗有好几套皮肤，id 互不相同
 * （本项目原先只认随堂弹题的 `#videoquiz-continue`）。用户实测（2026-10-20，
 * 人工智能基础 2.2 章节测验）遇到的是另一套：答对后底部出现绿色
 * 「恭喜你，答对了！」，右边一枚蓝色 **「继续学习」** 按钮，点了才收尾。
 * 而同门课另一些弹窗答完是**自动收尾**的，不需要点。
 *
 * 所以这里不能认死 id，也不能「一律点一下」——自动收尾的那套点了也没这个元素，
 * 自然落空；而有按钮的那套不点，弹窗就一直盖在页面上，
 * 引擎后续的点击全部被它挡住（用户看到的现象就是「卡住不动」）。
 *
 * 匹配策略：先按 id 精确命中（老的那套，行为不变），再退到「可见浮层里
 * 文本为继续/继续学习 的可点元素」。限定在**浮层内**且**文本短**，
 * 避免误点课程正文里的「继续」字样。
 */
const CONTINUE_TEXTS = ['继续学习', '继续下一节', '继续'];
const CONTINUE_IDS = [
  '#videoquiz-continue',
  '#continueLearn',
  '#btnContinue',
  '#nextLearn',
];

/** 可点元素（覆盖超星各种按钮写法） */
const CLICKABLE_SEL =
  'a,button,input[type=submit],input[type=button],[onclick],[role=button],[class*=btn],[class*=Btn],[id*=btn],[id*=Btn]';

/** 浮层容器：脱离文档流且面积够大，才可能在里面找「继续」 */
const OVERLAY_SEL = [
  '.tkTopic',
  '.ans-videoquiz',
  '.layui-layer',
  '.layui-dialog',
  '#workpop',
  '#divVideoQuestion',
  '#divExamWork',
  '[role="dialog"]',
  '.modal',
  '.popup',
  '.dialog',
  '.popDiv',
  '.maskDiv',
].join(',');

/**
 * 在页面上找到并点掉「继续 / 继续学习」按钮。
 *
 * 返回点到了什么，没找到返回 null。
 *
 * ⚠️ 只在**可见浮层内**找。超星正文里出现「继续」二字的概率不低
 * （章节标题、题目解析都可能带），放开限定就会点飞。
 */
export async function clickContinueIfPresent(
  page: Page,
  timeoutMs = 2500
): Promise<{ by: string; text: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      // 1) 精确 id（老的那套随堂弹题）
      for (const id of CONTINUE_IDS) {
        const el = frame.locator(id).first();
        if (!(await el.count().catch(() => 0))) continue;
        if (!(await el.isVisible().catch(() => false))) continue;
        await el.click({ force: true, timeout: 2000 }).catch(() => {});
        return { by: id, text: '继续' };
      }

      // 2) 可见浮层内按文案找
      let hit: { text: string; idx: number } | null = null;
      try {
        hit = await frame.evaluate(
          ({ overlaySel, clickSel, texts, visibleSrc }: { overlaySel: string; clickSel: string; texts: string[]; visibleSrc: string }) => {
            // ⚠️ visible 必须从字符串 eval 进来：写成 `const visible = (el) => ...`
            // 会被打包器注入 __name(...) → 浏览器侧 ReferenceError → 整段 evaluate 报废。
            const visible = eval(visibleSrc) as (el: Element | null) => boolean;
            const overlays: Element[] = [];
            for (const sel of overlaySel.split(',')) {
              let els: Element[] = [];
              try {
                els = Array.from(document.querySelectorAll(sel));
              } catch {
                continue;
              }
              for (const el of els) if (visible(el)) overlays.push(el);
            }
            // 浮层不在预设容器里也不漏判：任何脱离文档流、面积够大的可见块都算
            if (!overlays.length) {
              for (const el of Array.from(document.querySelectorAll('div,section,dialog'))) {
                if (!visible(el)) continue;
                const cs = getComputedStyle(el);
                if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
                const r = el.getBoundingClientRect();
                if (r.width * r.height < 8000) continue;
                overlays.push(el);
              }
            }
            for (const ov of overlays) {
              let cands: Element[] = [];
              try {
                cands = Array.from(ov.querySelectorAll(clickSel));
              } catch {
                continue;
              }
              for (const c of cands) {
                if (!visible(c)) continue;
                const t = (c.textContent || (c as HTMLInputElement).value || '').replace(/\s+/g, ' ').trim();
                // 文本必须**恰好**是「继续」这类短文案；长句是正文/标题，不是按钮
                if (!t || t.length > 8) continue;
                if (!texts.some(x => t === x || t.replace(/^[>＞\s]+|[<＜\s]+$/g, '') === x)) continue;
                return { text: t, idx: overlays.indexOf(ov) };
              }
            }
            return null;
          },
          { overlaySel: OVERLAY_SEL, clickSel: CLICKABLE_SEL, texts: CONTINUE_TEXTS, visibleSrc: VISIBLE_LOOSE_FN }
        );
      } catch {
        hit = null;
      }
      if (hit) {
        // 按文本再定位一次并点：evaluate 只回报了文案，不回报句柄
        const locator = frame.getByText(new RegExp(`^\\s*${hit!.text}\\s*$`)).last();
        await locator.click({ force: true, timeout: 2000 }).catch(() => {});
        return { by: '文案匹配', text: hit!.text };
      }
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return null;
}

async function waitFeedback(
  page: Page,
  h: EngineHooks,
  opts: { submitTimeout: number }
): Promise<{ fb: VideoPopupFeedback; gone: boolean }> {
  const deadline = Date.now() + opts.submitTimeout;
  let last: VideoPopupFeedback = 'open';
  while (Date.now() < deadline) {
    h.ctl.throwIfStopped();
    const s = await readVideoPopup(page);
    last = s.feedback;
    if (s.feedback !== 'open' && s.feedback !== 'submitting') return { fb: s.feedback, gone: false };
    // 弹题整个消失了：答对时超星直接收起弹题继续播放，不给任何反馈。
    // 这也是成功，不能当成「无反馈」——真机实测基础英语读写 3.2 就是这样。
    if (!s.present) return { fb: 'correct', gone: true };
    await h.ctl.sleep(600);
  }
  return { fb: last, gone: false };
}

const FB_TEXT: Record<VideoPopupFeedback, string> = {
  open: '无反馈',
  submitting: '提交中',
  correct: '答对',
  incorrect: '答错',
  continue: '出现继续',
};

/**
 * 处理当前弹题。返回 null 表示页面上没有弹题。
 *
 * 只对**双选项**弹题做一次自动改选：多选题和三个以上选项的题一旦答错就停，
 * 因为没有可靠依据判断哪个才是对的，乱猜比留空更糟。
 */
export async function answerVideoPopup(
  page: Page,
  h: EngineHooks,
  channel: AnswerChannel | null,
  opts: { tiku?: TikuStore | null; submitCoverRate?: number; submitTimeout?: number }
): Promise<{ answered: number; submitted: number; retried: number; closed: 'auto' | 'clicked' | 'none' } | null> {
  const first = await readVideoPopup(page);
  if (!first.present || !first.question || !first.frame) return null;

  const submitTimeout = opts.submitTimeout ?? 20000;
  const q = first.question;
  h.log('info', `    → 随堂弹题（${q.options.length} 个选项，${q.type}）: ${q.stem.slice(0, 40)}`);

  if (q.options.length < 2) return { answered: 0, submitted: 0, retried: 0, closed: 'none' };

  // ⚠️ 弹题还在、但提交按钮已经不可见 → 这一题**已经答过了**（超星提交后把
  // #videoquiz-submit 置为 display:none）。这时再点选项+提交是无效操作，
  // 只会把已答对的题重新搅乱。直接走收尾。
  if (!first.submitVisible) {
    h.log('info', `    → 弹题已提交过（提交按钮不可见），跳过作答，直接收尾`);
    const closed = await settlePopup(page, h, { reason: '随堂弹题', autoWaitMs: 600 });
    h.log('info', `    → 弹题收尾方式: ${closed}`);
    return null;
  }

  // 答
  const chain: Searcher[] = [];
  if (opts.tiku) chain.push(new CacheSearcher(opts.tiku));
  if (channel?.apiKey) chain.push(new LlmSearcher(channel));
  let answer = '';
  if (chain.length) {
    const got = await resolveAnswers([q], chain);
    answer = got.get(1) || '';
  }
  if (!answer) {
    h.log('warn', '    ⚠ 弹题没有答案，放弃（不乱点）');
    return { answered: 0, submitted: 0, retried: 0, closed: 'none' };
  }
  h.log('info', `    → 弹题答案: ${answer}`);

  const pickLetters = (a: string) => {
    const ls = (a.match(/[A-Ha-h]/g) || []).map(c => c.toUpperCase());
    return ls.length ? ls : ['A'];
  };

  // 点选项：点 label，超星真正的勾选载体是 input[name=ans-videoquiz-opt]
  let clicked = 0;
  for (const L of pickLetters(answer)) {
    const loc = first.frame!.locator(`${OPT_SEL}:has(input[name="ans-videoquiz-opt"])`).nth(L.charCodeAt(0) - 65);
    try {
      await loc.locator('label').first().click({ force: true, timeout: 2500 });
      clicked++;
    } catch {}
  }
  if (!clicked) {
    h.log('warn', '    ⚠ 弹题选项没点上');
    return { answered: 0, submitted: 0, retried: 0, closed: 'none' };
  }

  // 提交
  try {
    await first.frame!.locator('#videoquiz-submit').first().click({ force: true, timeout: 3000 });
  } catch (e: any) {
    h.log('warn', `    ⚠ 弹题提交失败: ${String(e.message).slice(0, 60)}`);
    return { answered: clicked, submitted: 0, retried: 0, closed: 'none' };
  }

  let w = await waitFeedback(page, h, { submitTimeout });
  let fb = w.fb;
  h.log('info', `    → 弹题反馈: ${FB_TEXT[fb]}${w.gone ? '（弹题已收起，平台未显示反馈）' : ''}`);
  let submitted = 1;
  let retried = 0;

  // 答错：仅双选项时改选一次
  if (fb === 'incorrect' && q.options.length === 2) {
    // 提交按钮已经不可见 = 这题已经交上去了，再改选也提交不了，直接收尾。
    // ⚠️ 必须**重新读一次**状态：first.submitVisible 是提交**之前**的快照，
    // 提交后超星才把按钮置为 display:none。
    const cur = await readVideoPopup(page);
    if (!cur.submitVisible) {
      h.log('warn', '    ⚠ 弹题答错，但提交按钮已隐藏（已提交过），不再改选');
      const closed = await settlePopup(page, h, { reason: '随堂弹题' });
      return { answered: clicked, submitted: 1, retried: 0, closed };
    }
    h.log('warn', '    ⚠ 弹题答错，双选项题改选一次');
    retried++;
    try {
      const rows = first.frame!.locator(OPT_SEL);
      for (let i = 0; i < 2; i++) {
        const row = rows.nth(i);
        const input = row.locator('input[name="ans-videoquiz-opt"]');
        if ((await input.count()) && (await input.isChecked())) continue;
        await row.locator('label').first().click({ force: true, timeout: 2500 });
        break;
      }
      // 回读确认真的换过来了，否则不要盲目再提交
      const alt = await rows.nth(0).locator('input[name="ans-videoquiz-opt"]').isChecked().catch(() => false);
      const alt2 = await rows.nth(1).locator('input[name="ans-videoquiz-opt"]').isChecked().catch(() => false);
      const switched = alt !== alt2;
      if (!switched) {
        h.log('warn', '    ⚠ 改选未生效，停止（不再提交）');
        return { answered: clicked, submitted: 0, retried, closed: 'none' };
      }
      await first.frame!.locator('#videoquiz-submit').first().click({ force: true, timeout: 3000 }).catch(() => {});
      w = await waitFeedback(page, h, { submitTimeout });
      fb = w.fb;
      h.log(fb === 'correct' ? 'ok' : 'warn', `    → 改选后: ${FB_TEXT[fb]}${w.gone ? '（弹题已收起）' : ''}`);
      submitted = fb === 'correct' ? 2 : 1;
    } catch (e: any) {
      h.log('warn', `    ⚠ 改选异常: ${String(e.message).slice(0, 60)}`);
    }
  }

  // ── 收尾：弹窗有两种走向，都要能退场 ──────────────────────────────
  //
  // 用户实测（2026-10-20，人工智能基础 2.2）：这类弹窗答对后**不会自动收起**，
  // 底部留下一枚「继续学习」按钮，必须点掉弹窗才退场。
  // 而同门课另一些弹窗答完直接自动收起（基础英语读写 3.2 实测）。
  //
  // 所以不能只认 #videoquiz-continue（旧实现就栽在这）：
  //   自动收尾的那套 → 等一小会儿弹窗自己没了 → 什么都不用点
  //   有按钮的那套   → 点「继续学习」
  // 两条路都要走，先等自动、再找按钮。
  const closed = await settlePopup(page, h, { reason: '随堂弹题' });
  return { answered: clicked, submitted, retried, closed };
}

/**
 * 弹窗收尾：先给平台自动收起的机会，再找「继续」按钮点掉。
 *
 * 返回 'auto'（弹窗自己退了）/ 'clicked'（点掉了）/ 'none'（本来就没弹窗）。
 *
 * 抽成独立函数是因为「章节测验提交后」也要走同一套逻辑 —— 实测 2.3 提交成功后
 * 页面停在「查看已批阅作业」不退，引擎没有任何收尾动作，只能干等。
 */
export async function settlePopup(
  page: Page,
  h: EngineHooks | null,
  opts: { reason: string; autoWaitMs?: number; probe?: () => Promise<boolean> }
): Promise<'auto' | 'clicked' | 'none'> {
  const autoWaitMs = opts.autoWaitMs ?? 2500;
  const probe = opts.probe ?? (async () => (await readVideoPopup(page)).present);
  const log = (lv: 'ok' | 'info' | 'warn', msg: string) => h?.log(lv, msg);

  // 第1 步：等平台自动收起
  const deadline = Date.now() + autoWaitMs;
  let present = true;
  while (Date.now() < deadline) {
    present = await probe().catch(() => false);
    if (!present) {
      log('ok', `✓ ${opts.reason}已自动收起`);
      return 'auto';
    }
    await new Promise(r => setTimeout(r, 400));
  }

  // 第 2 步：还在 → 找「继续 / 继续学习」点掉
  const hit = await clickContinueIfPresent(page);
  if (hit) {
    log('ok', `✓ 已点击「${hit.text}」，${opts.reason}收尾（方式：${hit.by}）`);
    // 点完再确认一次：点到了不一定真收尾了
    for (let i = 0; i < 8; i++) {
      if (!(await probe().catch(() => false))) return 'clicked';
      await new Promise(r => setTimeout(r, 400));
    }
    log('warn', `⚠ 已点「${hit.text}」但${opts.reason}仍在，可能需要人工确认`);
    return 'clicked';
  }

  log('info', `· ${opts.reason}没有出现「继续」按钮，按自动收起处理`);
  return 'none';
}