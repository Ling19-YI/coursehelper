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
    /let isQuiz = active\.kind === 'quiz';/.test(index),
  '分派未落在任务点上'
);
check(
  'index 读任务点标签页（分页模型）',
  /const jobTabs = await listJobTabs\(this\.opts\.page\)/.test(index),
  '未读标签页 → 分页章节只做得到第一个任务点'
);
check(
  '标签数 > 1 时按标签逐个处理',
  /jobTabs\.length > 1/.test(index) && /activateJobTab\(/.test(index),
  '没有逐标签推进的逻辑'
);
check(
  '无标签页的老结构完全不受影响（jobTabs 为空时跳过全部分支）',
  /if \(jobTabs\.length > 1\)/.test(index),
  '老结构会被新逻辑误伤'
);
check(
  '只在有标签页时才用标签数当收敛判据',
  /jobTabs\.length > 1 \? jobTabs\.length : 0/.test(index),
  '拿 knowledgeJobCount 当任务点总数（实测那是「已完成数」，会一直等超时）'
);
check(
  'index 未知类型才退回 isQuizPage',
  /active\.kind === 'unknown'/.test(index) && /isQuiz = await isQuizPage\(this\.opts\.page\);/.test(index),
  'unknown 时没有兜底，新课程页会整体漏做'
);
check(
  'index 判定文档任务点后跳过 waitForVideo',
  /active\.kind === 'document'\s*\n\s*\? false\s*\n\s*: await waitForVideo/.test(index),
  '文档任务点白等 8s 视频元数据'
);
check(
  'index 进章节时把任务点标签清单写进日志',
  /本章共 \$\{jobTabs\.length\} 个任务点/.test(index),
  '识别结果不可见 = 用户下次还是无从判断'
);
check(
  '待完成计数读不到时，有标签页就继续推进而不是收手',
  /left === null[\s\S]{0,1200}?jobTabs\.length > 1 && tabIndex < jobTabs\.length[\s\S]{0,400}?continue;/.test(
    index
  ),
  '⚠️ 本次根因：实测 readUnfinishedCount 恒为 null，旧逻辑在这里 break，'
    + '「已切到第 2 个任务点、还没做完」也会被当成本章处理完了'
);
check(
  '用「已确认完成的标签集合」判定本章完成，不用任何推断标志',
  // ⚠️ 这条被真机实测连打两次脸：
  //   ① 改革开放史 2.3：切到最后一个标签发现有活 → break 时 tabIndex 已走满
  //      → 被 `tabIndex >= jobTabs.length` 误判成「全完成」→ markDone() 记账
  //      → 那一章的测验永远不会再被处理。
  //   ② 中华民族共同体概论 1.2：第二轮进来 tabIndex 已是最后一个，while 一次
  //      不进 → 「本轮没找到活」恒为 true → 又误判完成，日志还自相矛盾：
  //      「本章还有 2 个任务点未完成」紧跟「已全部完成」。
  // 唯一可靠的判据是「每个标签都被亲眼确认过完成」。
  /const doneTabs = new Set<number>\(\)/.test(index) &&
    /if \(doneTabs\.size >= jobTabs\.length\)/.test(index),
  '必须有 doneTabs；任何基于 tabIndex / foundWork 的完成推断都会假成功'
);
check(
  '确认完成的标签才记进 doneTabs',
  /here\.finished >= here\.total\)\s*\{\s*\n\s*doneTabs\.add\(next\);/.test(index),
  '没确认完成就记账 → 完成度虚高'
);
check(
  '切不过去的标签不记进 doneTabs（状态未知）',
  /无法切到第 \$\{next\} 个任务点[\s\S]{0,240}?tabIndex = jobTabs\.length;\s*\n\s*break;/.test(index),
  '切换失败却当成完成，剩下的任务点再也没人管'
);
check(
  '无新标签可切但仍有未完成的，如实报「未能推进」而不是报完成',
  /还有 \$\{jobTabs\.length - doneTabs\.size\} 个任务点未完成/.test(index),
  '推不动时静默报完成 = 用户以为刷完了，其实一题没做'
);

console.log('\n[实测发现：章节内容由 ul.prev_ul 分页渲染，一次只有当前那个任务点]');
//
// 2026-10-16 实测（中华民族共同体概论 3.1，章节详情写着「1课程视频 2章节测验」）：
//   .ans-job-icon 只有 1 个（视频，已完成），没有任何测验 iframe
//   input.jobUnfinishCount 0 个 → getJobCount() 返回 0
//   切换靠 changeDisplayContent(i, total, ...)，它只改 iframe.src 的 num 参数
// 引擎此前完全没有这个概念，于是「一章只做得到第一个任务点」。
check(
  'jobpoint 导出 listJobTabs / activateJobTab',
  /export async function listJobTabs\(/.test(job) &&
    /export async function activateJobTab\(/.test(job),
  '缺分页遍历入口'
);
check(
  'listJobTabs 读 ul.prev_ul 的 li',
  /querySelector\('ul\.prev_ul'\)/.test(job) && /querySelectorAll\('li'\)/.test(job),
  '标签页选择器不对'
);
check(
  'activateJobTab 优先调 changeDisplayContent 而非模拟点击',
  /changeDisplayContent/.test(job),
  '模拟点击可能被层叠元素挡住，且平台函数会同步更新标签高亮'
);
check(
  'activateJobTab 等到 cards frame 的 num 参数对上再返回',
  /\[?&\]num=/.test(job) && /waitCardsNum/.test(job),
  '不等就返回 → 读到上一页的 iframe，把 A 的内容当成 B'
);
check(
  '激活后等一段时间让 iframe 加载（不能立刻判类型）',
  /await h\.ctl\.sleep\(500\)/.test(job) || /h\.ctl\.sleep\(500\)/.test(job),
  '切完立即读会读到空 frame'
);
check(
  '切换有超时上限（不会卡死）',
  /Date\.now\(\) < deadline/.test(job) && /15000/.test(job),
  '缺 timeout，页面异常时整轮停摆'
);
check(
  'index 导入分页函数',
  /listJobTabs/.test(index) && /activateJobTab/.test(index),
  '调用了但没导入'
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

console.log('\n[实测发现：扫码弹窗期间保活 ticker 仍在派发事件，二维码被自己刷掉]');
const keepalive = read('keepalive.ts');
const blocker = read('blocker.ts');

check(
  '有 setManualBlock（把「人工介入」同步给页面内的 ticker）',
  /export async function setManualBlock\(page: Page, blocked: boolean\)/.test(keepalive) &&
    /__kaBlocked = b;/.test(keepalive),
  '缺这个函数，页面内 ticker 无从得知该让位'
);
check(
  'SPY_JS 的 300ms ticker 会因 __kaBlocked 整轮让位',
  /if \(window\.__kaBlocked\) return;/.test(keepalive),
  'ticker 只认 __kaPaused（只有用户点「暂停」才置），扫码期间继续派发 mousemove/focus → 二维码反复刷新'
);
check(
  '视频循环每轮重申标志（覆盖平台重挂 iframe 后的新文档）',
  /if \(block\) \{[\s\S]{0,400}?await setManualBlock\(page, true\);/.test(video),
  '只在进入弹窗时设一次，导航后新文档里没有该标志，ticker 立刻复活'
);
check(
  'waitForVideo 的入场检查也设标志',
  /const pre = await detectManualBlock\(page, h\.autoPauseOnVerify\(\)\);[\s\S]{0,400}?await setManualBlock\(page, true\);/.test(
    video
  ),
  '进场就弹窗时只停主进程，ticker 仍在刷二维码'
);

console.log('\n[实测发现：「弹窗消失一次」被当成「用户已处理」]');
check(
  '有 BLOCK_CLEAN_POLLS 常量',
  /const BLOCK_CLEAN_POLLS = 3;/.test(video),
  '缺常量说明又回到了「单轮命中即恢复」'
);
check(
  'waitBlockGone 要求连续多轮查不到才返回 true',
  /clean\+\+;[\s\S]{0,120}?clean >= BLOCK_CLEAN_POLLS/.test(video),
  '单轮查不到就 return true，二维码重绘抖一下就被判成处理完了'
);
check(
  '视频循环同样要求连续多轮才恢复',
  /cleanPolls\+\+;[\s\S]{0,120}?cleanPolls >= BLOCK_CLEAN_POLLS/.test(video),
  'announced 一置空就恢复动作 → 「暂停→刷新二维码→继续→刷新」振荡'
);
check(
  '等待超时不解除静默',
  /超时不解除静默/.test(video),
  '超时后恢复保活，二维码立刻又开始被刷新'
);

console.log('\n[实测发现：风控页劫持被当成「正常但没目录」，还报任务完成]');
check(
  '按 URL 认风控页，且不受 autoPauseOnVerify 门控',
  /const VERIFY_URL_RE = \/antispider\|ShowVerify\|verify\\\.ac\/i;/.test(blocker) &&
    /VERIFY_URL_RE\.test\(u\)/.test(blocker),
  '整页跳转没有可读弹层，按文本一个都查不出来'
);
check(
  '进不去章节时先判风控，命中就中止整轮而不是标「跳过」',
  /const guarded = await detectManualBlock\(this\.opts\.page, this\.hooks\.autoPauseOnVerify\(\)\);/.test(
    index
  ) && /riskBlocked = true;/.test(index),
  '继续遍历会把剩下每节都标跳过，最后报「🎉 任务完成」——假成功'
);
check(
  '风控中断时不报「任务完成」',
  /if \(riskBlocked\) \{[\s\S]{0,400}?不是任务完成/.test(index),
  '用户以为刷完了，其实一个都没做'
);
check(
  '被风控后不再换课重试（整个会话都被盯上了）',
  /if \(riskBlocked\) break;/.test(index),
  '换课也一样进不去，纯空转'
);

console.log('\n[用户反馈：同章节有视频和题目时，没放完视频就去答题]');
//
// 旧结构把判定从「DOM 里有没有测验 iframe」搬到了「当前活跃任务点」，
// 但 index.ts 的回退路径又请回了老逻辑：active.kind === 'unknown' 时调
// isQuizPage，而它内部第3 步 findQuizFrames 问的还是「页面上有没有测验」。
// 混合章节里测验 iframe 一直在，于是视频还没播就被判成测验章 → 直接答题。
// 这几条守住「有未播完的视频就不许判成测验」这道闸。
check(
  'jobpoint 导出 hasUnfinishedVideoJob',
  /export async function hasUnfinishedVideoJob\(/.test(job),
  '缺这个守卫，unknown 时无从判断视频是否该优先'
);
check(
  'hasUnfinishedVideoJob 只看未完成的视频任务点',
  /j\.kind === 'video' && !j\.finished/.test(job),
  '把已完成的视频也算进去会永久挡住测验分支'
);
check(
  'index 回退到 isQuizPage 之前先问「有没有待播视频」',
  /if \(await hasUnfinishedVideoJob\(this\.opts\.page\)\) \{[\s\S]{0,300}?\} else \{\s*\n\s*isQuiz = await isQuizPage/.test(
    index
  ),
  '没有这道闸，混合章节在 unknown 时仍会被测验 iframe 劫持'
);
check(
  'index 在日志里说明「视频优先」',
  /本章还有未完成的视频任务点，不按测验处理/.test(index),
  '静默跳过会让用户以为程序卡住了'
);
check(
  'isQuizPage 内部也守同一道闸（防止其它调用方绕过）',
  /if \(await hasUnfinishedVideoJob\(page\)\) return false;/.test(quiz),
  '只在 index 加闸，其它调用 isQuizPage 的地方仍会误判'
);
check(
  'isQuizPage 的闸在 findQuizPopup / findQuizFrames 之前',
  (() => {
    const body = quiz.slice(quiz.indexOf('export async function isQuizPage'));
    const gate = body.indexOf('hasUnfinishedVideoJob');
    const popup = body.indexOf('findQuizPopup');
    const frames = body.indexOf('findQuizFrames');
    return gate > -1 && gate < popup && gate < frames;
  })(),
  '闸放在判定之后就等于没放'
);
check(
  'quiz.ts 导入 hasUnfinishedVideoJob',
  /import \{[^}]*hasUnfinishedVideoJob[^}]*\} from '\.\/jobpoint'/.test(quiz),
  '调用了但没导入，构建期就断'
);

if (failed) {
  console.error(`\n${failed} 项断言失败`);
  process.exit(1);
}
console.log('\n全部通过');
