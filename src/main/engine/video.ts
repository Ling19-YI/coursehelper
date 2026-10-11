import type { Page } from 'playwright';
import { forcePlay, wakeUp, installPauseSpy, setVideoRate } from './keepalive';
import type { EngineHooks } from './hooks';

export type VideoResult = 'completed' | 'no_video' | 'stuck' | 'unexpected';

/** 等待视频元数据（duration）就绪的上限 */
const VIDEO_META_TIMEOUT_MS = 8000;

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

  // 混合章节（同时有视频与文档）页面较重，video 元素常先出现、
  // 元数据（duration）后加载。旧逻辑只看一次 s.d>0，
  // 元数据没到就判定「无视频」→ 走文档分支 → 视频被跳过。
  // 因此先确认 video 元素存在，再等 duration 就绪。
  const hasElement = await hasVideoElement(page);
  if (!hasElement) return false;

  const deadline = Date.now() + VIDEO_META_TIMEOUT_MS;
  let last: Awaited<ReturnType<typeof probeVideo>> = null;

  while (!h.ctl.isStopped) {
    last = await probeVideo(page, h);
    if (last && last.d > 0) {
      const actual = last.rate || 1;
      if (last.paused) {
        const woke = await wakeUp(page, page.frames()[0]);
        if (woke) last = woke;
      }
      const eta = want > 1 ? `，约 ${Math.round(last.d / actual / 60)} 分钟看完` : '';
      if (want > 1 && actual < want - 0.01) {
        h.log('warn', `⚠ 平台把倍速限制在 ${actual}x（目标 ${want}x）`);
      } else {
        h.log('ok', `✓ 视频: ${Math.round(last.d)}s（${actual}x${eta}）`);
      }
      return true;
    }
    // duration 还没出来，但播放头已经在动，说明确实是视频，只是元数据慢
    if (last && last.ct > 0) {
      h.log('ok', `✓ 视频: 正在播放（${last.ct.toFixed(1)}s，${last.rate || 1}x）`);
      return true;
    }
    if (Date.now() > deadline) break;
    await h.ctl.sleep(800);
  }

  h.log('warn', '    ⚠ 检测到 video 元素但始终未就绪，按文档处理');
  return false;
}

/** 任一 frame 里是否存在「可见且有尺寸」的 <video> */
async function hasVideoElement(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    try {
      const ok = await frame.evaluate(() => {
        for (const v of Array.from(document.querySelectorAll('video'))) {
          const r = (v as HTMLVideoElement).getBoundingClientRect();
          // 隐藏的、零尺寸的 <video> 常见于页脚装饰/预加载，不算正片
          if (r.width >= 100 && r.height >= 60) return true;
        }
        return false;
      });
      if (ok) return true;
    } catch {
      /* frame 可能正在导航，跳过 */
    }
  }
  return false;
}

/** 取第一个可见视频的播放状态 */
async function probeVideo(page: Page, h: EngineHooks) {
  for (const frame of page.frames()) {
    try {
      const s = await frame.evaluate(() => {
        for (const el of Array.from(document.querySelectorAll('video'))) {
          const v = el as HTMLVideoElement;
          const r = v.getBoundingClientRect();
          if (r.width < 100 || r.height < 60) continue;
          return {
            ct: v.currentTime,
            d: v.duration || 0,
            paused: v.paused,
            ended: v.ended,
            rate: v.playbackRate,
          };
        }
        return null;
      });
      if (s) {
        // 找到可见视频就驱动它播放并应用倍速
        return await forcePlay(frame);
      }
    } catch (e) {
      rethrowIfStopped(h, e);
    }
  }
  return null;
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

    // 视频播放期间不再检测/回答随堂题。
    // 用户要求：播放中遇到题目弹窗不要介入，等 StallGuard 判定卡住后提示即可。
    // 独立测验页面仍由 engine/index.ts -> handleQuiz 自动答题，不受影响。

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
