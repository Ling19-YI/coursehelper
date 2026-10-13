import type { Page, Frame } from 'playwright';
import type { EngineHooks } from './hooks';

export type DocResult = 'scrolled' | 'unsupported' | 'left';

interface Entry {
  idx: number;
  sh: number;
  ch: number;
}

interface Plan {
  frame: Frame;
  entries: Entry[];
  winScroll: boolean;
}

/** 在单个 frame 内探测：可滚动容器 + 是否含大尺寸媒体（图片型文档） */
async function probeFrame(
  frame: Frame
): Promise<{ entries: Entry[]; winScroll: boolean; hasMedia: boolean } | null> {
  try {
    return await frame.evaluate(() => {
      // 懒加载图片在滚动前不会撑开容器，scrollHeight == clientHeight，
      // 于是「图片型文档」被误判成不可滚动。先把懒加载全部转 eager。
      document.querySelectorAll('img[loading="lazy"]').forEach(img => {
        (img as HTMLImageElement).loading = 'eager';
      });

      const entries: { idx: number; sh: number; ch: number }[] = [];
      const all = document.querySelectorAll('*');
      for (let i = 0; i < all.length && entries.length < 8; i++) {
        const e = all[i] as HTMLElement;
        // 阈值放宽：小窗口阅读器（clientHeight 一两百）同样需要滚动才算完成
        if (e.scrollHeight > e.clientHeight + 30 && e.clientHeight > 120) {
          entries.push({ idx: i, sh: e.scrollHeight, ch: e.clientHeight });
        }
      }
      const winScroll = document.documentElement.scrollHeight > window.innerHeight + 30;

      // 图片型文档：内容主要靠拖拽平移，不一定存在可滚动容器
      let mediaArea = 0;
      document.querySelectorAll('img,canvas,svg,video').forEach(m => {
        const r = m.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > mediaArea) mediaArea = area;
      });
      const hasMedia = mediaArea > window.innerWidth * window.innerHeight * 0.25;

      return { entries, winScroll, hasMedia };
    });
  } catch {
    return null;
  }
}

/**
 * 拖拽翻页：部分阅读器（图片型文档）是「按住往下拖」的，设 scrollTop 完全不动。
 *
 * 必须用 Playwright 的真实鼠标事件——合成事件（dispatchEvent）isTrusted 为
 * false，多数平移库会直接忽略。
 */
async function dragScroll(page: Page, frame: Frame, rounds: number): Promise<boolean> {
  let box: { x: number; y: number; width: number; height: number } | null = null;
  try {
    const fe = await frame.frameElement();
    box = fe ? await fe.boundingBox() : null;
  } catch {
    box = null;
  }
  if (!box) {
    // 顶层页面没有 frameElement，用可视区
    const vp = page.viewportSize() || { width: 1200, height: 800 };
    box = { x: 0, y: 0, width: vp.width, height: vp.height };
  }
  if (box.width < 80 || box.height < 80) return false;

  const cx = box.x + box.width / 2;
  const yStart = box.y + box.height * 0.82;
  const yEnd = box.y + box.height * 0.18;

  for (let r = 0; r < rounds; r++) {
    await page.mouse.move(cx, yStart);
    await page.mouse.down();
    const steps = 16;
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(cx, yStart + (yEnd - yStart) * (i / steps));
      await page.waitForTimeout(20);
    }
    await page.mouse.up();
    await page.waitForTimeout(350);
  }
  return true;
}

/**
 * 文档型任务点：让内容从头过到尾。
 *
 * 兼容两种形态：
 *   1. 可滚动容器（chaoxing panView / wps / pdf）—— 渐进设 scrollTop
 *   2. 图片型文档，内容靠按住拖动平移 —— 真实鼠标拖拽
 *
 * 旧实现只认形态 1，且探测不到可滚动容器时直接返回 unsupported，
 * 于是「图片型文档」这类任务点被当成「无视频/无文档」跳过——
 * 用户反馈的「需要向下拖动的任务点做不了」就是这种情况。
 *
 * 实测：内容完整过一遍后平台任务点 +1。
 */
export async function handleDocument(page: Page, h: EngineHooks): Promise<DocResult> {
  // 懒加载图片撑开容器需要时间，否则探测不到溢出
  await h.ctl.sleep(1500);
  // 用户可能在上面这段等待里手动切走了本节
  if (h.chapterLeft()) return 'left';

  const plan: Plan[] = [];
  const mediaFrames: Frame[] = [];
  for (const frame of page.frames()) {
    const p = await probeFrame(frame);
    if (!p) continue;
    if (p.entries.length || p.winScroll) {
      plan.push({ frame, entries: p.entries, winScroll: p.winScroll });
    }
    if (p.hasMedia) mediaFrames.push(frame);
  }

  // 既没有可滚动容器、也没有大图/画布 → 确实没什么可做的
  if (!plan.length && !mediaFrames.length) return 'unsupported';

  let maxDelta = 0;
  for (const p of plan) {
    for (const e of p.entries) maxDelta = Math.max(maxDelta, e.sh - e.ch);
    if (p.winScroll) maxDelta = Math.max(maxDelta, 1200);
  }

  // ── 形态 1：滚动 ──
  if (plan.length) {
    const steps = Math.max(12, Math.min(60, Math.ceil(maxDelta / 700)));
    h.log('info', `   📄 检测到可滚动文档，渐进滚动（${steps} 步）…`);
    for (let s = 1; s <= steps; s++) {
      h.ctl.throwIfStopped();
      // 手动切章节后别再对着新章节的容器滚——那不是本章的文档
      if (h.chapterLeft()) return 'left';
      const t = s / steps;
      for (const p of plan) {
        try {
          await p.frame.evaluate(
            (args: { entries: Entry[]; winScroll: boolean; t: number }) => {
              const all = document.querySelectorAll('*');
              if (args.winScroll) {
                const max = document.documentElement.scrollHeight - window.innerHeight;
                window.scrollTo(0, Math.round(max * args.t));
              }
              for (const e of args.entries) {
                const el = all[e.idx] as HTMLElement | undefined;
                if (el && el.scrollHeight > el.clientHeight) {
                  el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * args.t);
                }
              }
            },
            { entries: p.entries, winScroll: p.winScroll, t }
          );
        } catch {}
      }
      if (s % Math.ceil(steps / 4) === 0) h.log('info', `   滚动进度 ${Math.round(t * 100)}%`);
      await h.ctl.sleep(800);
    }
  }

  // ── 形态 2：拖拽 ──
  // 有可滚动容器时也补一轮：部分阅读器两种都吃，多拖几下不会更差
  const dragTargets = mediaFrames.length ? mediaFrames : plan.map(p => p.frame);
  if (dragTargets.length) {
    h.log('info', `   📄 尝试拖拽翻页（${dragTargets.length} 个区域）…`);
    for (const f of dragTargets.slice(0, 3)) {
      h.ctl.throwIfStopped();
      try {
        await dragScroll(page, f, 3);
      } catch {}
    }
  }

  await h.ctl.sleep(3000);
  h.log('ok', '   ✓ 文档已完整过一遍');
  return 'scrolled';
}
