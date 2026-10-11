/** 人工介入检测：扫码、验证码、人脸等弹窗 */
import type { Page, Frame } from 'playwright';

/** 需要人工处理的弹窗特征 */
export type BlockKind =
  | '扫码'        // 手机扫码
  | '验证码'      // 图形/短信验证码
  | '人脸识别'
  | '安全验证'
  | '弹窗';

interface BlockInfo {
  kind: BlockKind;
  /** 命中的选择器或文本片段 */
  matched: string;
  /** 建议提示用户做什么 */
  hint: string;
}

/** 弹窗容器选择器 */
const LAYER_SELECTORS = [
  '.layui-layer',
  '.layui-mask',
  '.maskDiv',
  '.popDiv',
  '.markPopup',
  '.qrcode-layer',
  '[class*="scanCode"]',
  '[class*="qrcode"]',
  '[class*="verify"]',
  '[class*="captcha"]',
  '[class*="dialog"]',
  '.modal',
  '.ant-modal',
  '.el-dialog',
];

/** 关键词 → 类型与提示 */
const KEYWORDS: Array<{ re: RegExp; kind: BlockKind; hint: string }> = [
  { re: /扫码|扫描二维码|手机.{0,4}确认|微信扫一扫|学号扫码/, kind: '扫码',
    hint: '需要手机扫码确认，请在软件里完成扫码后再继续' },
  { re: /验证码|短信验证|图形验证|拖动滑块|请输入.{0,6}码/, kind: '验证码',
    hint: '需要输入验证码，请手动完成后继续' },
  { re: /人脸|活体|面部识别/, kind: '人脸识别',
    hint: '需要人脸识别，请手动完成' },
  { re: /安全验证|身份验证|重新验证|风险/, kind: '安全验证',
    hint: '触发平台安全验证，请手动完成' },
];

/** 在单个 frame 内检测 */
async function detectInFrame(frame: Frame): Promise<BlockInfo | null> {
  // 1) 先看可见的弹层容器
  for (const sel of LAYER_SELECTORS) {
    let n = 0;
    try {
      n = await frame.locator(sel).count();
    } catch {
      continue;
    }
    if (!n) continue;

    let info: { kind: string; matched: string; hint: string } | null = null;
    try {
      // 只检查「可见」的弹层，隐藏的模板不算
      info = await frame.evaluate((selector) => {
        const kw = [
          { re: /扫码|扫描二维码|手机.{0,4}确认|微信扫一扫/, k: '扫码', h: '需要手机扫码确认，请在软件里完成扫码后再继续' },
          { re: /验证码|短信验证|图形验证|拖动滑块|请输入.{0,6}码/, k: '验证码', h: '需要输入验证码，请手动完成后继续' },
          { re: /人脸|活体|面部识别/, k: '人脸识别', h: '需要人脸识别，请手动完成' },
          { re: /安全验证|身份验证|重新验证|风险/, k: '安全验证', h: '触发平台安全验证，请手动完成' },
        ];
        for (const el of Array.from(document.querySelectorAll(selector))) {
          const r = el.getBoundingClientRect();
          if (r.width < 80 || r.height < 60) continue;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
          const txt = ((el as HTMLElement).innerText || el.textContent || '').trim();
          // 有文字的弹层才需要人介入；纯遮罩不算
          if (!txt || txt.length < 4) continue;
          for (const x of kw) {
            if (x.re.test(txt)) return { kind: x.k, matched: txt.slice(0, 40), hint: x.h };
          }
        }
        return null;
      }, sel);
    } catch {
      info = null;
    }
    if (info) return { kind: info.kind as BlockKind, matched: info.matched, hint: info.hint };
  }

// 2) 弹层没命中时，退化为全页文本关键词匹配（限流类弹窗常没有标准 class）
  //
  // 必须剔除随堂弹题的文本：题干本身就是页面 DOM 的一部分，「风险」「验证码」
  // 「人脸」在风险管理、计算机安全这类课程的题目里是普通词汇。混进去会被当成
  // 平台安全验证，引擎进入等待人工介入的死循环，弹题再也答不到，还会骗用户
  // 去扫码找根本不存在的验证框。
  //
  // ⚠️ 这里**必须用真实 body.innerText，不能 cloneNode**。游离节点不参与布局，
  // Chromium 下 innerText 退化成 textContent，隐藏弹窗模板的文字全被算进来：
  //   真实 body.innerText =    715 字，不命中
  //   clone.innerText     =  99987 字，命中「扫码」
  // 曾用 clone 版修过一次，直接把这个视频章节判成扫码弹窗，引擎死等 3 分钟。
  //
  // 另外别试图用 TreeWalker + getComputedStyle 手工复刻 innerText 的可见性
  // 语义 —— innerText 还会按布局盒模型排除零尺寸元素，手工复刻不准（实测
  // 手工版 13825 字，仍误命中「扫码」）。正确做法是就地移除再恢复：
  // 在真实 body 上短暂摘掉弹题节点，读一次 innerText，再放回去。
  try {
    const taken = await frame.evaluate((quizSel: string) => {
      const removed: Array<{ el: Element; next: Node | null }> = [];
      document.querySelectorAll(quizSel).forEach(el => {
        const parent = el.parentNode;
        if (!parent) return;
        removed.push({ el, next: el.nextSibling });
        parent.removeChild(el);
      });
      const txt = document.body?.innerText || '';
      // 立刻放回去，别让 DOM 处于被改动过的状态（后续定位要靠真实节点）
      for (const r of removed) r.el.parentNode?.appendChild(r.el);
      return txt;
    }, '.ans-videoquiz, #videoquiz-submit');
    for (const k of KEYWORDS) {
      if (k.re.test(taken)) {
        return { kind: k.kind, matched: (taken.match(k.re) || [''])[0], hint: k.hint };
      }
    }
  } catch {}

  return null;
}

/**
 * 检测当前页面是否被「需要人工处理」的弹窗挡住。
 *
 * 场景：某些课程播放中会弹出手机扫码、验证码、人脸识别。
 * 此时引擎必须停止一切模拟动作（鼠标移动、事件派发、点击播放按钮），
 * 否则二维码会被判定为环境变化而反复刷新，用户永远扫不上。
 */
export async function detectManualBlock(page: Page): Promise<BlockInfo | null> {
  for (const frame of page.frames()) {
    const info = await detectInFrame(frame);
    if (info) return info;
  }
  return null;
}

/** 供日志使用的一句话摘要 */
export function describeBlock(b: BlockInfo | null): string {
  if (!b) return '';
  return `${b.kind}（${b.matched}）`;
}