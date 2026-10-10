import type { Page } from 'playwright';
import { forcePlay, wakeUp, installPauseSpy, setVideoRate } from './keepalive';
import { handleQuizPopup } from './quiz';
import type { EngineHooks } from './hooks';

export type VideoResult = 'completed' | 'no_video' | 'stuck' | 'unexpected';

function rethrowIfStopped(h: EngineHooks, e: unknown) {
  if (h.ctl.isStopped) throw e;
}

/**
 * 视频播放进度守卫。
 * 播放中不再由 AI 介入答题，因此不需要 freeze 语义，
 * 但保留 reset 以兼容既有调用。
 */
export function StallGuard() {
  let lastTime = 0;
  let count = 0;
  return {
    /** 视频时间有推进则清零计数 */
    observe(ct: number) {
      if (ct > lastTime) {
        lastTime = ct;
        count = 0;
        return { tick: 1, stuck: false };
      }
      count++;
      return { tick: 0, stuck: count >= 15 };
    },
    /** 重置进度基准 */
    reset() {
      lastTime = 0;
      count = 0;
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

/** 轮询直到视频结束 / 卡住 / 异常（3s 一次，45s 无进度判定卡住） */
export async function waitForVideoEnd(page: Page, h: EngineHooks): Promise<VideoResult> {
  const ctl = h.ctl;
  const stall = StallGuard();
  let iteration = 0;
  let lastUrl = page.url();

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

    // 视频播放期间的随堂题弹窗。
    //
    // 默认关闭：平台弹窗出现时视频往往已经暂停，此时自动点选会让「卡住」与
    // 「该答题」两种状态混在一起，且部分课程老师会刻意用弹窗当 Attendance。
    // 用户可在设置里单独打开；打开后每轮最多处理一次，避免反复探测。
    let popupHandledThisVideo = false;
    if (h.answerPopup() && !popupHandledThisVideo) {
      try {
        const r = await handleQuizPopup(page, h, h.deepseekKey(), h.visionChannel(), {
          tiku: h.tiku(),
          submitCoverRate: h.submitCoverRate(),
        });
        if (r.popups) {
          popupHandledThisVideo = true;
          h.log('ok', `    ✓ 随堂弹窗已处理（${r.popups} 个，答 ${r.answered} 题，提交 ${r.submitted} 次）`);
        }
      } catch (e) {
        rethrowIfStopped(h, e);
        const msg = String((e as any)?.message || e);
        // 弹窗答题失败不该毁掉整个视频任务
        h.log('warn', `    ⚠ 随堂弹窗处理失败：${msg}`);
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
        return 'completed';
      }

      const st = stall.observe(s.ct);
      if (!st.tick && iteration % 3 === 0 && st.stuck !== undefined) {
        const d = await h.diag('stall');
        if (d) h.log('info', `[diag] ${d}`);
      }
      if (st.stuck) {
        h.log('warn', '⚠ 卡住（45s 无进度）');
        h.log('warn', '  常见原因：视频中途弹出随堂题需手动作答，或平台限流/弹窗遮挡');
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
