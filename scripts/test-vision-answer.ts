/**
 * 截图识题链路的单元验证。
 *
 * 只测两件纯函数的事，因为它们是「乱答」的最后一道闸：
 *   1. parseAnswers —— 模型输出容错。真实网关会带 markdown 围栏、会多嘴
 *      说明文字、会漏字段，解不出来就不能凭空造答案。
 *   2. validate —— 答案必须落在该题选项范围内。模型给出 C 但这题只有
 *      A/B/D 时，整题丢弃比硬塞一个字母安全得多（错的答案会留在平台上）。
 *
 * npx tsx scripts/test-vision-answer.ts
 */
import { parseAnswers, validate, extractText } from '../src/main/engine/visionSearcher';
import type { QuizQuestion } from '../src/main/engine/quizTypes';

let failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
}
function ok(label: string, cond: boolean) {
  if (!cond) failed++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}`);
}

const q = (labels: string[]): QuizQuestion => ({
  index: 1,
  stem: '',
  type: 'single',
  options: labels.map((l, i) => ({ label: l, text: `opt${i}` })),
  hasInput: false,
  encrypted: true,
});

console.log('\n=== parseAnswers ===');
eq(
  '标准 JSON',
  [...parseAnswers('{"answers":[{"id":1,"choices":["C"]}]}')],
  [[1, 'C']]
);
eq(
  'markdown 围栏',
  [...parseAnswers('```json\n{"answers":[{"id":2,"choices":["A","B"]}]}\n```')],
  [[2, 'AB']]
);
eq(
  '前后有多余说明文字',
  [...parseAnswers('好的，我来回答：{"answers":[{"id":3,"choices":["D"]}]} 以上。')],
  [[3, 'D']]
);
eq(
  'choices 是字符串不是数组',
  [...parseAnswers('{"answers":[{"id":4,"choices":"B"}]}')],
  [[4, 'B']]
);
eq(
  '小写字母归一为大写',
  [...parseAnswers('{"answers":[{"id":5,"choices":["c"]}]}')],
  [[5, 'C']]
);
eq('不是 JSON 时返回空', [...parseAnswers('我拒绝回答')], []);
eq('空 choices 时返回空', [...parseAnswers('{"answers":[{"id":6,"choices":[]}]}')], []);
eq('id 不是数字时跳过', [...parseAnswers('{"answers":[{"id":"x","choices":["A"]}]}')], []);
eq('空字符串', [...parseAnswers('')], []);

console.log('\n=== validate（答案必须落在选项内）===');
ok('单选 C 在 A~D 内 → 通过', validate('C', q(['A', 'B', 'C', 'D'])));
ok('小写 c 也通过', validate('c', q(['A', 'B', 'C', 'D'])));
ok('多选 AB 在范围内 → 通过', validate('AB', q(['A', 'B', 'C', 'D'])));
ok('模型编了 E，题目没有 E → 丢弃', !validate('E', q(['A', 'B', 'C', 'D'])));
ok('部分越界（AE）→ 整题丢弃，不做部分采纳', !validate('AE', q(['A', 'B', 'C', 'D'])));
ok('空答案 → 丢弃', !validate('', q(['A', 'B', 'C', 'D'])));
ok('判断题选项标签是「对/错」时，模型答 A → 丢弃', !validate('A', q(['对', '错'])));
ok('判断题选项标签是「对/错」时，模型答 对 → 通过', validate('对', q(['对', '错'])));
ok('无选项的题一律丢弃（无从校验）', !validate('A', q([])));

console.log('\n=== extractText（兼容各家 OpenAI 兼容实现的响应差异）===');
const J = '{"answers":[{"id":1,"choices":["C"]}]}';
eq('content 是标准字符串', extractText({ choices: [{ message: { content: J } }] }), J);
eq(
  'content 是分段数组（部分网关/推理模型）',
  extractText({ choices: [{ message: { content: [{ type: 'text', text: J }] } }] }),
  J
);
eq(
  '数组里混有非文本段',
  extractText({ choices: [{ message: { content: [{ type: 'image' }, { type: 'text', text: 'AB' }] } }] }),
  'AB'
);
eq('content 为 null', extractText({ choices: [{ message: { content: null } }] }), '');
eq('choices 缺失', extractText({}), '');
eq('content 是裸字符串数组', extractText({ choices: [{ message: { content: ['x', 'y'] } }] }), 'xy');

console.log('\n=== 端到端：分段数组响应也必须能取出答案 ===');
eq(
  '数组形态的 content 走完 parseAnswers',
  [...parseAnswers(extractText({ choices: [{ message: { content: [{ type: 'text', text: J }] } }] }))],
  [[1, 'C']]
);

console.log(failed ? `\nFAIL: ${failed} 项未通过` : '\nPASS: 截图识题答案校验验证通过');
if (failed) process.exit(1);