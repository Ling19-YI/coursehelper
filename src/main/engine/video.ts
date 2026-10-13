import type { Page, Frame } from 'playwright';
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

/**
 * 判定「这个任务点已经看完了」的容差（秒）。
 *
 * ⚠️ waitForVideoEnd 判「完成」与 probeVideo 判「跳过已播完」**必须共用这一个值**。
 * 曾经一个写 5、一个写 1：477s 的视频在 472s 就被判为完成，却要到 476s 才算
 * 「已播完」；停在 475.5s 的视频两头不靠——刚判完完成又被 probeVideo 选中重播，
 * 表现为「一章两个视频，第一个反复播，第二个永远轮不到」。
 */
const VIDEO_DONE_TOLERANCE_SEC = 5;

/**
 * 每个视频最多自动处理几道随堂弹题。
 *
 * 上限是**防死循环**，不是「一个视频只有一道题」——实测有课程在同一视频里
 * 连着弹多道（答完一道收起后又弹下一道）。没有上限时，若弹题被点了不消失，
 * 会反复处理同一道题，与 StallGuard 的 45s 卡住判定互相打架。
 */
const VIDEO_POPUP_MAX_PER_VIDEO = 3;

/**
 * probeVideo 最近选中的视频 src，供上层记录「这个任务点已处理完」。
 * 时长启发式可能因为 duration 偶发读到 0 而失效，按 src 精确排除更稳。
 */
let lastPickedSrc: string | null = null;

/** 取最近一次被选中播放的视频 src；没选中过返回 null */
export function lastPickedVideoSrc(): string | null {
  return lastPickedSrc;
}

/**
 * 给「已完成任务点」里的 iframe 打上 data-ch-finished。
 *
 * 平台自己在知识卡容器上写 `ans-job-finished`（实测 class 形如
 * `ans-attach-ct videoContainer ans-job-finished`），这是最权威的完成信号：
 * 比时长容差可靠（平台 90% 就算过，容差对不齐就来回打架），
 * 也比 src 比对可靠（src 带会话 token，页面一重载就变，集合对不上）。
 *
 * 打标后由 probeVideo 跳过这些 frame，从根上避免「已完成的任务点被反复重播」。
 */
async function tagFinishedJobFrames(page: Page): Promise<void> {
  for (const frame of page.frames()) {
    try {
      // 用 for 循环而不是 forEach：evaluate 的函数体里一律不写函数字面量
      // （见 markTargetVideo 里关于 __name 的说明）
      await frame.evaluate(() => {
        const ifr = document.querySelectorAll('iframe');
        for (let i = 0; i < ifr.length; i++) {
          const f = ifr[i];
          const box = f.closest(
            '[class*="ans-attach-ct"], [class*="ans-job-wrap"], [class*="ans-job"]'
          );
          const done = !!box && String(box.className).includes('ans-job-finished');
          if (done) f.setAttribute('data-ch-finished', '1');
          else f.removeAttribute('data-ch-finished');
        }
      });
    } catch {}
  }
}

/** 该 frame 对应的任务点是否已被平台标记完成 */
async function isFinishedFrame(frame: Frame): Promise<boolean> {
  try {
    const fe = await frame.frameElement();
    if (!fe) return false;
    return (await fe.getAttribute('data-ch-finished')) === '1';
  } catch {
    // 顶层 frame 没有 frameElement，判定为非完成
    return false;
  }
}

/**
 * 「当前目标视频」的 DOM 属性名。
 *
 * 必须有唯一定义。旧实现有三套选法，结论不一致：
 *   1. probeVideo  —— 过滤可见/未播完/已跳过 后取第一个
 *   2. forcePlay   —— `document.querySelector('video')`，不做任何过滤
 *   3. 保活 ticker —— `querySelectorAll('video')` 全量拉起
 * 同一章节页里并列多个任务点视频时（实机见过两个 ananas/modules/video
 * iframe），三者各选各的：一个被驱动，另一个被 ticker 也拉起来，两个同时
 * 往前跑——用户看到的就是「一章两个视频，上下来回切换」。
 *
 * 做成 DOM 属性而非模块变量：页面重载/iframe 重挂后标记自然消失，
 * 不需要额外的失效判断，也不会跨章节串味。
 */
const TARGET_ATTR = 'data-ch-target';

/** 等待视频元数据（duration）就绪的上限 */
const VIDEO_META_TIMEOUT_MS = 8000;

/**
 * 锁定本章「该播的那一个视频」，返回它的 src（没锁定到返回 null）。
 *
 * 已锁定的目标仍然有效则**沿用**——重选会让同页两个任务点的视频互相抢，
 * 每轮换一个，画面来回切。目标已播完 / 已进 skipList / 平台已标记完成时才
 * 释放并重选。
 *
 * 选定后立刻暂停同页其它视频：它们会被保活 ticker 一并拉起，两个同时播
 * 既浪费带宽，也可能被平台记成异常。
 */
export async function markTargetVideo(
  page: Page,
  h: EngineHooks,
  skipSrcs?: Set<string>
): Promise<{ src: string } | null> {
  const skip = skipSrcs && skipSrcs.size ? Array.from(skipSrcs) : [];
  for (const frame of page.frames()) {
    // 平台已标记完成的任务点，其视频不再驱动
    if (await isFinishedFrame(frame)) continue;
    try {
      // ⚠️ evaluate 的函数体是被序列化后送到浏览器执行的，两条铁律：
      //   1. 引用不到模块级常量（容差必须作为参数传进来）
      //   2. 不能定义具名函数 —— tsx/esbuild 会注入 __name(...)，
      //      浏览器里没有这个符号 → ReferenceError，而异常常被外层 catch
      //      吞掉，表现为功能整体静默失效。所以这里一律用 for 循环。
      const hit = await frame.evaluate(
        (args: { skipList: string[]; tolSec: number }) => {
          const all = document.querySelectorAll('video');
          const usable: HTMLVideoElement[] = [];
          for (let i = 0; i < all.length; i++) {
            const v = all[i] as HTMLVideoElement;
            const r = v.getBoundingClientRect();
            if (r.width >= 100 && r.height >= 60) usable.push(v);
          }
          if (!usable.length) return null;

          // ① 已锁定的目标优先
          let target: HTMLVideoElement | null = null;
          for (let i = 0; i < usable.length; i++) {
            if (usable[i].getAttribute('data-ch-target') === '1') {
              target = usable[i];
              break;
            }
          }

          // ② 目标是否还有效
          if (target) {
            const src0 = target.currentSrc || target.src || '';
            const stale =
              (!!src0 && args.skipList.indexOf(src0) >= 0) ||
              target.ended ||
              (target.duration > 0 &&
                target.currentTime >= target.duration - args.tolSec);
            if (stale) {
              target.removeAttribute('data-ch-target');
              target = null;
            }
          }

          // ③ 没锁定就重选
          if (!target) {
            for (let i = 0; i < usable.length; i++) {
              const v = usable[i];
              const s = v.currentSrc || v.src || '';
              if (s && args.skipList.indexOf(s) >= 0) continue;
              if (v.ended) continue;
              if (v.duration > 0 && v.currentTime >= v.duration - args.tolSec) continue;
              target = v;
              break;
            }
            if (!target) return null;
            for (let i = 0; i < usable.length; i++) {
              const v = usable[i];
              if (v === target) continue;
              v.removeAttribute('data-ch-target');
              try {
                v.pause();
              } catch (e) {}
            }
            target.setAttribute('data-ch-target', '1');
          }

          return { src: target.currentSrc || target.src || '' };
        },
        { skipList: skip, tolSec: VIDEO_DONE_TOLERANCE_SEC }
      );
      if (hit) return hit;
    } catch (e) {
      rethrowIfStopped(h, e);
    }
  }
  return null;
}

/**
 * 读「已锁定目标」的状态并保活（暂停则拉起）；没有目标时返回 null。
 *
 * 与 probeVideo 的区别是**不重选**：waitForVideoEnd 期间目标必须稳定，
 * 中途换目标等于把已经播的作废、从头再播一遍——那正是要修的「反复重播」。
 */
async function readTargetState(page: Page, h: EngineHooks) {
  for (const frame of page.frames()) {
    try {
      const st = await forcePlay(frame, h.muted(), true);
      if (st) return { state: st, frame };
    } catch (e) {
      rethrowIfStopped(h, e);
    }
  }
  return null;
}

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
export async function waitForVideo(
  page: Page,
  h: EngineHooks,
  skipSrcs?: Set<string>
): Promise<boolean> {
  // 刚进页面就弹扫码/验证码时，先等用户处理完再做保活动作
  const pre = await detectManualBlock(page, h.autoPauseOnVerify());
  if (pre) {
    h.log('warn', `⚠ 检测到${pre.kind}弹窗：${pre.matched}`);
    h.log('warn', `  ${pre.hint}`);
    const gone = await waitBlockGone(page, h);
    if (!gone) return false;
    h.log('ok', '  ✓ 弹窗已处理，继续');
  }

  // 先按平台的权威标记标出「已完成的任务点」，probeVideo 会跳过它们
  await tagFinishedJobFrames(page);

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
    last = await probeVideo(page, h, skipSrcs);
    if (last && last.state.d > 0) {
      const actual = last.state.rate || 1;
      if (last.state.paused) {
        // 唤醒要用**目标所在的 frame**，不是 frames()[0]。
        // 目标在子 iframe 里（实机是 top>if0>if0），对顶层 frame 发唤醒
        // 事件它收不到，视频照样停着。
        const woke = await wakeUp(page, last.frame, h.muted());
        if (woke) last = { state: woke, frame: last.frame };
      }
      const eta = want > 1 ? `，约 ${Math.round(last.state.d / actual / 60)} 分钟看完` : '';
      if (want > 1 && actual < want - 0.01) {
        h.log('warn', `⚠ 平台把倍速限制在 ${actual}x（目标 ${want}x）`);
      } else {
        h.log('ok', `✓ 视频: ${Math.round(last.state.d)}s（${actual}x${eta}）`);
      }
      return true;
    }
    // duration 还没出来，但播放头已经在动，说明确实是视频，只是元数据慢
    if (last && last.state.ct > 0) {
      h.log('ok', `✓ 视频: 正在播放（${last.state.ct.toFixed(1)}s，${last.state.rate || 1}x）`);
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
 * 选定目标视频并驱动播放，返回它的状态。
 *
 * 选谁由 markTargetVideo 决定——「现在在播哪个视频」必须与 forcePlay、保活
 * ticker 共用同一份定义（见 TARGET_ATTR 的注释）。旧实现在这里另写了一套
 * 过滤规则，与 forcePlay 的「无条件取第一个」结论不一致，于是两个视频互相抢。
 */
async function probeVideo(page: Page, h: EngineHooks, skipSrcs?: Set<string>) {
  const picked = await markTargetVideo(page, h, skipSrcs);
  if (!picked) return null;
  lastPickedSrc = picked.src || null;

  // 目标标记打在哪个 frame 的 video 上，就驱动那个 frame
  for (const frame of page.frames()) {
    try {
      const has = await frame.evaluate(
        () => !!document.querySelector('video[data-ch-target="1"]')
      );
      if (!has) continue;
      const st = await forcePlay(frame, h.muted());
      if (st) return { state: st, frame };
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
export async function waitForVideoEnd(
  page: Page,
  h: EngineHooks,
  skipSrcs?: Set<string>
): Promise<VideoResult> {
  const ctl = h.ctl;
  const stall = StallGuard();
  let iteration = 0;
  let lastUrl = page.url();
  // 已提示过的弹窗类型，避免每 3 秒刷一次同样的日志
  let announced: string | null = null;
  // 进入本函数时的目标 src。目标标记万一丢失（iframe 重挂或平台已做完移除），
  // 重选后若是另一个视频，说明当前任务点已经了结，不必再等。
  const enteredSrc = lastPickedSrc;
  // 每个视频最多处理几道随堂弹题。上限是防死循环，不是「一个视频只有一道题」——
  // 有的课在同一个视频里连着弹好几道，答到上限就交给用户处理。
  let popupSeen = 0;

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

    // 视频播放期间的随堂弹题。
    //
    // 判定依据是 #videoquiz-submit 这个提交按钮，而不是「页面上有没有弹窗容器」——
    // 超星页面上常驻一堆空弹窗容器（#workpop / #hintPop 等），按容器判断会一直误报。
    //
    // 默认关闭：设置项 answerPopup。平台把弹题当考勤手段的课程不在此列。
    //
    // 次数上限而不是「只处理一次」：不少课程在同一个视频里会连着弹好几道。
    // 上限存在的理由是防死循环——弹题被点了不消失时，反复处理同一道题
    // 会和 StallGuard 的45s 卡住判定打架。上限内答完就停。
    if (h.answerPopup() && popupSeen < VIDEO_POPUP_MAX_PER_VIDEO) {
      try {
        const r = await answerVideoPopup(page, h, h.visionChannel(), {
          tiku: h.tiku(),
          submitCoverRate: h.submitCoverRate(),
        });
        if (r) {
          popupSeen++;
          h.log(
            'ok',
            `    ✓ 随堂弹题已处理（点选 ${r.answered}，提交 ${r.submitted}${r.retried ? `，改选 ${r.retried}` : ''}）`
          );
        }
      } catch (e) {
        rethrowIfStopped(h, e);
        // 抛异常说明处理链路本身坏了，再试只会重复报错，直接封顶。
        popupSeen = VIDEO_POPUP_MAX_PER_VIDEO;
        h.log('warn', `    ⚠ 随堂弹题处理失败：${String((e as any)?.message || e).slice(0, 70)}`);
      }
    }

    // 只读「已锁定目标」的状态，**不重选**。
    // 旧实现每轮遍历所有 frame 调 forcePlay，选中的可能不是 probeVideo 选定的
    // 那一个，且保活 ticker 又会把页面上所有 video 都拉起来——两三个视频同时
    // 往前跑，界面上就是「上下来回切换」。现在目标由 data-ch-target 唯一确定。
    let found = await readTargetState(page, h);
    if (!found) {
      // 目标标记丢了：可能是 iframe 重挂（重选会选回同一个，继续播），
      // 也可能是平台已把该任务点做完并移走（这时应视为本节完成）。
      const repicked = await probeVideo(page, h, skipSrcs);
      if (!repicked) {
        h.log('warn', '⚠ 视频元素消失');
        return 'unexpected';
      }
      if (enteredSrc && lastPickedSrc && lastPickedSrc !== enteredSrc) {
        h.log('ok', '✓ 当前任务点已了结（平台已切到下一个）');
        return 'completed';
      }
      found = repicked;
    }

    let s = found.state;
    if (s.paused) {
      h.log('info', `⏸ 暂停 (focus=${s.focus}, vis=${s.vis}${s.err ? ', ' + s.err : ''}) → 唤醒`);
      try {
        s = (await wakeUp(page, found.frame, h.muted())) || s;
      } catch (e) {
        rethrowIfStopped(h, e);
      }
    }

    h.onTick({ ct: s.ct, d: s.d, paused: s.paused, rate: s.rate });
    h.log('info', `[${iteration}] ${s.ct.toFixed(2)}/${Math.round(s.d)}s paused=${s.paused} rate=${s.rate}x`);

    if (s.ended || (s.d > 0 && s.ct >= s.d - VIDEO_DONE_TOLERANCE_SEC)) {
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
      // 按可能性排序给可操作的下一步，而不是泛泛说"常见原因"——
      // 用户看到这行时最想知道的是"我该怎么办"。
      h.log('warn', '  最可能：视频中途弹了随堂题/ 弹窗，视频已暂停');
      if (!h.answerPopup()) {
        h.log('warn', '  → 「设置 → 视频中的随堂题弹窗」默认关闭，开启后会自动答题');
      }
      h.log('warn', '  其次：平台限流或弹窗遮挡 → 看下方 diag 截图');
      const d = await h.diag('stuck');
      if (d) h.log('info', `[diag] ${d}`);
      return 'stuck';
    }

    await ctl.sleep(3000);
  }
}
