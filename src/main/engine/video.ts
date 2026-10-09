import type { Page } from 'playwright';
import { forcePlay, wakeUp, installPauseSpy, setVideoRate } from './keepalive';
import type { EngineHooks } from './hooks';
import { handleQuizPopup } from './quiz';
import { runAgent, quizGoal } from './agent/loop';

export type VideoResult = 'completed' | 'no_video' | 'stuck' | 'unexpected';

/** Agent 是否可接管：总开关 + 视觉服务已配置，缺一不可 */
export function agentUsable(h: EngineHooks): boolean {
  return h.agentEnabled() && !!h.vision().apiKey;
}

/** 检测到题目容器则返回其选择器（超星每题独立 .TiMu） */
async function findQuizSelector(page: import('playwright').Page): Promise<string | null> {
  for (const sel of ['.TiMu', '.TiDu', '[class*="TiMu"]', '[class*="TiDu"]', '#divVideoQuestion', '.layui-layer']) {
    const n = await page.locator(sel).count().catch(() => 0);
    if (n > 0) return sel;
  }
  return null;
}

function rethrowIfStopped(h: EngineHooks, e: unknown) {
  if (h.ctl.isStopped) throw e;
}

/**
 * Agent 答题期间视频必然暂停，若沿用原有 stall 计数会把「正在答题」误判为卡住。
 * 用 frozen 冻结 stall 计时，agent 结束后由调用方重置进度基准。
 */
export function StallGuard() {
  let lastTime = 0;
  let count = 0;
  let frozen = false;
  return {
    /** 冻结（Agent 接管期间），冻结中不累加也不判定卡住 */
    freeze(v: boolean) {
      frozen = v;
      if (v) count = 0;
    },
    /** 视频时间有推进则清零计数 */
    observe(ct: number) {
      if (frozen) return { tick: 0, stuck: false };
      if (ct > lastTime) {
        lastTime = ct;
        count = 0;
        return { tick: 1, stuck: false };
      }
      count++;
      return { tick: 0, stuck: count >= 15 };
    },
    /** Agent 结束后重置基准，避免把答题耗时算成卡住 */
    reset() {
      lastTime = 0;
      count = 0;
      frozen = false;
    },
  };
}

/** 找到视频并确保播放 */
export async function waitForVideo(page: Page, h: EngineHooks): Promise<boolean> {
  const want = Math.min(2, Math.max(1, h.speed() || 1));
  await setVideoRate(page, want);
  await installPauseSpy(page);
  for (const frame of page.frames()) {
    try {
      const v = await frame.$('video');
      if (!v) continue;
      let s = await forcePlay(frame);
      if (!s) continue;
      if (s.paused) s = (await wakeUp(page, frame)) || s;
      await h.ctl.sleep(2000);
      s = (await forcePlay(frame)) || s;
      if ((s.paused || s.ct < 2) && !h.ctl.isStopped) {
        const d = await h.diag('start');
        if (d) h.log('info', `[diag] ${d}`);
      }
      if (s.d > 0) {
        const actual = s.rate || 1;
        const eta = want > 1 ? `，约 ${Math.round(s.d / actual / 60)} 分钟看完` : '';
        if (want > 1 && actual < want - 0.01) {
          h.log('warn', `⚠ 平台把倍速限制在 ${actual}x（目标 ${want}x）`);
        } else {
          h.log('ok', `✓ 视频: ${Math.round(s.d)}s（${actual}x${eta}）`);
        }
        return true;
      }
    } catch (e) {
      rethrowIfStopped(h, e);
    }
  }
  return false;
}

/** 轮询直到视频结束 / 卡住 / 异常（3s 一次，45s 无进度判定卡住）；中途遇随堂弹窗自动答题 */
export async function waitForVideoEnd(
  page: Page,
  h: EngineHooks,
  apiKey?: string
): Promise<VideoResult> {
  const ctl = h.ctl;
  const stall = StallGuard();
  let iteration = 0;
  let lastUrl = page.url();
  let quizPopups = 0;
  let quizAnswered = 0;
  const useAgent = agentUsable(h);

  while (true) {
    ctl.throwIfStopped();
    iteration++;

    try {
      await page.mouse.move(180 + (iteration % 7) * 70, 240 + (iteration % 5) * 40);
    } catch {}
    if (iteration === 1) await installPauseSpy(page);
    if (iteration === 2) {
      const d = await h.diag('iter2');
      if (d) h.log('info', `[diag] ${d}`);
    }

    const currentUrl = page.url();
    if (currentUrl !== lastUrl) {
      h.log('warn', `⚠ 页面跳转: ${currentUrl.substring(0, 60)}`);
      lastUrl = currentUrl;
    }

    // 随堂练习/测验：视频中途弹题会让视频暂停，先检测并答题，再看视频状态
    // 答题期间冻结 stall 计时，否则会把「正在答题」误判为卡住
    if (useAgent) {
      const sel = await findQuizSelector(page);
      if (sel) {
        stall.freeze(true);
        try {
          h.log('info', '    → 检测到题目，启动 AI 答题');
          const r = await runAgent(h.vision(), page, quizGoal(sel), {
            log: (l, m) => h.log(l, m),
            checkpoint: () => ctl.throwIfStopped(),
            sleep: ms => ctl.sleep(ms),
          });
          if (r.clicked > 0) {
            quizPopups += 1;
            quizAnswered += r.clicked;
            h.log('ok', `    ✓ AI 答题完成（${r.answered} 题 / ${r.clicked} 次点击 / ${(r.ms / 1000).toFixed(0)}s）`);
            await setVideoRate(page, Math.min(2, Math.max(1, h.speed() || 1)));
            await installPauseSpy(page);
          } else {
            h.log('warn', `    ⚠ AI 未点中任何选项（${r.reason}）`);
          }
        } catch (e) {
          rethrowIfStopped(h, e);
          h.log('warn', `⚠ 答题异常：${(e as any)?.message || e}`);
        } finally {
          stall.reset();
        }
      }
    } else if (apiKey) {
      // 未开 Agent 开关时回退到纯文本答题
      stall.freeze(true);
      try {
        const popup = await handleQuizPopup(page, h, apiKey);
        if (popup.popups > 0) {
          quizPopups += popup.popups;
          quizAnswered += popup.answered;
          await setVideoRate(page, Math.min(2, Math.max(1, h.speed() || 1)));
          await installPauseSpy(page);
        }
      } catch (e) {
        rethrowIfStopped(h, e);
        h.log('warn', `⚠ 弹窗答题异常：${(e as any)?.message || e}`);
      } finally {
        stall.reset();
      }
    }

    let videoFound = false;
    for (const frame of page.frames()) {
      ctl.throwIfStopped();
      let s = null;
      try {
        s = await forcePlay(frame);
      } catch (e) {
        rethrowIfStopped(h, e);
      }
      if (!s) continue;
      videoFound = true;

      if (s.paused) {
        h.log('info', `⏸ 暂停 (focus=${s.focus}, vis=${s.vis}${s.err ? ', ' + s.err : ''}) → 唤醒`);
        try {
          s = (await wakeUp(page, frame)) || s;
        } catch (e) {
          rethrowIfStopped(h, e);
        }
      }

      h.onTick({ ct: s.ct, d: s.d, paused: s.paused, rate: s.rate });
      h.log('info', `[${iteration}] ${s.ct.toFixed(2)}/${Math.round(s.d)}s paused=${s.paused} rate=${s.rate}x`);

      if (s.ended || (s.d > 0 && s.ct >= s.d - 5)) {
        h.log('ok', '✓ 视频播放完成');
        if (quizPopups > 0) {
          h.log('ok', `✓ 本节共答 ${quizAnswered} 题（${quizPopups} 个随堂弹窗）`);
        }
        return 'completed';
      }

      const st = stall.observe(s.ct);
      if (!st.tick && iteration % 3 === 0 && st.stuck !== undefined) {
        const d = await h.diag('stall');
        if (d) h.log('info', `[diag] ${d}`);
      }
      if (st.stuck) {
        h.log('warn', '⚠ 卡住（45s 无进度）');
        const d = await h.diag('stuck');
        if (d) h.log('info', `[diag] ${d}`);
        return 'stuck';
      }
      break;
    }

    if (!videoFound) {
      h.log('warn', '⚠ 视频元素消失');
      return 'unexpected';
    }
    await ctl.sleep(3000);
  }
}
