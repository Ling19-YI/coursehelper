import type { Frame, Page } from 'playwright';

/**
 * 元素截图：把某个元素在**屏幕上的实际渲染结果**截成 PNG base64。
 *
 * 为什么不能直接用 elementHandle.screenshot()：
 * 超星的测验内容在一层 iframe 里，题目元素在更内层的 iframe 里。
 * Playwright 自带的 element screenshot 会自己做坐标换算，但它按元素
 * 自身的 bounding box 裁剪，遇到元素的一部分在 iframe 视口外（被父层
 * 裁掉了）就会截到空白。这里自己做一遍，能保证「截到的就是用户看到的」。
 *
 * 三个必须处理的点：
 *   1. 元素可能在 iframe 视口外 —— 先滚动到视口居中
 *   2. 滚动父层会带着 iframe 一起移动 —— 滚完必须重读 rect
 *   3. rect 是相对各自文档的 —— 要逐层向上累加到屏幕坐标
 */
export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 让元素在**所有**祖先 iframe 的视口里都可见且尽量居中 */
async function centerInAllViewports(page: Page, frame: Frame, selector: string): Promise<void> {
  // 先在自己这层滚到位
  await frame
    .evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (el) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    }, selector)
    .catch(() => {});

  // 逐层向上：把内层 iframe 滚到父视口居中
  let cur = frame;
  for (let depth = 0; depth < 8; depth++) {
    const parent = cur.parentFrame();
    if (!parent) break;
    const info = await cur.evaluate(() => {
      const fe = window.frameElement as HTMLElement | null;
      if (!fe) return null;
      const r = fe.getBoundingClientRect();
      return { top: r.top, left: r.left, w: r.width, h: r.height, vh: window.innerHeight, vw: window.innerWidth };
    }).catch(() => null);
    if (!info) break;

    await parent
      .evaluate(
        (i: { top: number; left: number; w: number; h: number; vh: number; vw: number }) => {
          const fe = window.frameElement as HTMLElement | null;
          if (!fe) return;
          const r = fe.getBoundingClientRect();
          const dx = i.left + i.w / 2 - (r.left + r.width / 2);
          const dy = i.top + i.h / 2 - (r.top + r.height / 2);
          window.scrollBy(dx, dy);
        },
        info
      )
      .catch(() => {});
    cur = parent;
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(150);
}

/** 逐层向上换算成屏幕坐标，并在每层重读 rect（滚动会让位置漂移） */
async function screenRect(page: Page, frame: Frame, selector: string): Promise<CaptureRect | null> {
  let chain = frame;
  const parents: Frame[] = [];
  for (let i = 0; i < 8; i++) {
    const p = chain.parentFrame();
    if (!p) break;
    parents.push(p);
    chain = p;
  }

  // 从内层往外累加，每一层都重新读取，避免前面滚动造成的偏移
  const local = await frame
    .evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }, selector)
    .catch(() => null);
  if (!local || local.w < 4 || local.h < 4) return null;

  let rect: CaptureRect = { x: local.x, y: local.y, width: local.w, height: local.h };

  for (const parent of parents) {
    const off = await frame
      .evaluate(() => {
        const fe = window.frameElement as HTMLElement | null;
        if (!fe) return null;
        const r = fe.getBoundingClientRect();
        return { left: r.left, top: r.top, clientLeft: fe.clientLeft, clientTop: fe.clientTop };
      })
      .catch(() => null);
    if (!off) return null;
    rect.x += off.left + off.clientLeft;
    rect.y += off.top + off.clientTop;
    frame = parent;
  }
  return rect;
}

/**
 * 截取题目元素。返回 PNG 的 data URL。
 * elementSelector 必须是 frame 内的 CSS 选择器。
 */
export async function captureElement(
  page: Page,
  frame: Frame,
  elementSelector: string,
  opts: { pad?: number; maxHeight?: number } = {}
): Promise<string> {
  const pad = opts.pad ?? 8;
  const maxHeight = opts.maxHeight ?? 1400;

  await centerInAllViewports(page, frame, elementSelector);

  let rect = await screenRect(page, frame, elementSelector);
  if (!rect) throw new Error('找不到要截图的题目元素');

  // 元素太长（整页题干 + 很多选项）时按上限裁，避免图片过大被接口拒
  const height = Math.min(rect.height + pad * 2, maxHeight);

  const vp = page.viewportSize() || { width: 1440, height: 900 };
  const x = Math.max(0, Math.round(rect.x - pad));
  const y = Math.max(0, Math.round(rect.y - pad));
  let width = Math.min(Math.round(rect.width + pad * 2), vp.width - x);
  if (width < 8) width = Math.min(Math.round(rect.width + pad * 2), vp.width);
  let h = height;
  if (h < 8 || y + h > vp.height) {
    // 底部超出视口：改成从底部往上取，高度压到视口内
    h = Math.max(8, Math.min(h, vp.height - y));
  }

  if (width < 8 || h < 8) throw new Error('题目元素在视口内不可见，无法截图');

  const buf = await page.screenshot({
    clip: { x, y, width: Math.round(width), height: Math.round(h) },
    type: 'png',
    animations: 'disabled',
  });
  return `data:image/png;base64,${buf.toString('base64')}`;
}

/** 校验是不是合法的 PNG data URL——接口只认这个格式，早失败比晚失败好 */
export function assertPngDataUrl(url: string): void {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(url)) {
    throw new Error('题目截图格式无效');
  }
}