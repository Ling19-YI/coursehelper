/**
 * 随堂弹题逻辑的静态结构断言。
 *
 * 背景：三个问题都是「代码写得通、逻辑却不对」，且不会抛异常，
 * 只能靠源码结构断言守住：
 *   1. `popupHandledThisVideo` 声明在 while 循环体内 → 每轮重置为false，
 *      「每个视频只处理一次」的意图失效
 *   2. hooks 里的 visionChannel() 指向 answerChannel()（会回退纯文本 DeepSeek），
 *      而不是多模态专用通道
 *   3. answerPopup 默认关闭，需要用户手动打开
 */
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const root = new URL('../src/main/engine/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, root), 'utf8');

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
};

const video = read('video.ts');
const index = read('index.ts');
const types = read('../../shared/types.ts');

// ---- 1. popupHandledThisVideo 必须提到循环体外 ----
const whileIdx = video.indexOf('while (true) {');
const declIdx = video.indexOf('let popupSeen = 0');
check(
  '弹题计数变量声明在 while 循环之前',
  declIdx > 0 && declIdx < whileIdx,
  declIdx > whileIdx ? '声明位于循环体内，每轮重置 → 次数上限失效' : '未找到声明'
);
check(
  '有每视频次数上限常量',
  /VIDEO_POPUP_MAX_PER_VIDEO\s*=\s*\d+/.test(video),
  '缺少上限，防死循环'
);
check(
  '计数变量在循环外声明且不被内层重置',
  (video.match(/popupSeen\s*=\s*0/g) || []).length === 1,
  '循环体内出现重置，上限会被清零'
);
check(
  '异常时封顶而非无限重试',
  /catch[\s\S]{0,300}popupSeen\s*=\s*VIDEO_POPUP_MAX_PER_VIDEO/.test(video),
  '处理链路异常后应停止继续尝试'
);

// ---- 2. hooks.visionChannel 不能指向 answerChannel ----
const hooksBlock = index.slice(index.indexOf('answerPopup:'), index.indexOf('answerPopup:') + 220);
check(
  '随堂题不走会回退纯文本模型的通道',
  /visionChannel:\s*\(\)\s*=>\s*this\.visionChannel\(\)/.test(index),
  'hooks.visionChannel 指向 answerChannel()，没配多模态会回退 DeepSeek 纯文本'
);
check(
  '存在多模态专用通道 visionChannel()',
  /private visionChannel\(\)/.test(index),
  '未找到 visionChannel()'
);

// ---- 3. 默认关闭需在类型定义中声明 ----
check('answerPopup 默认 false', /answerPopup:\s*false/.test(types));
check('存在总开关 agentEnabled 门控', /agentEnabled:\s*\(\)\s*=>/.test(index));

// ---- 4. 弹窗收尾：两种走向都要能退场 ----
//
// 用户实测（2026-10-20，人工智能基础）：
//   · 2.2 章节测验：答对后底部出现绿色「恭喜你，答对了！」+ 蓝色「继续学习」，
//     不点它弹窗就一直盖着页面，引擎后续点击全被挡住 → 「答完了却不动」
//   · 同门课另一些弹窗答完自动收起，不需要点
// 旧实现只认 #videoquiz-continue 一个 id，另一种皮肤完全处理不到。
const vq = read('videoQuiz.ts');
const quiz = read('quiz.ts');

check(
  '「继续学习」在文案表里（不只认 #videoquiz-continue）',
  /继续学习/.test(vq),
  '只按 id 匹配，遇到另一种弹窗皮肤就漏判'
);
check(
  '继续按钮候选是id 列表，含旧的 #videoquiz-continue',
  /CONTINUE_IDS[\s\S]{0,300}#videoquiz-continue/.test(vq),
  '缺少多 id 兜底'
);
check(
  '存在统一收尾函数 settlePopup',
  /export async function settlePopup/.test(vq),
  '弹窗收尾没有统一入口，随堂弹题与交卷后各写一套'
);
check(
  'settlePopup 先等平台自动收起再找按钮',
  /autoWaitMs/.test(vq) && /clickContinueIfPresent/.test(vq),
  '必须两条路都走：自动收 + 手动点'
);
check(
  '随堂弹题答题末尾调用了收尾',
  /settlePopup\(page,\s*h,\s*\{\s*reason:/.test(vq),
  '答完没收尾，弹窗残留'
);
check(
  '章节测验交卷后也调用了收尾',
  /settlePopup\(page,\s*h,\s*\{/.test(quiz),
  '交卷后弹层残留会挡住页面'
);
check(
  '继续按钮只在可见浮层内找（防误点正文）',
  /OVERLAY_SEL/.test(vq) && /position !== 'fixed'/.test(vq),
  '放开限定会点到课程正文里的「继续」字样'
);
check(
  '继续按钮要求文本短（长句是正文不是按钮）',
  /t\.length > 8/.test(vq),
  '缺少长度约束'
);
check(
  '没点成也不算成功：点完要复检弹层是否真退了',
  /可能需要人工确认|点了.*仍在/.test(vq),
  '点到按钮≠ 弹窗收起，必须复检'
);

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);