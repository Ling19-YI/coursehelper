import type { Page, Frame } from 'playwright';
import type { EngineHooks } from './hooks';

/**
 * 章节内的「任务点」（知识卡）。
 *
 * ── 为什么需要这个模块 ──
 * 一个章节可以同时挂多个不同类型的任务点：视频、文档、测验。平台把它们
 * **并列**塞进同一张课程页（`studentstudy`）里，每个任务点是一个 iframe，
 * 外面套一层任务卡容器（class 形如 `ans-attach-ct videoContainer`）。
 *
 * 旧实现只做了一个二元判断：`isQuizPage(page)` —— 只要 DOM 里**存在**任何
 * 看起来像测验的 iframe，就认定「本章是测验章」，整章走答题分支。
 * 于是「视频 + 测验」的混合章节里，测验 iframe 一进页面就在 DOM 里，
 * `isQuizPage` 恒为 true，视频分支永远轮不到 —— 用户看到的就是
 * 「一个章节多个类型，里面有视频可能有测试可能有文档，无法识别执行」。
 *
 * 根因是**把「DOM 里有没有」当成了「当前该做的是不是」**。
 * 正确的问法是：本章**当前活跃的那个任务点**是什么类型。
 *
 * ── 怎么定位「当前活跃的任务点」 ──
 * 两个权威信号，任一可用即可：
 *   1. 完成标记：平台在已完成的任务卡容器上写 `ans-job-finished`
 *      （与 video.ts 的 tagFinishedJobFrames 同源，是最可靠的完成信号）。
 *      `scroll2Job()` 只会跳到**未完成**的任务点。
 *   2. 可视区：任务点的 iframe 落在父文档可视区内 = 平台当前滚动到的那个。
 *      因为 `scroll2Job()` 的语义就是「滚到下一个未完成任务点」。
 *
 * 排序取**自上而下的第一个未完成任务点**；若其中有落在可视区内的，
 * 优先取它（平台刚滚过去的就是它）。两者一致时结论唯一、稳定。
 *
 * ── 类型怎么判 ──
 * 按 iframe 的 URL 里的模块段判（这是超星自己的路由约定）：
 *   ananas/modules/video/…  → 视频
 *   ananas/modules/pdf|doc  → 文档
 *   work/…、exam/…          → 测验
 * 不用 innerText 猜 —— 课程页正文里到处是「单选题」这类词，猜必误判
 * （quiz.ts 的 NON_QUIZ_FRAME_URL 注释记录了这次教训：线性代数 6/6 章误判）。
 */

export type JobKind = 'video' | 'document' | 'quiz' | 'unknown';

/** 视频任务点：超星视频播放器模块 */
const VIDEO_MODULE_URL = /ananas\/modules\/video|modules\/video\/|insertvideo/i;

/** 文档任务点：pdf / word / office 阅读器模块 */
const DOC_MODULE_URL =
  /ananas\/modules\/(pdf|doc|document|office|ppt)|modules\/(pdf|doc|document|office|ppt)\/|insertdoc|\.pdf(\?|$)/i;

/** 测验任务点：作业/考试/随堂练习模块 */
const QUIZ_MODULE_URL =
  /selectWorkQuestion|work\/work|VideoQuestion|ExamWork|\/(work|exam)\/(start|answer|question|doHomeWork)/i;

export interface JobFrame {
  frame: Frame;
  kind: JobKind;
  url: string;
  /** 平台已把该任务点标记为完成（容器 class 含 ans-job-finished） */
  finished: boolean;
  /** 该任务点的 iframe 当前落在父文档可视区内 */
  inView: boolean;
  /** 在父文档里的 DOM 次序（自上而下）；取不到时给一个大数排到最后 */
  order: number;
}

/**
 * 该 frame 对应的任务点是否已被平台标记完成。
 *
 * 顶层 frame（无 frameElement）与正在导航/已销毁的 frame 一律返回 false——
 * 宁可当成「未完成」多绕一轮（外层有 MAX_ROUNDS 兜底），也不能把没做的判成做了。
 */
export async function jobFrameFinished(frame: Frame): Promise<boolean> {
  try {
    const fe = await frame.frameElement();
    if (!fe) return false;
    return await fe.evaluate((node: Element) => {
      const el = node as HTMLElement;
      if (el.getAttribute('data-ch-finished') === '1') return true;
      let cur: Element | null = el;
      while (cur) {
        const cn = String((cur as HTMLElement).className || '');
        if (cn.indexOf('ans-job-finished') >= 0) return true;
        cur = cur.parentElement;
      }
      return false;
    });
  } catch {
    return false;
  }
}

/** 按 URL 判任务点类型；不是任务点的 frame 返回 'unknown' */
export function kindOfJobUrl(url: string): JobKind {
  if (!url || url === 'about:blank' || url.startsWith('data:') || url.startsWith('blob:')) {
    return 'unknown';
  }
  // 顺序有意义：视频模块 URL 里也含 modules/，必须先判视频再判文档
  if (VIDEO_MODULE_URL.test(url)) return 'video';
  if (DOC_MODULE_URL.test(url)) return 'document';
  if (QUIZ_MODULE_URL.test(url)) return 'quiz';
  return 'unknown';
}

/**
 * 枚举本章所有可识别的任务点，按 DOM 次序（自上而下）返回。
 *
 * 只统计能判出类型的 iframe（视频/文档/测验模块）。课程页框架、
 * 广告位、blank frame 一律不进结果。
 */
export async function collectJobFrames(page: Page): Promise<JobFrame[]> {
  const out: JobFrame[] = [];

  for (const frame of page.frames()) {
    const url = frame.url();
    const kind = kindOfJobUrl(url);
    if (kind === 'unknown') continue;

    let finished = false;
    let inView = false;
    let order = 9999;

    try {
      // frameElement 拿到的是**父文档里的 <iframe> 元素**，
      // 因此下面一次 evaluate 就能同时算完成标记、DOM 次序、可视区，
      // 且 getBoundingClientRect/innerHeight 都在父文档坐标系里，天然对齐。
      const fe = await frame.frameElement();
      if (fe) {
        const meta = await fe.evaluate((node: Element) => {
          const el = node as HTMLElement;
          // ① 完成标记：沿祖先链找 ans-job-finished。
          //    不能只看最近的一个任务卡容器 —— 平台容器是嵌套的，
          //    内侧没标记、外侧才带 ans-job-finished 的情况下会漏判。
          let done = false;
          let cur: Element | null = el;
          while (cur) {
            const cn = String((cur as HTMLElement).className || '');
            if (cn.indexOf('ans-job-finished') >= 0) {
              done = true;
              break;
            }
            cur = cur.parentElement;
          }
          // video.ts 已经打过标的，直接采信，避免重复推导出不同结论
          if (!done && el.getAttribute('data-ch-finished') === '1') done = true;

          // ② DOM 次序
          const all = Array.from(el.ownerDocument.querySelectorAll('iframe'));
          const idx = all.indexOf(el as HTMLIFrameElement);

          // ③ 可视区（父文档坐标系）
          const r = el.getBoundingClientRect();
          const vh = window.innerHeight || 0;
          const inview = r.height > 0 && r.bottom > 0 && r.top < vh;

          return { done, idx, inview };
        });

        finished = !!meta?.done;
        inView = !!meta?.inview;
        if (typeof meta?.idx === 'number' && meta.idx >= 0) order = meta.idx;
      }
    } catch {
      /* frame 可能正在导航/已被销毁，跳过它，不影响其它任务点 */
    }

    out.push({ frame, kind, url, finished, inView, order });
  }

  return out.sort((a, b) => a.order - b.order);
}

export interface ActiveJob {
  kind: JobKind;
  job: JobFrame | null;
  /** 本章识别到的任务点总数 */
  total: number;
  /** 其中平台已标记完成的个数 */
  finished: number;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * 等任务点 iframe 把 URL 落定。
 *
 * ── 为什么必须要等 ──
 * 判定类型靠的是 iframe 的 URL，而 iframe 是先创建、后导航：`frame.url()`
 * 在导航提交之前是 `about:blank`。刚点进章节的那一刻，几个任务点 iframe
 * 的提交顺序并不保证与 DOM 次序一致——实测可能出现**测验先提交、视频后提交**，
 * 于是这一瞬间只看得见测验，判定成「本章是测验章」，视频又被跳过。
 * 那正是要修的 bug 换了个触发时机重现。
 *
 * 判据用**章节自己声明的任务点总数**（目录里的 input.knowledgeJobCount，
 * 引擎已经读进 chapter.jobCount）——比「数量稳定」可靠：
 * 数量稳定在 1 并不能说明只提交了 1 个。
 *
 * wantCount <= 0（读不到总数）时退化为「两次采样数量一致即认为落定」，
 * 并同样受 timeout 约束 —— 任何情况下都不会无限等下去。
 */
export async function waitForJobFrames(
  page: Page,
  wantCount = 0,
  timeoutMs = 3000
): Promise<JobFrame[]> {
  const t0 = Date.now();
  let last: JobFrame[] = [];
  let prevCount = -1;
  while (Date.now() - t0 < timeoutMs) {
    last = await collectJobFrames(page);
    if (wantCount > 0) {
      if (last.length >= wantCount) return last;
    } else if (last.length > 0 && last.length === prevCount) {
      return last;
    }
    prevCount = last.length;
    await sleep(600);
  }
  return last;
}

/** 从已枚举的任务点里挑出「当前该做的那个」（纯函数，便于测试） */
export function pickActiveJob(jobs: JobFrame[]): ActiveJob {
  const unfinished = jobs.filter(j => !j.finished);
  if (!unfinished.length) {
    return { kind: 'unknown', job: null, total: jobs.length, finished: jobs.length };
  }
  const inView = unfinished.find(j => j.inView);
  const job = inView ?? unfinished[0];
  return {
    kind: job.kind,
    job,
    total: jobs.length,
    finished: jobs.length - unfinished.length,
  };
}

/**
 * 本章当前该处理的任务点。
 *
 * 判定顺序：
 *   1. 未完成 + 在可视区（平台刚 scroll2Job 跳到的） → 取自上而下第一个
 *   2. 没有在可视区的 → 取自上而下第一个未完成的
 *   3. 全部完成 / 一个都识别不到 → kind = 'unknown'
 *
 * wantCount > 0 时先等 URL 落定（见 waitForJobFrames 的说明），
 * 只在「刚进章节」那一轮需要，逐轮循环里传 0 以省掉等待。
 *
 * 返回 'unknown' 时调用方应退回旧的启发式判断，而不是当成「没问题」。
 */
export async function activeJob(page: Page, wantCount = 0): Promise<ActiveJob> {
  const jobs =
    wantCount > 0 ? await waitForJobFrames(page, wantCount) : await collectJobFrames(page);
  return pickActiveJob(jobs);
}

/** 便捷版：只要当前任务点的类型。判不出来返回 'unknown' */
export async function activeJobKind(page: Page): Promise<JobKind> {
  return (await activeJob(page)).kind;
}

/**
 * 本页是否还挂着**没做完的视频任务点**。
 *
 * ── 为什么需要 ──
 * 用户反馈「一个章节同时出现视频和题目，没放完视频就去答题」。
 *
 * 根因在index.ts 的这一行：
 *     const isQuiz = active.kind === 'quiz'
 *       || (active.kind === 'unknown' && await isQuizPage(page));
 *
 * `active.kind` 为unknown 时（iframe 还没导航完/ 判不出模块类型）会退回
 * `isQuizPage`，而那条老路的第3 步是 `findQuizFrames` —— 也就是
 * 「DOM 里有没有测验 iframe」。混合章节里测验 iframe 本来就一直在，
 * 于是哪怕视频还没播，这一瞬间也会被判成「本章是测验章」，
 * 直接走答题分支，视频从头到尾没被碰过。
 *
 * 也就是说：jobpoint.ts 把判定改成「当前活跃任务点」之后，
 * index.ts 的回退路径又把「DOM 里有没有」这个原始错误请了回来。
 *
 * 这里给回退加一道闸：**只要本章还有没播完的视频，就不许判成测验。**
 * 宁可这一轮什么都不做（下一轮 activeJob 会重新判定），也不能跳过分
 * 视频直接去答题 —— 后者会让用户看到「视频一秒钟没播就去答题」。
 */
export async function hasUnfinishedVideoJob(page: Page): Promise<boolean> {
  try {
    const jobs = await collectJobFrames(page);
    return jobs.some(j => j.kind === 'video' && !j.finished);
  } catch {
    return false;
  }
}

/**
 * 本章任务点清单，用于诊断日志。
 *
 * 为什么单独导出：混合章节（视频 + 测验同页）的故障有两种截然不同的成因——
 *   ① 任务点**类型判错**（视频被当成测验）
 *   ② 类型判对了，但**选错了任务点**（pickActiveJob 挑中了可视区里的测验，
 *      而没播完的视频排在前面）
 * 两者日志表现完全不同，光看「本轮判成测验」无法区分。把这三项
 * （类型 / 完成标记 / 可视区）一次性打出来，看一眼就能定位。
 */
export async function describeJobInventory(page: Page): Promise<
  Array<{ kind: JobKind; finished: boolean; inView: boolean }>
> {
  try {
    return (await collectJobFrames(page)).map(j => ({
      kind: j.kind,
      finished: j.finished,
      inView: j.inView,
    }));
  } catch {
    return [];
  }
}

/**
 * 本章的任务点标签页。
 *
 * ── 为什么需要 ──
 * 实测（2026-10-16，中华民族共同体概论 3.1）发现：任务点**不是并列渲染在同一页**，
 * 而是由顶部 `ul.prev_ul` 做**分页**，一次只渲染当前那一个：
 *
 *   <li class="active" onclick="changeDisplayContent(1,2,章节id,课程id,班级id,'')">1课程视频</li>
 *   <li           onclick="changeDisplayContent(2,2,章节id,课程id,班级id,'')">2章节测验</li>
 *
 * `changeDisplayContent` 的唯一实质动作是改 iframe 的 src：
 *   `/mooc-ans/knowledge/cards?...&knowledgeid=<章节id>&num=<序号-1>&...`
 * 即 `num` 就是任务点序号。章节详情写着「1课程视频 2章节测验」，但 DOM 里
 * 只有 1 个 `.ans-job-icon`（视频），两个测验 iframe 压根不存在。
 *
 * 于是引擎此前「进入章节 → 读任务点 → 判类型」的整套流程只看得到第1 个任务点，
 * 而 `input.jobUnfinishCount` 在这个页面里一个都没有，`readUnfinishedCount()`
 * 返回 null，`index.ts` 一轮之后就 break —— 用户看到的就是
 * 「视频没放完就去答题」（实际上视频那个任务点早已完成，程序判定本章没活可干了）。
 *
 * ── 怎么用 ──
 * `listJobTabs()` 读出标签页；`activateJobTab()` 切到第 n 个并等 cards frame
 * 加载完。**切换是整页替换 iframe.src**，前一个任务点会从 DOM 消失，
 * 所以「本章还有没有活」不能靠「它还在不在页面里」判断。
 */
export interface JobTab {
  /** 1 起算的序号，与 changeDisplayContent 的第一个参数一致 */
  index: number;
  /** 标签文本，如「1课程视频」「2章节测验」 */
  label: string;
  /** 是否是当前激活的那个 */
  active: boolean;
}

/**
 * 读本章的任务点标签页。
 *
 * 返回空数组表示「这个课程页没有用标签页分页」——
 * 老结构（多任务点并列在同一页）会走到这条回退路径，行为与改动前一致。
 */
export async function listJobTabs(page: Page): Promise<JobTab[]> {
  for (const frame of page.frames()) {
    try {
      const tabs = await frame.evaluate(() => {
        const ul = document.querySelector('ul.prev_ul');
        if (!ul) return null;
        return Array.from(ul.querySelectorAll('li')).map((li, i) => ({
          index: i + 1,
          label: (li.textContent || '').replace(/\s+/g, ' ').trim(),
          active: li.className.indexOf('active') >= 0,
        }));
      });
      if (tabs && tabs.length) return tabs as JobTab[];
    } catch {
      /* frame 可能正在导航，继续试下一个 */
    }
  }
  return [];
}

/**
 * 切到第 index 个任务点标签（1 起算），并等 cards frame 加载完。
 *
 * 优先直接调平台的 `changeDisplayContent`——它会同步改 iframe.src 与标签高亮，
 * 比模拟点击可靠（点击可能被层叠元素挡住）。函数不存在时退化为点 li。
 *
 * 返回 false 表示切不过去（标签数已变、frame 导航中、用户切走了章节）。
 */
export async function activateJobTab(
  page: Page,
  h: EngineHooks,
  index: number,
  total: number
): Promise<boolean> {
  const deadline = Date.now() + 15000;

  for (const frame of page.frames()) {
    try {
      const info = await frame.evaluate(
        ({ idx, tot }) => {
          const ul = document.querySelector('ul.prev_ul');
          if (!ul) return null;
          const items = Array.from(ul.querySelectorAll('li'));
          if (idx < 1 || idx > items.length) return { ok: false as const, total: items.length };
          const li = items[idx - 1];
          const oc = li.getAttribute('onclick') || '';
          const m = oc.match(
            /changeDisplayContent\(\s*(\d+)\s*,\s*(\d+)\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'/
          );
          if (m && typeof (window as unknown as Record<string, unknown>).changeDisplayContent === 'function') {
            // 平台的标签切换函数。类型里没有这个全局，用 Record 取。
            const fn = (window as unknown as Record<string, (...a: unknown[]) => void>)
              .changeDisplayContent;
            fn(Number(m[1]), Number(m[2]), m[3], m[4], m[5], '', '');
            return { ok: true as const, total: items.length, via: 'changeDisplayContent' };
          }
          li.click();
          return { ok: true as const, total: items.length, via: 'click' };
        },
        { idx: index, tot: total }
      );
      if (!info) continue; // 这个 frame 没有标签页，找下一个
      if (!info.ok) return false;
      if (info.total !== total) {
        h.log(
          'warn',
          `    ⚠ 本章任务点标签数变了（原以为 ${total} 个，实际 ${info.total} 个）`
        );
      }

      // 等 cards frame 换成对应 num 那一页
      while (Date.now() < deadline) {
        h.ctl.throwIfStopped();
        const ready = await waitCardsNum(page, index - 1);
        if (ready) {
          h.log('info', `    → 已切到第 ${index} 个任务点（${info.via}）`);
          return true;
        }
        await h.ctl.sleep(500);
      }
      h.log('warn', `    ⚠ 切到第 ${index} 个任务点后未等到内容加载`);
      return false;
    } catch (e: any) {
      if (h.ctl.isStopped) throw e;
    }
  }
  return false;
}

/**
 * cards frame 的 src 是否已经对应第 num 个任务点。
 *
 * 读 src 里的 `num=` 参数，不猜也不等固定时长——平台切页是异步的，
 * 早一步读到旧页就会把上一个任务点当成这一个，症状是「答题答到了别的任务点上」。
 */
async function waitCardsNum(page: Page, num: number): Promise<boolean> {
  for (const frame of page.frames()) {
    if (!frame.url().includes('knowledge/cards')) continue;
    const m = frame.url().match(/[?&]num=(-?\d+)/);
    if (m && Number(m[1]) === num) return true;
  }
  // 还没找到 cards frame：可能正在导航
  return false;
}

/** 把类型翻成给用户看的短标签 */
export function jobKindLabel(kind: JobKind): string {
  switch (kind) {
    case 'video':
      return '视频';
    case 'document':
      return '文档';
    case 'quiz':
      return '测验';
    default:
      return '未识别';
  }
}
