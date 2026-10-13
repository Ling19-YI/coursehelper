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

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);