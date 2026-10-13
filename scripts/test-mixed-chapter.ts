/**
 * 「一章多类型任务点」（视频 + 测验 + 文档同页）识别失败的静态结构断言。
 *
 * 背景（v2.1.x 用户反馈）：
 *   「一个章节多个类型，里面有视频可能有测试，可能有文档，无法识别执行」
 *
 * 根因：超星把同一章节的多个任务点**并列**塞进同一张课程页，每个任务点一个
 * iframe，三个 iframe 一进页面就同时在 DOM 里。旧实现只问
 * 「DOM 里有没有像测验的 iframe」（isQuizPage），有就整章走答题分支 ——
 * 于是「视频 + 测验」的章节里视频永远不播，测验也答的是别的任务点。
 *
 * 修法：新增 jobpoint.ts，把判定落回**当前活跃的任务点**（未完成 + 可视区内），
 * 按其类型（视频/文档/测验）分派。这里守住这个结构，防止回退。
 */
import { readFileSync } from 'node:fs';

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

const job = read('jobpoint.ts');
const quiz = read('quiz.ts');
const index = read('index.ts');
const video = read('video.ts');

// ---- 1. 任务点识别模块存在且给出三分类 ----
check(
  'jobpoint 导出 activeJob / jobKindLabel / jobFrameFinished',
  /export async function activeJob\(/.test(job) &&
    /export function jobKindLabel\(/.test(job) &&
    /export async function jobFrameFinished\(/.test(job),
  '缺核心导出'
);
check(
  '按 URL 模块判类型：视频 ananas/modules/video',
  /ananas\\\/modules\\\/video/.test(job),
  '没有视频模块 URL 规则'
);
check(
  '按 URL 模块判类型：文档 ananas/modules/(pdf|doc…)',
  /ananas\\\/modules\\\/\(pdf\|doc\|document\|office\|ppt\)/.test(job),
  '没有文档模块 URL 规则'
);
check(
  '按 URL 模块判类型：测验 work/exam',
  /selectWorkQuestion\|work\\\/work\|VideoQuestion\|ExamWork/.test(job),
  '没有测验模块 URL 规则'
);
check(
  '类型判定顺序：先视频后文档（两者 URL 都含 modules/）',
  job.indexOf('if (VIDEO_MODULE_URL.test(url)) return \'video\';') <
    job.indexOf("if (DOC_MODULE_URL.test(url)) return 'document';"),
  '文档规则会抢走视频 URL'
);

// ---- 2. 「活跃任务点」= 未完成 + 可视区，否则自上而下第一个未完成 ----
check(
  '只从未完成的任务点里选',
  /const unfinished = jobs\.filter\(j => !j\.finished\)/.test(job),
  '会把已完成的任务点当成当前任务点'
);
check(
  '未完成里优先可视区内的那个',
  /const inView = unfinished\.find\(j => j\.inView\)/.test(job) &&
    /const job = inView \?\? unfinished\[0\]/.test(job),
  '可视为空时没有退回第一个'
);
check(
  '完成标记同时认 ans-job-finished 与 data-ch-finished',
  /indexOf\('ans-job-finished'\) >= 0/.test(job) &&
    /getAttribute\('data-ch-finished'\) === '1'/.test(job),
  '完成信号不全，任务点会反复重做'
);
check(
  '按父文档 DOM 次序排序',
  /out\.sort\(\(a, b\) => a\.order - b\.order\)/.test(job),
  '无序返回会让类型判定随 frame 顺序漂移'
);
check(
  '全部完成 / 识别不到时返回 unknown（不假装没问题）',
  /return \{ kind: 'unknown', job: null, total: jobs\.length, finished: jobs\.length \}/.test(job),
  'unknown 语义缺失，调用方无从退回'
);

// ---- 2b. 竞态：iframe 先创建后导航，提交顺序不保证与 DOM 次序一致 ─---
// 只看得见先提交的测验 iframe 就会把整章误判成测验——同一个 bug 换触发时机。
check(
  '有 waitForJobFrames 等 URL 落定',
  /export async function waitForJobFrames\(/.test(job),
  '不等待，骰子决定这一章的命运'
);
check(
  '落定判据用目录声明的任务点总数（wantCount）',
  /if \(wantCount > 0\) \{\s*\n\s*if \(last\.length >= wantCount\) return last;/.test(job),
  '改用「数量稳定」会在只提交 1 个时立刻收工'
);
check(
  '等待有超时上限（不会卡死）',
  /Date\.now\(\) - t0 < timeoutMs/.test(job),
  '缺 timeout，页面异常时整轮刷课停摆'
);
check(
  'activeJob 支持 wantCount 参数',
  /export async function activeJob\(page: Page, wantCount = 0\)/.test(job),
  ''
);

// ---- 3. isQuizPage 必须先问「活跃任务点」，再退回旧启发式 ----
check(
  'isQuizPage 先调用 activeJob',
  /export async function isQuizPage[\s\S]{0,200}await activeJob\(page\)/.test(quiz),
  '仍在只看 DOM 里有没有测验 iframe'
);
check(
  'isQuizPage 对 video/document 直接判非测验',
  /active\.kind === 'video' \|\| active\.kind === 'document'\) return false/.test(quiz),
  '视频章节仍会被测验 iframe 劫持'
);
check(
  'isQuizPage 对 quiz 直接判是',
  /active\.kind === 'quiz'\) return true/.test(quiz),
  '活跃任务点是测验却不答题'
);
check(
  'findQuizPopup 不再排在最前（它是退回路径）',
  !/export async function isQuizPage\(page: Page\): Promise<boolean> \{\s*\n\s*if \(await findQuizPopup\(page\)\) return true;/.test(
    quiz
  ),
  '第一句就是弹窗判定 = 视频页遇弹窗会整章转答题（原 bug）'
);

// ---- 4. 已完成的测验任务点不得再被选中作答 ----
check(
  'findQuizFrames 剔除 ans-job-finished 的 frame',
  /findQuizFrames[\s\S]{0,1400}jobFrameFinished\(f\)\) continue/.test(quiz),
  '混合章节里会重复填已做完的测验'
);

// ---- 5. index.ts 按活跃任务点分派，并按类型直达文档分支 ----
check(
  'index 用 activeJob 取代裸 isQuizPage',
  /const active = await activeJob\(this\.opts\.page, wantJobs\)/.test(index) &&
    /const isQuiz =\s*\n\s*active\.kind === 'quiz'/.test(index),
  '分派未落在任务点上'
);
check(
  'index 仅在本章第一轮等待任务点落定',
  /const wantJobs = rounds === 1 \? chapter\.jobCount \|\| 0 : 0/.test(index),
  '每轮都等会让整轮刷课变慢且无意义'
);
check(
  'index 识别数少于目录声明数时如实告警',
  /目录显示本章有 \$\{chapter\.jobCount\} 个任务点，只识别到 \$\{active\.total\} 个/.test(index),
  '出现不支持的模块类型时用户看不到任何线索'
);
check(
  'index 未知类型才退回 isQuizPage',
  /active\.kind === 'unknown' && \(await isQuizPage\(this\.opts\.page\)\)/.test(index),
  'unknown 时没有兜底，新课程页会整体漏做'
);
check(
  'index 判定文档任务点后跳过 waitForVideo',
  /active\.kind === 'document'\s*\n\s*\? false\s*\n\s*: await waitForVideo/.test(index),
  '文档任务点白等 8s 视频元数据'
);
check(
  'index 进章节时把任务点数量与类型写进日志',
  /本章共 \$\{active\.total\} 个任务点（已完成 \$\{active\.finished\}）/.test(index),
  '识别结果不可见 = 用户下次还是无从判断'
);

// ---- 6. 应用级实测（scripts/e2e-real-engine.ts）发现并修掉的问题 ----
//
// 上面那些是「零件对」的断言，这一段守的是只有把整条链路跑起来才会暴露的
// 三个坑。E2E 本身要 ffmpeg + 真浏览器、跑两分钟，不进 npm test；这里用
// 结构断言把它们钉住，防止以后回退。
console.log('\n[实测发现：已完成任务点的目标标记残留]');
check(
  'markTargetVideo 跳过已完成帧时同时清掉目标标记',
  /if \(await isFinishedFrame\(frame\)\) \{\s*\n\s*await clearTargetMark\(frame\);/.test(video),
  '标记残留 → readTargetState 会按 frame 顺序锁死在这个已完成的视频上，整轮反复重播它'
);
check(
  'clearTargetMark 真的移除 data-ch-target 并停住',
  /async function clearTargetMark\(frame: Frame\)/.test(video) &&
    /querySelector\('video\[data-ch-target="1"\]'\)/.test(video) &&
    /v\.removeAttribute\('data-ch-target'\)/.test(video),
  '只跳过不清标记，下一个任务点永远轮不到'
);

console.log('\n[实测发现：平台记账滞后被误判成本轮白跑]');
check(
  '有 waitUnfinishDrop（等平台计数下降，且有时限）',
  /export async function waitUnfinishDrop\(/.test(video) &&
    /Date\.now\(\) < end/.test(video),
  '缺少等待，短任务点上会立刻读到「计数没变」'
);
check(
  '只在「本轮确实完成了任务点」时才等平台追赶',
  /const didSomething =\s*\n\s*result === 'completed' \|\| result === 'doc_done' \|\| result === 'quiz_ok';/.test(
    index
  ) && /if \(didSomething && lastLeft !== null && left >= lastLeft\) \{/.test(index),
  '对「什么都没做成」的轮次也给宽限，会让白跑检测失效'
);
check(
  '等不到下降仍然照旧停手（不会无限等）',
  /if \(lastLeft !== null && left >= lastLeft\) \{\s*\n\s*this\.log\('warn', `    ⚠ 本章待完成数仍为/.test(
    index
  ),
  '宽限变成了无条件继续，MAX_ROUNDS 前会一直空转'
);

console.log('\n[实测发现：文档任务点被整章计数误判]');
check(
  '文档完成按「这一个任务点是否被记账」判，而不是整章清零',
  /const credited =\s*\n\s*remaining !== null &&\s*\n\s*\(remaining <= 0 \|\| \(before !== null && remaining < before\)\);/.test(
    index
  ),
  '混合章节里文档后面还挂着测验，整章不会清零 → 文档被误报「平台未标记完成」'
);
check(
  '开工前先记下待完成数（before）',
  /const before = await readUnfinishedCount\(this\.opts\.page\);\s*\n\s*const doc = await handleDocument/.test(
    index
  ),
  '没有基准就无从判断是否下降'
);

console.log('\n[实测发现：注入页面的函数源码被打包器辅助函数毒化]');
check(
  'extractQuestions 注入时兜住 __name（keepNames 产物）',
  /new Function\('__name', 'return \(' \+ args\.fn \+ '\)\(\)'\)/.test(quiz),
  '构建开启 keepNames 时这里会 ReferenceError，而调用方 catch 掉 → 静默「解析出 0 题」'
);

if (failed) {
  console.error(`\n${failed} 项断言失败`);
  process.exit(1);
}
console.log('\n全部通过');
