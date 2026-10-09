import type { Page } from 'playwright';
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
  /** 弹窗容器选择器（存在则局部截图，坐标相对容器） */
  containerSelector?: string;
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
 * 把模型给出的坐标吸附到最近的选项元素再点击。
 *
 * 直接按坐标点击不可靠：超星 radio 圆圈仅 13x13px，模型坐标常有 50-200px 偏差，
 * 实测会点空。改为在容器内找到离坐标最近的 radio/checkbox（连同其 label），
 * 用元素点击命中率高得多。
 *
 * @returns 点击结果；未找到合适元素返回 false
 */
async function clickOptionNearPoint(
  page: Page,
  box: Rect | null,
  x: number,
  y: number
): Promise<{ ok: boolean; snapped: boolean; dist: number }> {
  // 容器内搜索：局部截图时坐标是容器内坐标，需要平移到页面坐标
  const originX = box ? box.x : 0;
  const originY = box ? box.y : 0;
  const targetX = originX + x;
  const targetY = originY + y;

  let best: { x: number; y: number; dist: number } | null = null;

  // 遍历可见的 radio / checkbox，用 label 或自身作为点击目标
  const handles = await page
    .locator('input[type="radio"], input[type="checkbox"]')
    .all()
    .catch(() => []);
  for (const inp of handles) {
    if (!(await inp.isVisible().catch(() => false))) continue;
    const b = await inp.boundingBox().catch(() => null);
    if (!b || b.width <= 0 || b.height <= 0) continue;
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const d = Math.hypot(cx - targetX, cy - targetY);
    if (!best || d < best.dist) best = { x: cx, y: cy, dist: d };
  }

  // 在容差内命中选项 → 用鼠标点其中心（label 区域也能触发 radio）
  if (best && best.dist <= SNAP_TOLERANCE) {
    try {
      await page.mouse.click(best.x, best.y);
      return { ok: true, snapped: true, dist: best.dist };
    } catch {
      /* 落到坐标点击兜底 */
    }
  }

  // 兜底：直接按坐标点
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

/**
 * 运行一个 Agent 目标。
 *
 * 采用「一次截图 → 一次模型调用 → 批量点击 → 提交」的批处理策略：
 * 视觉调用 12-21s，逐步交互会让限时测验超时。
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

  const ctx: AgentCtx = {
    page,
    box: null,
    shot: null,
    log: deps.log,
    checkpoint: deps.checkpoint,
    sleep: deps.sleep,
  };

  try {
    // 1) 定位容器并截图
    if (goal.containerSelector) {
      const loc = page.locator(goal.containerSelector).first();
      if (await loc.count().catch(() => 0)) {
        ctx.box = await loc.boundingBox();
      }
    }
    ctx.shot = await captureQuizShot(page, {
      selector: ctx.box ? goal.containerSelector : undefined,
      redact: true,
    });
    if (!ctx.shot) {
      return { ok: false, answered: 0, clicked: 0, steps, ms: Date.now() - t0, reason: '截图失败' };
    }
    if (!ctx.box) {
      ctx.shot.cropped = false;
    }
    steps++;
    deps.log(
      'info',
      `  截图 ${ctx.shot.w}x${ctx.shot.h}${ctx.shot.cropped ? '（局部）' : '（全屏）'}` +
        (ctx.shot.redacted.length ? `，已脱敏 ${ctx.shot.redacted.length} 处` : '')
    );

    deps.checkpoint();
    if (Date.now() - t0 > goal.budget.maxMs) {
      return { ok: false, answered, clicked, steps, ms: Date.now() - t0, reason: '截图后已超时' };
    }

    // 2) 一次调用答完所有题
    const answers: QuizAnswer[] = await askQuizByVision(cfg, ctx.shot, { maxMs: goal.budget.maxMs });
    steps++;
    deps.checkpoint();
    const callMs = Date.now() - t0;
    deps.log('info', `  AI 返回 ${answers.length} 题（${(callMs / 1000).toFixed(1)}s）`);
    answered = answers.length;

    // 3) 批量点击（多选题要点多个位置）
    for (const a of answers) {
      deps.checkpoint();
      if (a.answer === '?') {
        deps.log('info', `    Q${a.q} 跳过（模型不确定）`);
        continue;
      }
      // 判断题：坐标常不可靠，先试文本匹配
      const isJudge = /^(对|错|正确|错误)$/.test(a.answer.trim());
      let hits = 0;
      let lastDist = 0;

      if (isJudge) {
        if (await clickJudgeByText(page, a.answer)) hits = 1;
        else if (a.points.length) {
          const r = await clickOptionNearPoint(page, ctx.box, a.points[0].x, a.points[0].y);
          if (r.ok) { hits = 1; lastDist = r.dist; }
        }
      } else {
        // 单选/多选/填空：每个坐标都要点
        const pts = a.points.length ? a.points : [];
        for (const pt of pts) {
          const r = await clickOptionNearPoint(page, ctx.box, pt.x, pt.y);
          if (r.ok) { hits++; lastDist = r.dist; }
          await deps.sleep(200);
        }
      }

      if (hits > 0) {
        clicked += hits;
        const snap = lastDist > 25 && lastDist !== Infinity ? `（坐标吸附 ${Math.round(lastDist)}px）` : '';
        deps.log('info', `    Q${a.q} ${a.answer} ✓${hits > 1 ? ` ×${hits}` : ''}${snap}`);
      } else {
        deps.log('warn', `    Q${a.q} ${a.answer} 点击失败`);
      }
      await deps.sleep(300);
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

/** 测验目标：提交后弹窗消失即视为完成 */
export function quizGoal(containerSelector?: string): AgentGoal {
  return {
    name: 'quiz',
    describe: '回答测验并提交',
    containerSelector,
    budget: { maxSteps: 8, maxMs: 90000 },
    done: async ctx => {
      if (!containerSelector) return true;
      try {
        const loc = ctx.page.locator(containerSelector).first();
        // 注意：display:none 的元素 count() 仍为 1，必须判断可见性
        return !(await loc.isVisible().catch(() => false));
      } catch {
        return true;
      }
    },
  };
}