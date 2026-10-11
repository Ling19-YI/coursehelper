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

export interface VideoPopupState {
  present: boolean;
  /** 弹题容器所在的 frame（弹题可能出现在播放器 iframe 内） */
  frame: Frame | null;
  question: QuizQuestion | null;
  feedback: VideoPopupFeedback;
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

/** 读当前弹题状态。不存在弹题时 present=false。 */
export async function readVideoPopup(page: Page): Promise<VideoPopupState> {
  for (const frame of page.frames()) {
    let st: any;
    try {
      st = await frame.evaluate(
        ({ visibleSrc, optSel }) => {
          const visible = eval(visibleSrc) as (el: Element | null) => boolean;
          const submit = document.querySelector('#videoquiz-submit');
          if (!visible(submit)) return null;
          const root = (submit as Element).closest('.tkTopic');
          if (!root) return null;
          const opts = Array.from(root.querySelectorAll(optSel)).filter(visible);
          if (opts.length < 2) return null;

          const feedback = (): string => {
            if (visible(document.querySelector('#spanNot')) || visible(document.querySelector('#spanNotBack')))
              return 'incorrect';
            if (visible(document.querySelector('#videoquiz-continue'))) return 'continue';
            if (visible(document.querySelector('#spanHas'))) return 'correct';
            if (visible(document.querySelector('#videoquiz-submitting'))) return 'submitting';
            return 'open';
          };

          const q = (e: Element | null) => (e ? (e.textContent || '').replace(/\s+/g, ' ').trim() : '');
          // 题干：排除选项行之后剩下的文字
          const optTexts = opts.map(o => q(o));
          let stem = q(root);
          for (const t of optTexts) if (t) stem = stem.replace(t, ' ');
          // 隐藏的反馈元素也在 root 里，不剔就会混进题干。真机实测（基础英语读写 3.2）
          // 抽出来原本是：「……will be great. 提交提交中继续回答正确回答错误回答错误，回看  分钟」
          stem = stem
            .replace(/(提交中|回答正确|回答错误|继续|回看|提交)+/g, ' ')
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
            feedback: feedback(),
          };
        },
        { visibleSrc: VISIBLE_FN, optSel: OPT_SEL }
      );
    } catch {
      continue;
    }
    if (!st) continue;
    return {
      present: true,
      frame,
      feedback: st.feedback as VideoPopupFeedback,
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
  return { present: false, frame: null, question: null, feedback: 'open', optionCount: 0 };
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
): Promise<{ answered: number; submitted: number; retried: number } | null> {
  const first = await readVideoPopup(page);
  if (!first.present || !first.question || !first.frame) return null;

  const submitTimeout = opts.submitTimeout ?? 20000;
  const q = first.question;
  h.log('info', `    → 随堂弹题（${q.options.length} 个选项，${q.type}）: ${q.stem.slice(0, 40)}`);

  if (q.options.length < 2) return { answered: 0, submitted: 0, retried: 0 };

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
    return { answered: 0, submitted: 0, retried: 0 };
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
    return { answered: 0, submitted: 0, retried: 0 };
  }

  // 提交
  try {
    await first.frame!.locator('#videoquiz-submit').first().click({ force: true, timeout: 3000 });
  } catch (e: any) {
    h.log('warn', `    ⚠ 弹题提交失败: ${String(e.message).slice(0, 60)}`);
    return { answered: clicked, submitted: 0, retried: 0 };
  }

  let w = await waitFeedback(page, h, { submitTimeout });
  let fb = w.fb;
  h.log('info', `    → 弹题反馈: ${FB_TEXT[fb]}${w.gone ? '（弹题已收起，平台未显示反馈）' : ''}`);
  let submitted = 1;
  let retried = 0;

  // 答错：仅双选项时改选一次
  if (fb === 'incorrect' && q.options.length === 2) {
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
        return { answered: clicked, submitted: 0, retried };
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

  // 关弹题：出现「继续」就点一次
  const cur = await readVideoPopup(page);
  if (cur.feedback === 'continue' || cur.present) {
    for (const f of page.frames()) {
      try {
        const btn = f.locator('#videoquiz-continue');
        if (await btn.count()) {
          await btn.first().click({ force: true, timeout: 2500 }).catch(() => {});
          h.log('ok', '    ✓ 已关闭弹题，继续播放');
          break;
        }
      } catch {}
    }
  }
  return { answered: clicked, submitted, retried };
}