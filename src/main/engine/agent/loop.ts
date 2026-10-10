import type { Page, Locator } from 'playwright';
import type { QuizShot, Rect } from './shot';
import { captureQuizShot, toElementPoint } from './shot';
import { askQuizByVision, type QuizAnswer, type VisionConfig } from './llm';

/** Agent 可用的工具（注册表=数据，以后加工具不改循环） */
export interface AgentTool {
  name: 'click' | 'type' | 'done' | 'abort';
  run(args: any, ctx: AgentCtx): Promise<any>;
}

/** Agent 作用域目标 */
export interface AgentGoal {
  name: string;
  /** 给日志看的说明 */
  describe: string;
  /** 完成判定用的容器（通常为弹窗容器）；题目容器另行自动探测 */
  doneSelector?: string;
  /** 显式指定题目容器；不填则自动探测 .TiMu 等 */
  questionSelector?: string;
  /** 最多处理多少题 */
  maxQuestions?: number;
  /** 完成判定 */
  done(ctx: AgentCtx): Promise<boolean>;
  budget: { maxSteps: number; maxMs: number };
}

/** 执行上下文 */
export interface AgentCtx {
  page: Page;
  box: Rect | null;
  shot: QuizShot | null;
  log(level: 'info' | 'warn' | 'error' | 'ok', msg: string): void;
  /** 中断检查：抛异常终止 Agent */
  checkpoint(): void;
  sleep(ms: number): Promise<void>;
}

export interface AgentResult {
  ok: boolean;
  answered: number;
  clicked: number;
  steps: number;
  ms: number;
  reason: string;
}

/** 判断题答案归一化 */
function judgeAnswer(a: string): 'right' | 'wrong' | null {
  const s = a.trim();
  if (/^(对|正确|是|T|true|right|correct)$/i.test(s)) return 'right';
  if (/^(错|错误|否|F|false|wrong|incorrect)$/i.test(s)) return 'wrong';
  return null;
}

/** 坐标吸附容差：模型坐标与选项元素的允许距离（像素） */
const SNAP_TOLERANCE = 80;

/**
 * 超星测验的可点击选择项选择器。
 *
 * 实测真实作业 DOM（1.3 Assignment）：
 *   <input type="radio"> 数量为 0，选项是自定义组件：
 *   <li class="... before-after" onclick="addChoice(this);" qid="..." qtype="0"
 *       role="radio" aria-label="A attainable选择" aria-checked="true">
 *     <label class="fl before"><span class="num_option choice404763407" data="A">A</span></label>
 *     <a class="fl after"><p>attainable</p></a>
 *   </li>
 * 因此必须覆盖 li[role=radio] / [aria-label^=X] / .num_option / .before-after。
 */
const OPTION_SELECTORS = [
  'li[role="radio"]',
  'li[role="checkbox"]',
  '[role="radio"][aria-label]',
  '[role="checkbox"][aria-label]',
  '.num_option',
  '.before-after',
  'input[type="radio"]',
  'input[type="checkbox"]',
];

/**
 * 把模型给出的坐标吸附到最近的选项元素再点击。
 *
 * 直接按坐标点击不可靠：超星选项圆圈仅 32x32px，模型坐标常有 50-200px 偏差。
 * 改为在容器内找到离坐标最近的选项（含自定义 li[role=radio] 与原生 input），
 * 点击其中心。
 */
async function clickOptionNearPoint(
  page: Page,
  box: Rect | null,
  x: number,
  y: number,
  scope?: Locator | null
): Promise<{ ok: boolean; snapped: boolean; dist: number }> {
  // 优先用题目容器 locator 实时限定范围；
  // 缓存的 box 会在填空等操作引起布局位移后失效，导致候选被误排除
  const useScope = scope ?? null;
  const originX = box ? box.x : 0;
  const originY = box ? box.y : 0;
  const targetX = originX + x;
  const targetY = originY + y;

  let best: { x: number; y: number; dist: number } | null = null;

  for (const sel of OPTION_SELECTORS) {
    const root = useScope ?? page;
    const handles = await root.locator(sel).all().catch(() => []);
    for (const h of handles) {
      if (!(await h.isVisible().catch(() => false))) continue;
      const b = await h.boundingBox().catch(() => null);
      if (!b || b.width <= 0 || b.height <= 0) continue;
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      // 无 scope 时用矩形限定，避免吸附到相邻题目的选项
      if (
        !useScope &&
        box &&
        (cx < box.x - 4 || cx > box.x + box.width + 4 || cy < box.y - 4 || cy > box.y + box.height + 4)
      ) {
        continue;
      }
      const d = Math.hypot(cx - targetX, cy - targetY);
      if (!best || d < best.dist) best = { x: cx, y: cy, dist: d };
    }
    if (best && best.dist <= SNAP_TOLERANCE) break;
  }

  if (best && best.dist <= SNAP_TOLERANCE) {
    try {
      await page.mouse.click(best.x, best.y);
      return { ok: true, snapped: true, dist: best.dist };
    } catch {
      /* 落到坐标点击兜底 */
    }
  }

  try {
    await page.mouse.click(targetX, targetY);
    return { ok: true, snapped: false, dist: best?.dist ?? Infinity };
  } catch {
    return { ok: false, snapped: false, dist: best?.dist ?? Infinity };
  }
}

/** 判断题：坐标不可靠时改按选项文本点击 */
async function clickJudgeByText(page: Page, answer: string): Promise<boolean> {
  const want = judgeAnswer(answer);
  if (!want) return false;
  const re = want === 'right' ? /正确|^对$|√/ : /错误|^错$|×/;
  try {
    const loc = page.getByText(re).first();
    if (await loc.count()) {
      await loc.click({ force: true, timeout: 2000 });
      return true;
    }
  } catch {}
  return false;
}

/**
 * 填空题：把答案填进该题的输入框。
 *
 * 限定在该题容器内查找输入框，避免跨题串位。
 * 超星填空框有 <input> 和 <span contenteditable> 两类，且部分组件监听
 * input/change 事件，单纯 fill() 可能不被记录，因此填完补派发事件。
 */
async function fillBlanks(
  page: Page,
  qScope: Locator,
  fills: string[]
): Promise<{ found: number; typed: number }> {
  const inputs = qScope.locator(
    'input[type="text"], input:not([type]), textarea, [contenteditable="true"], [contenteditable=""]'
  );
  const total = await inputs.count().catch(() => 0);

  let typed = 0;
  const limit = Math.min(fills.length, total);
  for (let i = 0; i < limit; i++) {
    const value = String(fills[i] || '').trim();
    if (!value) continue;
    const loc = inputs.nth(i);
    try {
      const tag = await loc.evaluate((el: Element) => el.tagName.toLowerCase());
      if (tag === 'input' || tag === 'textarea') {
        await loc.fill(value, { timeout: 3000 });
      } else {
        // contenteditable：pressSequentially 会自动聚焦，
        // 直接用 click + keyboard.type 在空 span 上常因无文本节点而失败
        let ok = false;
        try {
          await loc.pressSequentially(value, { delay: 12, timeout: 3000 });
          ok = true;
        } catch {
          try {
            await loc.click({ timeout: 2000 });
            await page.keyboard.type(value, { delay: 12 });
            ok = true;
          } catch {}
        }
        if (!ok) continue;
      }
      await loc
        .evaluate((el: any) => {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        })
        .catch(() => {});
      typed++;
    } catch {}
  }
  return { found: total, typed };
}

/** 点击提交/确定 */
const SUBMIT_SELECTORS = [
  'button:has-text("提交")',
  'a:has-text("提交")',
  'button:has-text("确定")',
  'button:has-text("交卷")',
  'button:has-text("确认")',
  'button:has-text("完成")',
  'input[type="submit"]',
];

async function clickSubmit(page: Page): Promise<boolean> {
  for (const sel of SUBMIT_SELECTORS) {
    try {
      const loc = page.locator(sel);
      const n = await loc.count();
      for (let i = n - 1; i >= 0; i--) {
        try {
          await loc.nth(i).click({ force: true, timeout: 2000 });
          return true;
        } catch {}
      }
    } catch {}
  }
  return false;
}

/** 每批送模型的题数（实测 4 题稳定，再多易输出截断） */
const BATCH_SIZE = 4;

/**
 * 逐题截图。
 * 超星每道题是独立的 .TiMu 容器；把整份作业拼成一张长图会因为长宽比过大
 * （实测 1:10，缩到 240px 宽仍 0 题）而完全读不出来，所以必须每题一图。
 */
async function shootEachQuestion(
  page: Page,
  container: string,
  maxQ: number
): Promise<Array<{ shot: QuizShot; q: number }>> {
  const total = await page.locator(container).count().catch(() => 0);
  const out: Array<{ shot: QuizShot; q: number }> = [];
  const limit = Math.min(total || 0, maxQ);
  for (let i = 0; i < limit; i++) {
    // strict：定位失败必须返回 null，否则会退化成全屏截图（坐标与题目对不上）
    const shot = await captureQuizShot(page, { selector: `${container} >> nth=${i}`, strict: true });
    if (!shot) continue;
    // 末节点常是提交区而非题目（异常高），跳过
    if (shot.h > 1200) continue;
    out.push({ shot, q: i + 1 });
  }
  return out;
}

/** 找题目容器选择器 */
async function findQuizContainer(page: Page): Promise<string | null> {
  for (const sel of ['.TiMu', '.TiDu', '[class*="TiMu"]', '[class*="TiDu"]', '[class*="question"]', '[class*="TiMu_"]']) {
    const n = await page.locator(sel).count().catch(() => 0);
    if (n > 0) return sel;
  }
  return null;
}

/** 逐题取容器矩形（把题内坐标换算到页面坐标） */
async function captureQuestionBoxes(
  page: Page,
  container: string,
  maxQ: number
): Promise<Map<number, Rect>> {
  const map = new Map<number, Rect>();
  for (let i = 0; i < maxQ; i++) {
    try {
      const b = await page.locator(`${container} >> nth=${i}`).boundingBox();
      if (b) map.set(i + 1, b);
    } catch {}
  }
  return map;
}

/**
 * 运行一个 Agent 目标。
 *
 * 策略：逐题截图 → 分批送模型 → 坐标吸附点击 → 提交。
 * 不做逐步交互：实测单次视觉调用 14-38s，逐步交互必然压垮限时测验。
 */
export async function runAgent(
  cfg: VisionConfig,
  page: Page,
  goal: AgentGoal,
  deps: {
    log(level: 'info' | 'warn' | 'error' | 'ok', msg: string): void;
    checkpoint(): void;
    sleep(ms: number): Promise<void>;
  }
): Promise<AgentResult> {
  const t0 = Date.now();
  let steps = 0;
  let answered = 0;
  let clicked = 0;
  let reason = '';

  // 真实生效的总时限：超时就地收手，把已拿到的答案用掉，
  // 让视频流程能继续，而不是无限期停在答题阶段。
  const budgetMs = goal.budget?.maxMs ?? 300000;
  const overBudget = () => Date.now() - t0 > budgetMs;
  const leftMs = () => Math.max(0, budgetMs - (Date.now() - t0));

  const ctx: AgentCtx = {
    page,
    box: null,
    shot: null,
    log: deps.log,
    checkpoint: deps.checkpoint,
    sleep: deps.sleep,
  };

  try {
    // 1) 找题目容器（超星为 .TiMu，每题独立容器）
    const container = goal.questionSelector || (await findQuizContainer(page));
    if (!container) {
      return { ok: false, answered: 0, clicked: 0, steps, ms: Date.now() - t0, reason: '未找到题目容器' };
    }

    // 2) 逐题截图
    const perQ = await shootEachQuestion(page, container, goal.maxQuestions ?? 20);
    steps++;
    deps.checkpoint();
    if (!perQ.length) {
      return { ok: false, answered: 0, clicked: 0, steps, ms: Date.now() - t0, reason: '题目截图失败' };
    }
    deps.log('info', `  识别到 ${perQ.length} 题（${container}）`);

    // 3) 分批送模型（每批一次请求携带多张题图）
    const answers: QuizAnswer[] = [];
    for (let i = 0; i < perQ.length; i += BATCH_SIZE) {
      deps.checkpoint();
      // 总时限已到就不再发新请求：用手上已有的答案，剩下的题保持未作答
      if (overBudget()) {
        deps.log(
          'warn',
          `  已用时 ${Math.round((Date.now() - t0) / 1000)}s，超出 ${Math.round(budgetMs / 1000)}s 预算，剩余题目跳过`
        );
        break;
      }
      const batch = perQ.slice(i, i + BATCH_SIZE).map(p => ({ ...p.shot, q: p.q }));
      const bt = Date.now();
      try {
        // 单请求上限不得超过剩余预算，否则最后一批仍可能超支
        const got = await askQuizByVision(cfg, batch, {
          maxMs: Math.min(budgetMs, leftMs()),
        });
        answers.push(...got);
        steps++;
        deps.log(
          'info',
          `  AI 批次 Q${batch[0].q}-${batch[batch.length - 1].q} → ${got.length} 题（${((Date.now() - bt) / 1000).toFixed(1)}s）`
        );
      } catch (e: any) {
        steps++;
        deps.log(
          'warn',
          `  批次 Q${batch[0].q}-${batch[batch.length - 1].q} 失败：${String(e?.message || e).slice(0, 50)}`
        );
      }
    }
    answered = answers.length;
    if (!answers.length) {
      return { ok: false, answered, clicked, steps, ms: Date.now() - t0, reason: '模型未给出任何答案' };
    }

    // 4) 批量点击（多选题要点多个位置）
    const boxes = await captureQuestionBoxes(page, container, perQ.length);
    for (const a of answers) {
      deps.checkpoint();
      if (a.answer === '?') {
        deps.log('info', `    Q${a.q} 跳过（模型不确定）`);
        continue;
      }
      const box = boxes.get(a.q) || null;
      const isJudge = /^(对|错|正确|错误)$/.test(a.answer.trim());
      // 填空题：模型给了 fills，或该题内根本没有选择控件
      const isFill = !!a.fills?.length;
      let hits = 0;
      let lastDist = 0;

      if (isFill) {
        const qScope = page.locator(`${container} >> nth=${(a.q || 1) - 1}`);
        const res = await fillBlanks(page, qScope, a.fills!);
        hits = res.typed;
        if (res.typed > 0) {
          deps.log('info', `    Q${a.q} 填空 ${a.fills!.slice(0, res.typed).join(' / ')} ✓ ×${res.typed}`);
        } else if (res.found === 0) {
          deps.log('warn', `    Q${a.q} 填空题但未找到输入框`);
        } else {
          deps.log('warn', `    Q${a.q} 找到 ${res.found} 个输入框但未能写入`);
        }
        // 填空题不再走点击分支，避免重复操作与误导性日志
        await deps.sleep(200);
        continue;
      }
      if (isJudge) {
        if (await clickJudgeByText(page, a.answer)) hits = 1;
        else if (a.points.length) {
          const r = await clickOptionNearPoint(
            page, box, a.points[0].x, a.points[0].y,
            page.locator(`${container} >> nth=${(a.q || 1) - 1}`)
          );
          if (r.ok) { hits = 1; lastDist = r.dist; }
        }
      } else {
        for (const pt of a.points) {
          const r = await clickOptionNearPoint(
            page, box, pt.x, pt.y,
            page.locator(`${container} >> nth=${(a.q || 1) - 1}`)
          );
          if (r.ok) { hits++; lastDist = r.dist; }
          await deps.sleep(200);
        }
      }

      if (hits > 0) {
        clicked += hits;
        const snap = lastDist > 25 && lastDist !== Infinity ? `（吸附 ${Math.round(lastDist)}px）` : '';
        deps.log('info', `    Q${a.q} ${a.answer} ✓${hits > 1 ? ` ×${hits}` : ''}${snap}`);
      } else {
        deps.log('warn', `    Q${a.q} ${a.answer} 点击失败`);
      }
      await deps.sleep(250);
    }

    // 4) 提交
    deps.checkpoint();
    if (await clickSubmit(page)) {
      steps++;
      deps.log('ok', `  已提交`);
      await deps.sleep(1500);
    } else {
      deps.log('warn', '  未找到提交按钮');
    }

    // 5) 完成判定
    const done = await goal.done(ctx);
    reason = done ? '目标完成' : clicked === 0 ? '一题未点中' : '已点选但未确认完成';
    return { ok: done, answered, clicked, steps, ms: Date.now() - t0, reason };
  } catch (e: any) {
    const msg = String(e?.message || e);
    deps.log('error', `  Agent 异常：${msg}`);
    return { ok: false, answered, clicked, steps, ms: Date.now() - t0, reason: msg };
  }
}

/**
 * 测验目标：提交后弹窗消失即视为完成。
 * doneSelector 只用于完成判定，题目容器由 findQuizContainer 自动探测
 * （超星每道题是独立的 .TiMu，二者不能混用）。
 */
export function quizGoal(doneSelector?: string): AgentGoal {
  return {
    name: 'quiz',
    describe: '回答测验并提交',
    doneSelector,
    maxQuestions: 20,
    budget: { maxSteps: 40, maxMs: 240000 },
    done: async ctx => {
      if (!doneSelector) return true;
      try {
        const loc = ctx.page.locator(doneSelector).first();
        // 注意：display:none 的元素 count() 仍为 1，必须判断可见性
        return !(await loc.isVisible().catch(() => false));
      } catch {
        return true;
      }
    },
  };
}