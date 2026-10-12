import type { Page } from 'playwright';
import { forcePlay, wakeUp, installPauseSpy, setVideoRate } from './keepalive';
import { answerVideoPopup } from './videoQuiz';
import type { EngineHooks } from './hooks';
import { detectManualBlock } from './blocker';

/**
 * 等待人工处理弹窗消失。
 * 期间不做任何模拟动作，避免二维码被反复刷新。
 * 超过上限仍未处理完则放弃本节，交还给用户。
 */
async function waitBlockGone(page: Page, h: EngineHooks, maxMs = 180000): Promise<boolean> {
  const end = Date.now() + maxMs;
  let mins = -1;
  while (Date.now() < end) {
    await h.ctl.sleep(2000);
    if (await detectManualBlock(page, h.autoPauseOnVerify())) {
      const left = Math.ceil((end - Date.now()) / 60000);
      if (left !== mins) {
        mins = left;
        if (left > 0) h.log('info', `    等待处理中（剩余约 ${left} 分钟）`);
      }
      continue;
    }
    return true;
  }
  h.log('warn', `⚠ 等待超时（${Math.round(maxMs / 60000)} 分钟），本节交还给用户`);
  return false;
}

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
  // 刚进页面就弹扫码/验证码时，先等用户处理完再做保活动作
  const pre = await detectManualBlock(page, h.autoPauseOnVerify());
  if (pre) {
    h.log('warn', `⚠ 检测到${pre.kind}弹窗：${pre.matched}`);
    h.log('warn', `  ${pre.hint}`);
    const gone = await waitBlockGone(page, h);
    if (!gone) return false;
    h.log('ok', '  ✓ 弹窗已处理，继续');
  }

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
        const woke = await wakeUp(page, page.frames()[0], h.muted());
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

/**
 * 取第一个「还需要播」的可见视频的播放状态。
 *
 * 关键：跳过已经播完的。
 * 同一章节页里会同时挂多个任务点 iframe（实机见过两个
 * ananas/modules/video/index.html 并列），先播完的那个仍留在 DOM 里且依旧
 * 「可见」。如果不过滤，第二次探测还是会选中它，于是同一个视频被反复拿来
 * 判断，同章节的后续任务点永远轮不到——用户看到的就是「一章多任务点
 * 只刷第一个」。
 */
async function probeVideo(page: Page, h: EngineHooks) {
  for (const frame of page.frames()) {
    try {
      const s = await frame.evaluate(() => {
        for (const el of Array.from(document.querySelectorAll('video'))) {
          const v = el as HTMLVideoElement;
          const r = v.getBoundingClientRect();
          if (r.width < 100 || r.height < 60) continue;
          // 已结束 / 播放头已到末尾 → 这个任务点不用再管，看下一个
          if (v.ended) continue;
          if (v.duration > 0 && v.currentTime >= v.duration - 1) continue;
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
        return await forcePlay(frame, h.muted());
      }
    } catch (e) {
      rethrowIfStopped(h, e);
    }
  }
  return null;
}

/**
 * 本章节还剩几个任务点未完成（平台自己的隐藏计数）。
 * 读不到返回 null——不能把这个当成 0，否则会误判成「做完了」。
 *
 * ⚠️ 页面上会并列多个 .jobUnfinishCount（实机见到 4 个）。取其中的**最大值**：
 * 宁可多绕一轮（多跑一轮会被 MAX_ROUNDS 兜住，无副作用），
 * 也不能少算——少算会让引擎以为做完了，直接跳过剩下的任务点，
 * 那正是要修的「只刷第一个」。
 */
export async function readUnfinishedCount(page: Page): Promise<number | null> {
  for (const frame of page.frames()) {
    try {
      const v = await frame.evaluate(() => {
        const els = Array.from(
          document.querySelectorAll('input.jobUnfinishCount')
        ) as HTMLInputElement[];
        const nums = els
          .map(el => Number(el.value))
          .filter(n => Number.isFinite(n) && n >= 0);
        if (!nums.length) return null;
        return Math.max(...nums);
      });
      if (v !== null) return v;
    } catch {}
  }
  return null;
}

/**
 * 平台是否已宣告「今日任务点完成数已达上限」。
 *
 * 命中时视频能照常播放，但平台不会把任务点记为完成，进度一动不动。
 * 不单独识别的话，用户看到的是「刷了一整晚一个都没记上」，
 * 而日志里只会显示视频播放正常——完全无从解释。
 *
 * ⚠️ 必须遍历**全部** .jobLimitTip，不能 querySelector 取第一个。
 * 实测同一页面上会并列多个同 class 的元素，顺序大致是：
 *   [0] "当前章节还有任务点未完成，是否去完成？"
 *   [1] ""
 *   [2] "今日视频任务点完成数已达上限……"   ← 想找的是这个
 * 取第一个只会拿到「还有任务点未完成」，永远匹配不上上限文案。
 */
export async function detectDailyLimit(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    try {
      const hit = await frame.evaluate(() => {
        const els = Array.from(document.querySelectorAll('.jobLimitTip')) as HTMLElement[];
        for (const el of els) {
          const s = getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden') continue;
          // ⚠️ 不能只看自身 display：祖先 display:none 时子元素仍报 block，
          // 隐藏模板会被误判成「上限生效」——那会让整轮刷课白停。
          // getClientRects() 会算上祖先，被藏起来的元素返回空。
          if (el.getClientRects().length === 0) continue;
          if (/任务点完成数已达上限|无法完成任务点/.test(el.innerText || '')) return true;
        }
        return false;
      });
      if (hit) return true;
    } catch {}
  }
  return false;
}

/** 跳到本章下一个未完成的任务点（平台自带的 scroll2Job） */
export async function gotoUnfinishedJob(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    try {
      const ok = await frame.evaluate(() => {
        const fn = (window as any).scroll2Job;
        if (typeof fn !== 'function') return false;
        try {
          fn();
          return true;
        } catch {
          return false;
        }
      });
      if (ok) return true;
    } catch {}
  }
  return false;
}

/** 轮询直到视频结束 / 卡住 / 异常（3s 一次，45s 无进度判定卡住） */
export async function waitForVideoEnd(page: Page, h: EngineHooks): Promise<VideoResult> {
  const ctl = h.ctl;
  const stall = StallGuard();
  let iteration = 0;
  let lastUrl = page.url();
  // 已提示过的弹窗类型，避免每 3 秒刷一次同样的日志
  let announced: string | null = null;

  while (true) {
    ctl.throwIfStopped();
    iteration++;

    // ---- 人工介入优先判断 ----
    // 某些课程播放中会弹手机扫码 / 验证码 / 人脸识别。
    // 这类弹窗对鼠标与焦点变化敏感：一边"保活"一边扫码，
    // 二维码会被判定环境变化而无限刷新，用户永远扫不上。
    // 因此一旦命中，立刻停掉所有模拟动作，静待用户处理完。
    const block = await detectManualBlock(page, h.autoPauseOnVerify());
    if (block) {
      if (announced !== block.kind) {
        announced = block.kind;
        h.log('warn', `⚠ 检测到${block.kind}弹窗：${block.matched}`);
        h.log('warn', `  ${block.hint}`);
        h.log('warn', '  已暂停自动操作，处理完成后会自动继续；也可点「停止」结束本节');
      }
      // 不做任何 mouse.move / 事件派发 / 点击
      // 只低频轮询，等弹窗消失
      await ctl.sleep(2000);
      continue;
    }
    if (announced) {
      announced = null;
      h.log('ok', '  ✓ 弹窗已处理，恢复自动播放');
      await setVideoRate(page, Math.min(2, Math.max(1, h.speed() || 1)));
    }

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

    let popupHandledThisVideo = false;

    // 视频播放期间的随堂弹题。
    //
    // 判定依据是 #videoquiz-submit 这个提交按钮，而不是「页面上有没有弹窗容器」——
    // 超星页面上常驻一堆空弹窗容器（#workpop / #hintPop 等），按容器判断会一直误报。
    //
    // 默认关闭：设置项 answerPopup。平台把弹题当考勤手段的课程不在此列。
    if (h.answerPopup() && !popupHandledThisVideo) {
      try {
        const r = await answerVideoPopup(page, h, h.visionChannel(), {
          tiku: h.tiku(),
          submitCoverRate: h.submitCoverRate(),
        });
        if (r) {
          popupHandledThisVideo = true;
          h.log(
            'ok',
            `    ✓ 随堂弹题已处理（点选 ${r.answered}，提交 ${r.submitted}${r.retried ? `，改选 ${r.retried}` : ''}）`
          );
        }
      } catch (e) {
        rethrowIfStopped(h, e);
        h.log('warn', `    ⚠ 随堂弹题处理失败：${String((e as any)?.message || e).slice(0, 70)}`);
      }
    }

    let videoFound = false;
    for (const frame of page.frames()) {
      ctl.throwIfStopped();
      let s = null;
      try {
        s = await forcePlay(frame, h.muted());
      } catch (e) {
        rethrowIfStopped(h, e);
      }
      if (!s) continue;
      videoFound = true;

      if (s.paused) {
        h.log('info', `⏸ 暂停 (focus=${s.focus}, vis=${s.vis}${s.err ? ', ' + s.err : ''}) → 唤醒`);
        try {
          s = (await wakeUp(page, frame, h.muted())) || s;
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
