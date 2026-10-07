import type { Page, Frame } from 'playwright';
import type { EngineHooks } from './hooks';

export type DocResult = 'scrolled' | 'unsupported';

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

/**
 * 文档型任务点：渐进滚动所有可滚动容器到底（chaoxing panView/wps/pdf 均适用）。
 * 实测：滚动完全部页面后平台任务点 +1。
 */
export async function handleDocument(page: Page, h: EngineHooks): Promise<DocResult> {
  const plan: Plan[] = [];
  for (const frame of page.frames()) {
    try {
      const data = await frame.evaluate(() => {
        const entries: { idx: number; sh: number; ch: number }[] = [];
        const all = document.querySelectorAll('*');
        for (let i = 0; i < all.length && entries.length < 6; i++) {
          const e = all[i] as HTMLElement;
          if (e.scrollHeight > e.clientHeight + 80 && e.clientHeight > 200) {
            entries.push({ idx: i, sh: e.scrollHeight, ch: e.clientHeight });
          }
        }
        const winScroll = document.documentElement.scrollHeight > window.innerHeight + 80;
        return { entries, winScroll, href: String(location.href) };
      });
      if (data.entries.length || data.winScroll) {
        plan.push({ frame, entries: data.entries, winScroll: data.winScroll });
      }
    } catch {}
  }

  if (!plan.length) return 'unsupported';

  let maxDelta = 0;
  for (const p of plan) {
    for (const e of p.entries) maxDelta = Math.max(maxDelta, e.sh - e.ch);
    if (p.winScroll) maxDelta = Math.max(maxDelta, 1200);
  }
  const steps = Math.max(12, Math.min(60, Math.ceil(maxDelta / 700)));
  h.log('info', `   📄 检测到文档，渐进滚动（${steps} 步）…`);

  for (let s = 1; s <= steps; s++) {
    h.ctl.throwIfStopped();
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

  await h.ctl.sleep(3000);
  h.log('ok', '   ✓ 文档滚动完成');
  return 'scrolled';
}
