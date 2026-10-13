/**
 * 「扫码弹窗出现后，二维码一直被点击/刷新」—— 真实 DOM 验证。
 *
 * 用户反馈（v2.1.1 真机，2026-10-13 22:26 / 22:28）：
 *   「出现了二维码弹窗，结果二维码一直在点击刷新」
 *
 * 日志上是一条很反直觉的链：
 *   22:26:06 ⚠ 检测到扫码弹窗：人脸信息采集 / 请使用手机APP采集人脸信息后继续学习
 *   22:26:06 已暂停自动操作，处理完成后会自动继续
 *   22:26:32 ✓ 弹窗已处理，恢复自动播放        ← 仅 26 秒后，用户根本来不及扫
 *   22:26:32 ⚠ 页面跳转: antispiderShowVerify.ac → 视频元素消失 → 后面每节都进不去
 *
 * 两个机制性问题，本脚本各自用真实浏览器量一遍：
 *
 * 1) **保活 ticker 不认「人工介入」**。`keepalive.ts` 的 SPY_JS 往每个 frame 里
 *    注入了一个 300ms 定时器，持续派发 mousemove/mouseover/mouseenter 与
 *    focus/focusin。主进程的「暂停」只停掉了主进程那一侧的动作，ticker 照跑。
 *    平台正是按「环境有没有变化」决定刷新二维码的——于是应用嘴上说「已暂停」，
 *    二维码却在被**自己的保活事件**一遍遍刷掉。这里直接数页面收到的合成事件。
 *
 * 2) **「弹层消失一次」被当成「用户处理完了」**。二维码每次重绘都会让弹层短暂
 *    消失，`waitBlockGone` 旧实现单轮查不到就 return true。这里让弹层先短暂
 *    消失 2.2 秒、再真正消失，断言它**不会**被那个短窗口骗到。
 *
 * 用法：tsx scripts/test-manual-block-ticker.ts
 */
import * as http from 'node:http';
import { chromium, type Page } from 'playwright';
import { installPauseSpy, setManualBlock, SPY_JS } from '../src/main/engine/keepalive';
import { detectManualBlock } from '../src/main/engine/blocker';
import { waitBlockGone } from '../src/main/engine/video';
import type { EngineHooks } from '../src/main/engine/hooks';
import type { LogLevel } from '../src/shared/types';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * 弹层里的文案必须是超星风控弹窗那几句之一——blocker 是按**弹层文字**判定的，
 * 纯图片二维码它认不出来（那是另一条待办，不在本轮范围）。
 */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>qr</title>
<style>
  html,body{margin:0;height:100%}
  video{width:400px;height:300px;background:#000}
  #qr{position:fixed;left:0;top:0;width:320px;height:360px;z-index:9999;
      background:#fff;border:1px solid #ccc;font:14px/2 sans-serif;padding:8px}
</style></head><body>
<video id="v"></video>
<div id="qr" class="qrcode-layer">
  <div>扫码登录</div>
  <div>请使用手机扫描二维码进入</div>
  <canvas width="240" height="240" style="width:240px;height:240px;background:#eee"></canvas>
</div>
<script>
// 只数**合成**事件（isTrusted === false）：真实鼠标/键盘一律不计，
// 这样「计数为 0」就一定意味着没有代码在偷偷派发事件。
window.__syn = 0;
(function () {
  var names = ['mousemove', 'mouseover', 'mouseenter', 'focus', 'focusin', 'visibilitychange'];
  [document, window].forEach(function (t) {
    names.forEach(function (n) {
      t.addEventListener(n, function (e) { if (!e.isTrusted) window.__syn++; }, true);
    });
  });
})();
</script>
</body></html>`;

/** 把弹层显示/隐藏（模拟二维码重绘时弹层的短暂消失） */
const setLayer = (page: Page, visible: boolean) =>
  page.evaluate((v: boolean) => {
    const qr = document.getElementById('qr');
    if (qr) qr.style.display = v ? '' : 'none';
  }, visible);

const countSyn = (page: Page) => page.evaluate(() => (window as unknown as { __syn: number }).__syn);
const resetSyn = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { __syn: number }).__syn = 0;
  });
const flag = (page: Page) =>
  page.evaluate(() => (window as unknown as { __kaBlocked?: boolean }).__kaBlocked);

async function main() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await installPauseSpy(page);

    console.log('\n[1. 问题前提：保活 ticker 确实在持续派发合成事件]');
    await resetSyn(page);
    await sleep(1500);
    const base = await countSyn(page);
    check(
      '不设标志时，1.5s 内页面收到多轮合成事件',
      base > 5,
      `实际 ${base} 次（300ms 一轮 × 3 个鼠标事件 + 2 个焦点事件）`
    );

    console.log('\n[2. 人工介入期间必须彻底静默（这是「二维码一直刷新」的正解）]');
    await setManualBlock(page, true);
    check('标志已写进页面', (await flag(page)) === true);
    await resetSyn(page);
    await sleep(2000);
    const blocked = await countSyn(page);
    check(
      '置位后 2s 内合成事件为 0（二维码不再被自己的保活事件刷掉）',
      blocked === 0,
      `实际 ${blocked} 次`
    );

    console.log('\n[3. 解除后必须恢复（不能把视频保活一起废掉）]');
    await setManualBlock(page, false);
    check('标志已清除', (await flag(page)) === false);
    await resetSyn(page);
    await sleep(1500);
    const resumed = await countSyn(page);
    check('解除后合成事件恢复派发', resumed > 5, `实际 ${resumed} 次`);

    console.log('\n[4. 「弹层消失一次」真的会发生（这就是旧实现的坑）]');
    await setLayer(page, true);
    const visible = await detectManualBlock(page);
    await setLayer(page, false);
    const hidden = await detectManualBlock(page);
    await setLayer(page, true);
    check(
      '弹层可见时能认出来',
      !!visible && visible.kind === '扫码',
      `实际 ${visible ? visible.kind + ' / ' + visible.matched.slice(0, 20) : 'null'}`
    );
    check(
      '弹层只要隐藏一瞬就查不到 —— 单轮命中即恢复必然误判',
      hidden === null,
      hidden ? '居然仍能查到，用例前提不成立' : '确认：二维码重绘的窗口里检测结果为 null'
    );

    console.log('\n[5. waitBlockGone 必须扛过「短暂消失」]');
    const logs: string[] = [];
    const hooks = {
      ctl: { sleep: (ms: number) => sleep(ms) },
      log: (_l: LogLevel, m: string) => {
        logs.push(m);
      },
      autoPauseOnVerify: () => false,
    } as unknown as EngineHooks;

    // 时间线（相对 t0，waitBlockGone 内部每 2s 轮询一次）
    //   t0      : 弹层可见
    //   t0+1.6s : 弹层消失 2.2s   ← 模拟二维码重绘。旧实现会在这里 return true
    //   t0+3.8s : 弹层恢复可见
    //   t0+6.0s : 弹层永久消失    ← 模拟用户真的扫完了
    await page.evaluate(() => {
      const qr = document.getElementById('qr');
      if (!qr) return;
      qr.style.display = '';
      setTimeout(() => {
        qr.style.display = 'none';
      }, 1600);
      setTimeout(() => {
        qr.style.display = '';
      }, 3800);
      setTimeout(() => {
        qr.style.display = 'none';
      }, 6000);
    });
    const t0 = Date.now();
    const gone = await waitBlockGone(page, hooks, 30000);
    const elapsed = Date.now() - t0;
    check('最终判定为「已处理」', gone === true, `日志 ${JSON.stringify(logs.slice(-2))}`);
    check(
      '没有被 t0+1.6s 那个 2.2s 的短窗口骗到（要 6s 之后才认）',
      elapsed >= 6000,
      `实际 ${elapsed}ms；旧实现会在约 2000ms 就返回 true`
    );
    check('也不会一直等下去', elapsed < 25000, `实际 ${elapsed}ms`);
    check(
      '恢复时把保活标志交还（否则视频保活被永久废掉）',
      (await flag(page)) === false,
      `实际 __kaBlocked=${String(await flag(page))}`
    );
    console.log('\n[6. 反向对照：把守卫摘掉，第 2 步必须失败]');
    // 一个不会失败的测试等于没有测试。这里用「把 SPY_JS 里的守卫删掉再注入」
    // 造一个**旧实现**的样本，证明第 2 步量到的 0 次确实来自那道守卫，
    // 而不是因为计数本身就不工作 / ticker 压根没跑起来。
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    const unguarded = SPY_JS.replace('if (window.__kaBlocked) return;', '');
    if (unguarded === SPY_JS) throw new Error('SPY_JS 里没找到守卫，对照样本无效');
    await page.evaluate(unguarded);
    await setManualBlock(page, true);
    check('对照样本的标志确实置上了', (await flag(page)) === true);
    await resetSyn(page);
    await sleep(2000);
    const leaked = await countSyn(page);
    check(
      '没有守卫时，置位也拦不住事件 → 反证第 2 步测的是真东西',
      leaked > 5,
      `实际 ${leaked} 次（旧实现就是这个形态：日志说「已暂停」，页面仍被持续派发）`
    );
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  if (fail) process.exit(1);
}

main().catch(e => {
  console.error('运行异常:', e);
  process.exit(1);
});
