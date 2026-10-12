/**
 * 回归测试：所有在 page.evaluate 里跑的逻辑都要能真的执行。
 *
 * 起因：修「人工智能课正文含人脸识别被误判成风控弹窗」时踩了一个隐蔽的坑。
 * tsx/esbuild 会给具名函数注入 __name(...) 辅助调用，而 evaluate 是把函数
 * **序列化成字符串**发到浏览器执行的，浏览器侧没有 __name：
 *
 *   ReferenceError: __name is not defined
 *
 * 更糟的是外层 catch {} 会把它吞掉——表现为「检测功能整体失效」，
 * 日志里毫无痕迹，极难定位。所以凡是 evaluate 里的函数体，都不能定义
 * 具名函数/具名箭头函数，一律内联。
 *
 * 本测试对每个用到 evaluate 的入口都用最小 DOM 跑一遍，
 * 一旦有人以后又写进具名函数，这里会立刻红。
 *
 * 无需登录，跑得很快。用法：tsx scripts/test-evaluate-safety.ts
 */

import { chromium } from 'playwright';
import { detectManualBlock } from '../src/main/engine/blocker';
import {
  readUnfinishedCount,
  detectDailyLimit,
  gotoUnfinishedJob,
} from '../src/main/engine/video';
import { TaskControl } from '../src/main/engine/control';
import { handleDocument } from '../src/main/engine/document';
import type { EngineHooks } from '../src/main/engine/hooks';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function makeHooks(): EngineHooks {
  const ctl = new TaskControl();
  ctl.reset();
  return {
    ctl,
    log: () => {},
    onTick: () => {},
    diag: async () => null,
    speed: () => 1,
    muted: () => true,
    agentEnabled: () => false,
    vision: () => ({ baseUrl: '', apiKey: '', model: '' }),
    answerPopup: () => false,
    autoPauseOnVerify: () => false,
    visionChannel: () => null,
    deepseekKey: () => '',
    tiku: () => null,
    submitCoverRate: () => 0.8,
  };
}

async function withPage<T>(html: string, fn: (page: any) => Promise<T>): Promise<T> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await page.setContent(`<!DOCTYPE html><html><body style="margin:0">${html}</body></html>`, {
      waitUntil: 'load',
    });
    return await fn(page);
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log('\n[blocker：正文不得误判]');

  const article = await withPage(
    `<div style="padding:40px"><h1>1.4 人工智能的研究</h1>
       <p>本节讲自然语言处理、<strong>人脸识别</strong>、语音识别与知识图谱。</p></div>`,
    p => detectManualBlock(p)
  );
  check('正文含「人脸识别」不误判', article === null, `实际 ${article?.kind ?? 'null'}`);

  const quiz = await withPage(
    `<div class="ans-videoquiz" style="position:fixed;left:50%;top:40%;width:400px;height:200px;
         z-index:9999;background:#fff;padding:40px">以下关于人脸识别的选项哪个正确？</div>`,
    p => detectManualBlock(p)
  );
  check('随堂弹题不误判为风控', quiz === null, `实际 ${quiz?.kind ?? 'null'}`);

  console.log('\n[验证类默认不暂停（autoPauseOnVerify 默认 false）]');

  const faceOverlay =
    `<div style="position:fixed;left:50%;top:40%;width:360px;height:160px;z-index:9999;
                 background:#fff;padding-top:50px">请完成人脸识别以继续学习</div>`;
  const faceDefault = await withPage(faceOverlay, p => detectManualBlock(p));
  check('默认：人脸识别弹窗不阻塞', faceDefault === null, `实际 ${faceDefault?.kind ?? 'null'}`);

  const faceOn = await withPage(faceOverlay, p => detectManualBlock(p, true));
  check('开启后：人脸识别弹窗阻塞', faceOn?.kind === '人脸识别', `实际 ${faceOn?.kind ?? 'null'}`);

  const codeOverlay =
    `<div style="position:absolute;left:50px;top:50px;width:340px;height:220px;z-index:2000;
                 background:#fff;padding:60px 20px">请输入图片中的验证码</div>`;
  const codeDefault = await withPage(codeOverlay, p => detectManualBlock(p));
  check('默认：验证码弹窗不阻塞', codeDefault === null, `实际 ${codeDefault?.kind ?? 'null'}`);

  const codeOn = await withPage(codeOverlay, p => detectManualBlock(p, true));
  check('开启后：验证码弹窗阻塞', codeOn?.kind === '验证码', `实际 ${codeOn?.kind ?? 'null'}`);

  console.log('\n[扫码不受开关影响：始终阻塞]');

  const scanOverlay =
    `<div style="position:fixed;left:50%;top:30%;width:340px;height:220px;z-index:2000;
                 background:#fff;padding:60px 20px">请使用手机扫码确认身份</div>`;
  const scanDefault = await withPage(scanOverlay, p => detectManualBlock(p));
  check('默认（关闭验证类）：扫码仍阻塞', scanDefault?.kind === '扫码', `实际 ${scanDefault?.kind ?? 'null'}`);

  const scanOn = await withPage(scanOverlay, p => detectManualBlock(p, true));
  check('开启后：扫码仍阻塞', scanOn?.kind === '扫码', `实际 ${scanOn?.kind ?? 'null'}`);

  console.log('\n[video.ts 的三个 evaluate 入口]');

  const cnt = await withPage(
    `<input type="hidden" class="jobUnfinishCount" value="2">
     <input type="hidden" class="jobUnfinishCount" value="1">`,
    p => readUnfinishedCount(p)
  );
  check('readUnfinishedCount 能读到值', cnt === 2, `实际 ${cnt}`);

  const cntNone = await withPage(`<div>无计数元素</div>`, p => readUnfinishedCount(p));
  check('无计数元素时返回 null（不是 0）', cntNone === null, `实际 ${cntNone}`);

  const limit = await withPage(
    `<div class="jobLimitTip" style="display:block">今日视频任务点完成数已达上限，您可以观看视频，但无法完成任务点</div>`,
    p => detectDailyLimit(p)
  );
  check('detectDailyLimit 识别当日上限', limit === true, `实际 ${limit}`);

  const limitHidden = await withPage(
    `<div class="jobLimitTip" style="display:none">今日视频任务点完成数已达上限</div>`,
    p => detectDailyLimit(p)
  );
  check('隐藏的上限提示不算命中', limitHidden === false, `实际 ${limitHidden}`);

  const jump = await withPage(
    `<script>window.scroll2Job = function(){ window.__jumped = 1; };</script>`,
    async p => ({ ok: await gotoUnfinishedJob(p), jumped: await p.evaluate(() => (window as any).__jumped) })
  );
  check('gotoUnfinishedJob 调到 scroll2Job', jump.ok === true && jump.jumped === 1, JSON.stringify(jump));

  const jumpNone = await withPage(`<div>没有 scroll2Job</div>`, p => gotoUnfinishedJob(p));
  check('无 scroll2Job 时返回 false', jumpNone === false, `实际 ${jumpNone}`);

  console.log('\n[document.ts 的探测]');

  const docScroll = await withPage(
    `<div style="height:400px;overflow-y:scroll"><div style="height:3000px">长内容</div></div>`,
    p => handleDocument(p, makeHooks())
  );
  check('可滚动文档返回 scrolled', docScroll === 'scrolled', `实际 ${docScroll}`);

  const docNone = await withPage(`<div style="height:200px">没有可滚动内容，也没有大图</div>`, p =>
    handleDocument(p, makeHooks())
  );
  check('无可滚动内容返回 unsupported', docNone === 'unsupported', `实际 ${docNone}`);

  const docImg = await withPage(
    `<img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1200' height='900'/%3E"
          style="width:1200px;height:900px">`,
    p => handleDocument(p, makeHooks())
  );
  check('大图（拖拽型）也返回 scrolled', docImg === 'scrolled', `实际 ${docImg}`);

  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('测试异常：', e);
  process.exit(1);
});
