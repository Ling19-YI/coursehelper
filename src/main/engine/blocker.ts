/** 人工介入检测：扫码、验证码、人脸等弹窗 */
import type { Page, Frame } from 'playwright';

/** 需要人工处理的弹窗特征 */
export type BlockKind =
  | '扫码'        // 手机扫码
  | '验证码'      // 图形/短信验证码
  | '人脸识别'
  | '安全验证'
  | '弹窗';

/**
 * 「验证类」弹窗：人脸识别 / 验证码 / 安全验证。
 *
 * 这三类的识别误判代价太高——课程正文本身就含这些词（人工智能课的图文
 * 任务点正文里就有「人脸识别」），误判一次整轮刷课就停摆在等人。
 * 因此由设置项 autoPauseOnVerify 控制，**默认不因它们暂停**。
 *
 * 扫码不在其列，始终暂停：引擎一旦继续动作，二维码会被平台判定为环境变化
 * 而反复刷新，用户永远扫不上。
 */
const VERIFY_KINDS: BlockKind[] = ['人脸识别', '验证码', '安全验证'];

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

// 关键词表在下面两处 evaluate 里各自内联一份——RegExp 不能跨进程边界传进
// page.evaluate，所以没法抽成共享常量。改关键词时两处都要动。

/** 在单个 frame 内检测 */
async function detectInFrame(frame: Frame, allowVerify: boolean): Promise<BlockInfo | null> {
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
      info = await frame.evaluate((args: { selector: string; allowVerify: boolean; verifyKinds: string[] }) => {
        // 字符串数组可以过序列化边界，所以 verifyKinds 由调用方传入；
        // 但 RegExp 不行，关键词表只能写在函数体内。
        const kw = [
          { re: /扫码|扫描二维码|手机.{0,4}确认|微信扫一扫/, k: '扫码', h: '需要手机扫码确认，请在软件里完成扫码后再继续' },
          { re: /验证码|短信验证|图形验证|拖动滑块|请输入.{0,6}码/, k: '验证码', h: '需要输入验证码，请手动完成后继续' },
          { re: /人脸|活体|面部识别/, k: '人脸识别', h: '需要人脸识别，请手动完成' },
          { re: /安全验证|身份验证|重新验证/, k: '安全验证', h: '触发平台安全验证，请手动完成' },
        ];
        for (const el of Array.from(document.querySelectorAll(args.selector))) {
          const r = el.getBoundingClientRect();
          if (r.width < 80 || r.height < 60) continue;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
          const txt = ((el as HTMLElement).innerText || el.textContent || '').trim();
          // 有文字的弹层才需要人介入；纯遮罩不算
          if (!txt || txt.length < 4) continue;
          for (const x of kw) {
            if (!args.allowVerify && args.verifyKinds.indexOf(x.k) >= 0) continue;
            if (x.re.test(txt)) return { kind: x.k, matched: txt.slice(0, 40), hint: x.h };
          }
        }
        return null;
      }, { selector: sel, allowVerify, verifyKinds: VERIFY_KINDS });
    } catch {
      info = null;
    }
    if (info) return { kind: info.kind as BlockKind, matched: info.matched, hint: info.hint };
  }

// 2) 弹层没命中时，扫描「看起来像覆盖层」的元素。
  //
  // ⚠️ 这里**不能扫整页 innerText**。
  // 旧实现读 document.body.innerText 做全文匹配，只摘掉了随堂弹题节点。
  // 但课程正文本身就可能含这些词——人工智能课 1.4 节图文任务点的正文里
  // 就有「人脸识别」。扫全文必然把它当成平台弹窗，引擎随即停掉一切模拟动作
  // 等人工介入，于是整门课（乃至换课后）全部卡死。用户看到的是
  // 「不知道为什么会判断出人脸识别弹窗」。
  //
  // 判据改成三条同时成立，误判窗口极小：
  //   · position 为 fixed / absolute —— 弹层脱离文档流，正文是 static
  //   · 带 z-index —— 覆盖层要压在内容上
  //   · 文案短 —— 弹层就一句话；正文段落长得多
  //
  // ⚠️ 用真实 body 的 innerText 语义，不要 cloneNode：游离节点不参与布局，
  // Chromium 下 innerText 会退化成 textContent，隐藏弹窗模板的文字全被算进来
  // （实测 715 字 → 99987 字）。曾经用 clone 版修过一次，直接把视频章节
  // 判成扫码弹窗，引擎死等 3 分钟。
  //
  // ⚠️⚠️ evaluate 的函数体里**绝不能定义具名函数**。
  // 函数会被序列化成字符串发到浏览器执行，而 tsx/esbuild 会给具名函数注入
  // __name(...) 调用，浏览器侧没有这个符号：
  //   ReferenceError: __name is not defined
  // 曾经因为写了个 const isVisible = (el) => {...}，导致整个兜底检测每帧抛错、
  // 被 catch 吞掉，真实弹窗一个都认不出来（而且日志里毫无痕迹）。
  // 判据一律内联展开。
  try {
    const hit = await frame.evaluate((args: { quizSel: string; allowVerify: boolean; verifyKinds: string[] }) => {
      const quizSel = args.quizSel;
      const kw = [
        { re: /扫码|扫描二维码|手机.{0,4}确认|微信扫一扫/, k: '扫码', h: '需要手机扫码确认，请在软件里完成扫码后再继续' },
        { re: /验证码|短信验证|图形验证|拖动滑块|请输入.{0,6}码/, k: '验证码', h: '需要输入验证码，请手动完成后继续' },
        { re: /人脸|活体|面部识别/, k: '人脸识别', h: '需要人脸识别，请手动完成' },
        { re: /安全验证|身份验证|重新验证/, k: '安全验证', h: '触发平台安全验证，请手动完成' },
      ];

      for (const el of Array.from(document.querySelectorAll('div,section,aside,form,dialog'))) {
        // 随堂弹题不是平台风控，跳过
        if (el.matches(quizSel) || el.querySelector(quizSel)) continue;

        // 可见且有尺寸（内联，勿抽函数——见上方 __name 的说明）
        const cs0 = getComputedStyle(el);
        if (cs0.display === 'none' || cs0.visibility === 'hidden') continue;
        if (Number(cs0.opacity) === 0) continue;
        const box = el.getBoundingClientRect();
        if (box.width < 120 || box.height < 50) continue;

        // 弹层脱离文档流：正文是 static
        const pos = cs0.position;
        if (pos !== 'fixed' && pos !== 'absolute') continue;

        // 覆盖层要压在内容上
        const z = Number(cs0.zIndex);
        if (!Number.isFinite(z) || z <= 0) continue;

        // 弹层文案短；长文本是正文，不是弹窗
        const txt = ((el as HTMLElement).innerText || '').trim();
        if (!txt || txt.length > 120) continue;

        for (const x of kw) {
          if (!args.allowVerify && args.verifyKinds.indexOf(x.k) >= 0) continue;
          if (x.re.test(txt)) return { kind: x.k, matched: txt.slice(0, 40), hint: x.h };
        }
      }
      return null;
    }, { quizSel: '.ans-videoquiz, #videoquiz-submit', allowVerify, verifyKinds: VERIFY_KINDS });
    if (hit) {
      return { kind: hit.kind as BlockKind, matched: hit.matched, hint: hit.hint };
    }
  } catch {}

  return null;
}

/**
 * 检测当前页面是否被「需要人工处理」的弹窗挡住。
 *
 * 场景：某些课程播放中会弹出手机扫码、验证码、人脸识别。
 * 命中时引擎必须停止一切模拟动作（鼠标移动、事件派发、点击播放按钮），
 * 否则二维码会被判定为环境变化而反复刷新，用户永远扫不上。
 *
 * @param allowVerify 是否也因「验证类」（人脸识别/验证码/安全验证）暂停。
 *   默认 false——这三类的误判代价太高，课程正文就含这些词，
 *   误判一次整轮刷课就停摆在等人。由设置项 autoPauseOnVerify 控制。
 *   扫码不受此开关影响，始终暂停。
 */
export async function detectManualBlock(
  page: Page,
  allowVerify = false
): Promise<BlockInfo | null> {
  for (const frame of page.frames()) {
    const info = await detectInFrame(frame, allowVerify);
    if (info) return info;
  }
  return null;
}

/** 供日志使用的一句话摘要 */
export function describeBlock(b: BlockInfo | null): string {
  if (!b) return '';
  return `${b.kind}（${b.matched}）`;
}