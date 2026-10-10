/**
 * 答案链与题库沉淀的单元验证。
 *
 * 覆盖三件容易静默出错、又直接影响交卷质量的事：
 *   1. 题干归一化 —— 跨课程命中率全靠它，剥不干净就等于没有缓存
 *   2. Searcher 链的优先级与降级 —— 本地命中后不该再打 AI
 *   3. AI 搜题器必须把「?」当「答不出来」，不能当成答案记下来
 *
 *   npx tsx scripts/test-answer-chain.ts
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { TikuStore, normalizeStem } from '../src/main/engine/tiku';
import { CacheSearcher, resolveAnswers } from '../src/main/engine/searcher';
import type { QuizQuestion } from '../src/main/engine/quizTypes';

let failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
}

// ── 1. 题干归一化 ───────────────────────────────────────────────
console.log('\n=== 题干归一化 ===');
eq('去题号 "1."', normalizeStem('1. 人体的体温调节中枢位于？'), normalizeStem('人体的体温调节中枢位于？'));
eq('去题号 "12、"', normalizeStem('12、人体的体温调节中枢位于？'), normalizeStem('人体的体温调节中枢位于？'));
eq('去全角题号', normalizeStem('（3）人体的体温调节中枢位于？'), normalizeStem('人体的体温调节中枢位于？'));
eq(
  '去分值',
  normalizeStem('人体的体温调节中枢位于？(2分)'),
  normalizeStem('人体的体温调节中枢位于？')
);
eq(
  '去分值+空格+括号',
  normalizeStem('人体的体温调节中枢位于？ 【 5 分 】'),
  normalizeStem('人体的体温调节中枢位于？')
);
eq('英文大小写不敏感', normalizeStem('Which is True?'), normalizeStem('which is true'));
eq('题干+分值+题号全组合仍一致', normalizeStem('12、人体的体温调节中枢位于？(2分)'), normalizeStem('人体的体温调节中枢位于？'));

// ── 2. TikuStore 落盘与命中 ─────────────────────────────────────
console.log('\n=== 题库沉淀 ===');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiku-'));
const file = path.join(dir, 'tiku.json');
const store = new TikuStore(file);

store.put('1. 人体的体温调节中枢位于？(2分)', 'A');
store.put('下列关于细胞周期的说法正确的是', 'BC');
store.flush();

eq('size=2', store.size(), 2);
eq('换个题号/分值仍命中', store.get('12、人体的体温调节中枢位于？'), 'A');
eq('完全不同的题干不命中', store.get('今天天气怎么样'), null);
eq('落盘文件存在', fs.existsSync(file), true);

// 重新打开应能读到（进程重启场景）
const reopened = new TikuStore(file);
eq('重开后命中', reopened.get('人体的体温调节中枢位于？'), 'A');
eq('空题干不写入', (() => { reopened.put('', 'X'); return reopened.size(); })(), 2);
eq('空答案不写入', (() => { reopened.put('某题', '   '); return reopened.size(); })(), 2);

// 损坏文件应重建而不是抛错
fs.writeFileSync(file, '{ broken json', 'utf-8');
const broken = new TikuStore(file);
eq('损坏文件重建为空库', broken.size(), 0);
broken.put('新题', 'D');
broken.flush();
eq('重建后可正常写入', new TikuStore(file).get('新题'), 'D');
fs.rmSync(dir, { recursive: true, force: true });

async function main() {
  // ── 3. Searcher 链 ──────────────────────────────────────────────
  console.log('\n=== 搜题器链 ===');
  const qs: QuizQuestion[] = [1, 2, 3].map(i => ({
    index: i,
    stem: `题目${i}`,
    type: 'single' as const,
    options: [],
    hasInput: false,
  }));

  const called: string[] = [];
  const cache = new TikuStore(path.join(os.tmpdir(), 'tiku-chain.json'));
  cache.put('题目2', 'B');

  let cacheSaw: number[] = [];
  let llmSaw: number[] = [];

  const chain = [
    {
      name: '本地题库',
      async invokeAll(list: QuizQuestion[]) {
        called.push('本地题库');
        cacheSaw = list.map(q => q.index);
        return new CacheSearcher(cache).invokeAll(list);
      },
    },
    {
      name: 'AI',
      async invokeAll(list: QuizQuestion[]) {
        called.push('AI');
        llmSaw = list.map(q => q.index);
        return new Map(list.map(q => [q.index, q.index === 1 ? 'A' : 'C']));
      },
    },
  ];

  const got = await resolveAnswers(qs, chain);
  eq('链按顺序调用', called, ['本地题库', 'AI']);
  eq('题库阶段收到全部 3 题', cacheSaw, [1, 2, 3]);
  eq('AI 只收到未命中的 2 题（不重复付费）', llmSaw, [1, 3]);
  eq('合并后 3 题都有答案', [...got.keys()].sort(), [1, 2, 3]);
  eq('题库命中的那题用题库答案', got.get(2), 'B');
  eq('其余用 AI 答案', [got.get(1), got.get(3)], ['A', 'C']);

  // 某个搜题器整体失败不应中断整链
  const miss: number[] = [];
  const resilient = await resolveAnswers(
    qs,
    [
      {
        name: '会炸的',
        async invokeAll() {
          throw new Error('502');
        },
      },
      { name: 'AI', async invokeAll(l: QuizQuestion[]) { return new Map(l.map(q => [q.index, 'X'])); } },
    ],
    q => miss.push(q.index)
  );
  eq('单个搜题器失败后仍继续', resilient.size, 3);
  eq('没有 onMiss 回调（都答上了）', miss, []);

  // 全部答不上时应回调 onMiss 而不是塞占位
  const misses: number[] = [];
  const empty = await resolveAnswers(
    qs,
    [{ name: '空搜题器', async invokeAll() { return new Map(); } }],
    q => misses.push(q.index)
  );
  eq('答不上时结果为空（不塞猜测值）', empty.size, 0);
  eq('答不上的题进入 onMiss', misses, [1, 2, 3]);
  fs.rmSync(path.join(os.tmpdir(), 'tiku-chain.json'), { force: true });

  console.log(failed ? `\nFAIL: ${failed} 项` : '\nPASS: 答案链与题库验证通过');
  process.exit(failed ? 1 : 0);

}

void main();
