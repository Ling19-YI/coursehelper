/**
 * 「一章多类型任务点」识别 —— 真实 DOM 验证（无需登录）。
 *
 * 复现用户的场景：一个章节同时挂 视频 + 视频 + 测验 + 文档 四个任务点，
 * 四个 iframe 一进页面就同时在 DOM 里。旧实现只看「DOM 里有没有测验 iframe」，
 * 于是第一轮就判成测验章、走答题分支，视频与文档永远轮不到。
 *
 * 本脚本用一个本地 HTTP 服务伪造超星的任务点模块（含真实的模块 URL），
 * 再用 Playwright 打开，直接驱动 jobpoint.ts 的 collectJobFrames / activeJob，
 * 断言「当前活跃任务点」随平台「完成标记 + scroll2Job 滚动」正确推进。
 *
 * 附带验证 evaluate 能在浏览器里真的跑起来（不踩 __name 那个坑，
 * 见 test-evaluate-safety.ts 的说明）。
 *
 * 用法：tsx scripts/test-mixed-chapter-dom.ts
 */
import * as http from 'node:http';
import { chromium } from 'playwright';
import {
  activeJob,
  collectJobFrames,
  jobFrameFinished,
  kindOfJobUrl,
  jobKindLabel,
  pickActiveJob,
  waitForJobFrames,
  type JobKind,
} from '../src/main/engine/jobpoint';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ───────────────────────── 伪造超星任务点页面 ─────────────────────────

/** 任务点容器高度。比视口(800)高，保证同一时刻只有一个是「在视区里的」。 */
const JOB_H = 900;

function jobDiv(extraClass: string, href: string): string {
  return `<div class="ans-attach-ct ${extraClass}" style="height:${JOB_H}px;box-sizing:border-box;border:1px solid #ddd">
            <iframe src="${href}" style="width:800px;height:600px;border:0"></iframe>
          </div>`;
}

/**
 * 混合章节页：视频 / 视频 / 测验 / 文档，四个任务点并列在 DOM 里。
 *
 * 初始一律不打完成标记 —— 完成态由测试用例用 setJobDone 显式驱动，
 * 这样每一步「平台标记了什么、滚到了哪里」在用例里都是可见的。
 */
function chapterHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
    ${jobDiv('videoContainer', '/ananas/modules/video/index.html?objectId=v1')}
    ${jobDiv('videoContainer', '/ananas/modules/video/index.html?objectId=v2')}
    ${jobDiv('workContainer', '/mooc-ans/work/selectWorkQuestionYiPiYue?workId=1')}
    ${jobDiv('docContainer', '/ananas/modules/pdf/index.html?objectId=d1')}
  </body></html>`;
}

/** 任务点容器的选择器（与 jobpoint 的祖先链判定对齐） */
const WRAP_SEL = '[class*="ans-attach-ct"],[class*="ans-job-wrap"]';

/**
 * 模拟平台的 scroll2Job()：滚到**第一个未完成**的任务点。
 *
 * 这是平台自身的语义（也是 index.ts 用来推进章节的依据），
 * 用它驱动测试才能反映真实时序 —— 手写 scrollTo(0, N) 很容易
 * 滚到一个「已完成」的任务点上，测出不存在的问题。
 */
async function scroll2NextJob(page: any): Promise<number> {
  return page.evaluate((sel: string) => {
    const wraps = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
    for (let i = 0; i < wraps.length; i++) {
      if (String(wraps[i].className).indexOf('ans-job-finished') >= 0) continue;
      wraps[i].scrollIntoView();
      return i;
    }
    return -1;
  }, WRAP_SEL);
}

function startServer(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const p = u.pathname;
    if (p === '/') {
      res.end(chapterHtml());
      return;
    }
    // 竞态页：视频 iframe 先创建、2.5s 后才被赋 src；测验 iframe 立即提交。
    // 复现「只看一眼 DOM 就判类型」时会把混合章节误判成测验章。
    if (p === '/race') {
      res.end(`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
        <div class="ans-attach-ct videoContainer" style="height:${JOB_H}px;box-sizing:border-box">
          <iframe id="late" style="width:800px;height:600px;border:0"></iframe>
        </div>
        ${jobDiv('workContainer', '/mooc-ans/work/selectWorkQuestionYiPiYue?workId=1')}
        <script>
          setTimeout(function () {
            document.getElementById('late').src = '/ananas/modules/video/index.html?objectId=v1';
          }, 2500);
        </script>
      </body></html>`);
      return;
    }
    if (p.startsWith('/ananas/modules/video')) {
      res.end('<!doctype html><body style="margin:0"><video style="width:640px;height:360px"></video></body>');
      return;
    }
    if (p.startsWith('/ananas/modules/pdf')) {
      res.end('<!doctype html><body style="margin:0">文档任务点正文</body>');
      return;
    }
    if (p.startsWith('/mooc-ans/work/')) {
      res.end('<!doctype html><body style="margin:0">测验任务点</body>');
      return;
    }
    res.statusCode = 404;
    res.end('404');
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>(r => {
            server.close(() => r());
          }),
      });
    });
  });
}

/** 给第 n 个任务点容器补上 / 去掉完成标记（模拟平台做完后写 ans-job-finished） */
async function setJobDone(page: any, n: number, done: boolean): Promise<void> {
  await page.evaluate(
    (args: { n: number; done: boolean; sel: string }) => {
      const wraps = Array.from(document.querySelectorAll(args.sel)) as HTMLElement[];
      const el = wraps[args.n];
      if (!el) return;
      const cls = String(el.className)
        .split(/\s+/)
        .filter(c => c !== 'ans-job-finished');
      if (args.done) cls.push('ans-job-finished');
      el.className = cls.join(' ');
    },
    { n, done, sel: WRAP_SEL }
  );
}

async function main() {
  // ── 1. URL → 类型（纯函数，先跑，不依赖浏览器）──
  console.log('\n[类型判定：按超星模块 URL]');
  const table: [string, JobKind][] = [
    ['https://mooc1-1.chaoxing.com/ananas/modules/video/index.html?objectId=1', 'video'],
    ['https://mooc1-1.chaoxing.com/ananas/modules/pdf/index.html?objectId=2', 'document'],
    ['https://mooc1-1.chaoxing.com/ananas/modules/document/index.html', 'document'],
    ['https://mooc1-1.chaoxing.com/ananas/modules/doc/index.html', 'document'],
    ['https://mooc1-1.chaoxing.com/mooc-ans/work/selectWorkQuestionYiPiYue?workId=9', 'quiz'],
    ['https://mooc1-1.chaoxing.com/mooc-ans/work/work?courseId=1', 'quiz'],
    ['https://mooc1-1.chaoxing.com/mooc-ans/work/doHomeWorkNew?workId=1', 'quiz'],
    // 课程主页 / 框架页绝不能算任务点（旧实现就是被它骗的）
    ['https://mooc1-1.chaoxing.com/mycourse/studentstudy?chapterId=1&mooc=1', 'unknown'],
    ['https://mooc1-1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=1', 'unknown'],
    ['about:blank', 'unknown'],
  ];
  for (const [url, want] of table) {
    const got = kindOfJobUrl(url);
    check(`${want.padEnd(8)} ← ${url.slice(-46)}`, got === want, `实际 ${got}`);
  }
  check('jobKindLabel 中文标签', jobKindLabel('video') === '视频' && jobKindLabel('document') === '文档', '');

  const srv = await startServer();
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(srv.base + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => window.frames.length >= 4);

    // ── 2. 枚举：4 个并列任务点必须都识别出来 ──
    console.log('\n[枚举任务点：4 个并列任务点必须都识别出来]');
    const jobs = await collectJobFrames(page);
    check('识别到 4 个任务点', jobs.length === 4, `实际 ${jobs.length}`);
    check(
      '类型与次序：视频/视频/测验/文档',
      jobs.map(j => j.kind).join(',') === 'video,video,quiz,document',
      `实际 ${jobs.map(j => j.kind).join(',')}`
    );
    check(
      '初始都未完成',
      jobs.every(j => !j.finished),
      `实际 ${jobs.map(j => j.finished).join(',')}`
    );
    check('第 1 个在视区内（初始滚动位置）', jobs[0].inView === true, `实际 ${jobs[0].inView}`);

    // ── 3. 平台按「完成标记 + 滚到下一个未完成」推进时，活跃类型必须跟着走 ──
    // 这是本次修复的核心断言。旧实现在第 1 轮就会因为 DOM 里有测验 iframe
    // 而返回 quiz —— 第一项即可立刻抓到。
    console.log('\n[活跃任务点推进：视频 → 视频 → 测验 → 文档]');

    await page.evaluate(() => window.scrollTo(0, 0));
    let a = await activeJob(page);
    check('第 1 轮：DOM 里有测验 iframe，但仍先做视频', a.kind === 'video', `实际 ${a.kind}`);
    check('  统计：总数 4，已完成 0', a.total === 4 && a.finished === 0, `实际 total=${a.total} finished=${a.finished}`);

    await setJobDone(page, 0, true);
    check('  第 1 个视频做完（平台写 ans-job-finished）',
      (await jobFrameFinished(jobs[0].frame)) === true, '');
    await scroll2NextJob(page);
    a = await activeJob(page);
    check('第 2 轮：完成第 1 个视频后轮到第 2 个视频（不是测验）', a.kind === 'video', `实际 ${a.kind}`);
    check('  统计：已完成 1', a.finished === 1, `实际 ${a.finished}`);

    await setJobDone(page, 1, true);
    await scroll2NextJob(page);
    a = await activeJob(page);
    check('第 3 轮：两个视频做完后轮到测验', a.kind === 'quiz', `实际 ${a.kind}`);
    check('  统计：已完成 2', a.finished === 2, `实际 ${a.finished}`);

    await setJobDone(page, 2, true);
    await scroll2NextJob(page);
    a = await activeJob(page);
    check('第 4 轮：测验做完后轮到文档', a.kind === 'document', `实际 ${a.kind}`);

    await setJobDone(page, 3, true);
    a = await activeJob(page);
    check('全部完成后返回 unknown（不假装还有活）', a.kind === 'unknown', `实际 ${a.kind}`);
    check('  统计：已完成 = 总数 4', a.finished === a.total && a.total === 4, `实际 ${a.finished}/${a.total}`);

    // ── 4. 平台没给完成标记时，跟着平台的滚动走（别死锁在第一个）──
    console.log('\n[兜底：平台未给 ans-job-finished 时按可视区推进]');
    const page2 = await ctx.newPage();
    await page2.goto(srv.base + '/', { waitUntil: 'load' });
    await page2.waitForFunction(() => window.frames.length >= 4);

    await page2.evaluate(() => window.scrollTo(0, 0));
    a = await activeJob(page2);
    check('滚动在最上面 → 视频', a.kind === 'video', `实际 ${a.kind}`);

    await page2.evaluate((y: number) => window.scrollTo(0, y), JOB_H * 2);
    a = await activeJob(page2);
    check('平台滚到测验任务点 → 判成测验（不被第一个视频锁死）', a.kind === 'quiz', `实际 ${a.kind}`);

    await page2.evaluate((y: number) => window.scrollTo(0, y), JOB_H * 3);
    a = await activeJob(page2);
    check('平台滚到文档任务点 → 判成文档', a.kind === 'document', `实际 ${a.kind}`);

    // ── 5. 竞态：iframe 先创建后导航，提交顺序不保证与 DOM 次序一致 ──
    // 只看得见先提交的测验 iframe 就会把整章误判成测验 —— 同一个 bug
    // 换个触发时机重现。修法是等「目录声明的任务点数」到齐再判。
    console.log('\n[竞态：测验 iframe 先提交、视频 iframe 后提交]');
    const page3 = await ctx.newPage();
    await page3.goto(srv.base + '/race', { waitUntil: 'load' });
    await page3.waitForFunction(() => window.frames.length >= 2);

    const early = await collectJobFrames(page3);
    check('此刻只看得见先提交的测验 iframe', early.length === 1 && early[0].kind === 'quiz',
      `实际 ${early.length} 个：${early.map(j => j.kind).join(',')}`);
    check('只看一眼就判 → 会误判成测验章（旧 bug 的复现点）',
      pickActiveJob(early).kind === 'quiz', `实际 ${pickActiveJob(early).kind}`);

    const settled = await waitForJobFrames(page3, 2, 8000);
    check('等目录声明的 2 个任务点到齐', settled.length === 2,
      `实际 ${settled.length}：${settled.map(j => j.kind).join(',')}`);
    check('落定后类型与次序正确：视频/测验',
      settled.map(j => j.kind).join(',') === 'video,quiz',
      `实际 ${settled.map(j => j.kind).join(',')}`);
    check('落定后当前任务是视频（不再被测验劫持）',
      pickActiveJob(settled).kind === 'video', `实际 ${pickActiveJob(settled).kind}`);

    // 总数读不到时也不能无限等
    const t0 = Date.now();
    await waitForJobFrames(page3, 0, 1200);
    check('wantCount=0 时受 timeout 约束（不会卡死）', Date.now() - t0 < 3000,
      `耗时 ${Date.now() - t0}ms`);
  } finally {
    await browser.close();
    await srv.close();
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('测试异常：', e);
  process.exit(1);
});
