import type { Page } from 'playwright';

/** 一次截图的结果 */
export interface QuizShot {
  /** base64 JPEG（无 data: 前缀） */
  jpeg: string;
  /** 实际像素宽高 */
  w: number;
  h: number;
  /** 是否真的局部截图：坐标相对容器，为 false 时坐标相对整页 */
  cropped: boolean;
  /** 容器选择器（仅 cropped=true 时有效） */
  selector?: string;
  /** 被遮挡区域，便于排查是否误遮/漏遮 */
  redacted: Rect[];
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 模型坐标最长边上限。
 * 实测 mimo-v2.6-flash：1280px 截图耗时 29s 且输出被截断（答案不全），
 * 748px 21s / 560px 12.5s。局部截图优先，这里作为兜底上限。
 */
const MAX_EDGE = 768;
const JPEG_QUALITY = 55;

/** 脱敏遮挡层 id */
const REDACT_ID = '__ch_redact_layer';

/**
 * 坐标换算：把模型返回的坐标变成可点击的坐标。
 * - cropped=true  → 模型给的是容器内坐标，原样传给 element.click({position})
 * - cropped=false → 模型给的是整页坐标，原样传给 page.mouse.click()
 * 两种情况下 Playwright 期望的语义都已对齐，这里只做越界钳制，
 * 因为一旦在此处平移，视觉回退路径的全页坐标就会被二次偏移。
 */
export function toElementPoint(
  pt: { x: number; y: number },
  box: { width: number; height: number } | null
): { x: number; y: number } {
  if (!box) return { x: Math.max(0, pt.x), y: Math.max(0, pt.y) };
  return {
    x: Math.min(box.width, Math.max(0, pt.x)),
    y: Math.min(box.height, Math.max(0, pt.y)),
  };
}

/**
 * 超星页面存在永不停止的 CSS 动画（卡片轮播/进度条）。
 * Playwright 默认等待动画结束才截图，实测会卡满 30s 超时；
 * animations:'disabled' 可让同一次截图降到约 100ms。缺此参数 Agent 每一步都会超时。
 */
const SHOT_OPTS = {
  type: 'jpeg' as const,
  quality: JPEG_QUALITY,
  animations: 'disabled' as const,
  caret: 'hide' as const,
  timeout: 15000,
};

/**
 * 截图带重试。嵌入 WebContentsView 下合成器偶尔未就绪，
 * 实测同一页面上相邻两次调用会有一次失败，需重试兜底。
 */
async function shoot(fn: () => Promise<Buffer>, attempts = 3): Promise<Buffer | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch {
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 400));
    }
  }
  return null;
}

/**
 * 截图并可选脱敏。
 * - selector 存在则局部截图，坐标相对容器（iframe 偏移自动消失）
 * - redact 为 true 时遮挡姓名条 / 头像 / 二维码
 */
export async function captureQuizShot(
  page: Page,
  opts: { selector?: string; redact?: boolean } = {}
): Promise<QuizShot | null> {
  const { selector, redact } = opts;
  let w = 0;
  let h = 0;
  let cropped = false;
  let used: string | undefined;
  let redacted: Rect[] = [];

  // 优先局部截图：坐标相对容器，iframe 偏移问题自动消失
  if (selector) {
    const loc = page.locator(selector).first();
    const box = (await loc.count().catch(() => 0)) ? await loc.boundingBox() : null;
    if (box && box.width > 0 && box.height > 0) {
      cropped = true;
      used = selector;
      w = Math.round(box.width);
      h = Math.round(box.height);
      redacted = redact ? await drawRedactions(page, true) : [];
      const buf = await shoot(() => loc.screenshot(SHOT_OPTS));
      if (redact) await clearRedactions(page);
      if (buf) return { jpeg: buf.toString('base64'), w, h, cropped, selector: used, redacted };
      // 局部失败则回退全屏
    }
  }

  // 回退全屏截图：坐标相对整页
  const vp = page.viewportSize() || { width: 1280, height: 900 };
  cropped = false;
  used = undefined;
  w = vp.width;
  h = vp.height;
  redacted = redact ? await drawRedactions(page, true) : [];
  const buf = await shoot(() => page.screenshot(SHOT_OPTS));
  if (redact) await clearRedactions(page);
  if (!buf) return null;

  return { jpeg: buf.toString('base64'), w, h, cropped, selector: used, redacted };
}

/**
 * 在页面里画遮挡层，直接返回遮挡区域列表。
 * 遮挡层用完由 clearRedactions 擦除。
 */
async function drawRedactions(page: Page, add: boolean): Promise<Rect[]> {
  try {
    return await page.evaluate(
      (args: { add: boolean; id: string }) => {
        document.getElementById(args.id)?.remove();
        const layer = document.createElement('div');
        layer.id = args.id;
        layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
        const rects: number[] = [];

        const box = (r: DOMRect) => {
          const d = document.createElement('div');
          d.style.cssText = `position:fixed;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;background:#000;opacity:0.96`;
          layer.appendChild(d);
          rects.push(Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height));
        };

        // 姓名 / 学号 / 昵称条
        // 姓名常是独立文本节点（无学号数字），需覆盖两种形态：
        //   1) 明确含数字学号或提示词的，直接命中
        //   2) 纯中文短文本：只接受"学校名下方 / 头像旁"的姓名条位置特征，
        //      否则会把侧边栏菜单（课程、云盘…）一起误遮
        const nameHit = (t: string) => {
          if (t.length < 2 || t.length > 24) return false;
          if (/^[一-龥A-Za-z\s·]{2,12}\s*\d{4,}$/.test(t)) return true;
          if (/^(欢迎|你好|Hi|Hello|昵称|同学|学号)/.test(t)) return true;
          return false;
        };
        // 找头像/圆形用户图作为姓名条锚点
        const anchorRects: DOMRect[] = [];
        for (const a of Array.from(document.querySelectorAll('img, [class*="avatar" i]'))) {
          const r = a.getBoundingClientRect();
          if (r.width >= 24 && r.width <= 140 && r.height >= 24 && r.height <= 140 && r.width < r.height * 2.5) {
            anchorRects.push(r);
          }
        }
        const nearAnchor = (r: DOMRect) =>
          anchorRects.some(a => !(r.right < a.left - 40 || r.left > a.right + 40 || r.bottom < a.top - 60 || r.top > a.bottom + 60));

        let nameHits = 0;
        for (const el of Array.from(document.querySelectorAll('*'))) {
          if (nameHits >= 4) break;
          if (el.children.length > 0) continue;
          const t = (el.textContent || '').trim();
          if (!t) continue;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0 || r.height > 48) continue;

          if (nameHit(t)) {
            box(r);
            nameHits++;
            continue;
          }
          // 纯中文 2-4 字姓名：必须在头像附近，且不在侧边栏纵向菜单里
          if (/^[一-龥·]{2,4}$/.test(t) && nearAnchor(r) && r.left < 300) {
            box(r);
            nameHits++;
          }
        }

        // 头像 / 用户图片：只遮小尺寸方形图，避免误遮课程封面（课程封面常在正文中央，
        // 这里额外要求位于顶部或侧边），否则局部截图会被大黑块盖住
        for (const a of Array.from(
          document.querySelectorAll('img, [class*="avatar" i], [class*="head" i]')
        ).slice(0, 60)) {
          const r = a.getBoundingClientRect();
          if (r.width < 24 || r.width > 120 || r.height < 24 || r.height > 120) continue;
          if (r.width > r.height * 2.5) continue;
          // 必须靠顶部或贴左边（侧边栏），正文中央的图不动
          if (r.top < 200 || r.left < 240) box(r);
        }

        // 二维码 / 验证码：近似正方形且偏大
        for (const c of Array.from(
          document.querySelectorAll('img, canvas, [class*="qrcode" i], [class*="qr" i]')
        ).slice(0, 60)) {
          const r = c.getBoundingClientRect();
          if (r.width >= 60 && Math.abs(r.width - r.height) < 12) box(r);
        }

        document.body.appendChild(layer);
        const out: { x: number; y: number; width: number; height: number }[] = [];
        for (let i = 0; i < rects.length; i += 4) {
          out.push({ x: rects[i], y: rects[i + 1], width: rects[i + 2], height: rects[i + 3] });
        }
        return out;
      },
      { add, id: REDACT_ID }
    );
  } catch {
    return [];
  }
}

/** 擦除遮挡层 */
async function clearRedactions(page: Page): Promise<void> {
  try {
    await page.evaluate((id: string) => document.getElementById(id)?.remove(), REDACT_ID);
  } catch {}
}