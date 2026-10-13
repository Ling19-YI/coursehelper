/**
 * 「用户中途手动切换章节 → 从手动点的这一节重新开始」的运行时验证。
 *
 * 分两段：
 *   A. 真实浏览器：readCurrentChapterId 只认顶层地址里的 chapterId，
 *      不会被「返回课程后残留的旧内容 iframe」带偏（那会把上一节判成
 *      「用户切走了」，来回弹跳）。
 *   B. 用桩页面驱动真实引擎的跟随开关：正例命中、反例一律不动手、
 *      命中只报一次、收尾后定时器真的停了。
 *
 * 不登录、不碰超星：A 段起本地 HTTP 服务，B 段连页面都是假的。
 * 真机端到端（真的点侧栏目录）仍需在本地过一次。
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { chromium } from 'playwright';
import type { Chapter } from '../src/main/engine/chaoxing';
import { readCurrentChapterId, chapterIdOf } from '../src/main/engine/chaoxing';
import { ChaoxingEngine, type EngineOptions } from '../src/main/engine/index';
import type { CourseProgress } from '../src/shared/types';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** 页面：顶层没有 chapterId，但内部 iframe 带着「上一节」的 chapterId */
function pageHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
    <h1>课程页</h1>
    <iframe id="content" src="/content?chapterId=1001&courseId=99"></iframe>
  </body></html>`;
}

async function partA() {
  console.log('\n[A. 真实浏览器：只认顶层地址]');
  const srv: Server = createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (u.pathname === '/content') {
      res.end('<!doctype html><html><body>任务点</body></html>');
      return;
    }
    res.end(pageHtml());
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();

  // 顶层带 chapterId → 取到
  await page.goto(`${base}/?chapterId=2002`, { waitUntil: 'load' });
  check('顶层 ?chapterId=2002 → 2002', readCurrentChapterId(page) === '2002', `实际 ${readCurrentChapterId(page)}`);

  // 顶层没有、内部 iframe 有 → 必须是 null（不能被残留 iframe 带偏）
  await page.goto(`${base}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.frames.length >= 1);
  check(
    '顶层无 chapterId、iframe 有 → null（不吃残留 iframe 的 id）',
    readCurrentChapterId(page) === null,
    `实际 ${readCurrentChapterId(page)}（读到就说明会拿上一节的 id 判「切走了」）`
  );

  // 顶层带着别的参数 → 仍能取到
  await page.goto(`${base}/?courseId=99&chapterId=2004&cpi=1`, { waitUntil: 'load' });
  check('夹杂其他参数 → 2004', readCurrentChapterId(page) === '2004', `实际 ${readCurrentChapterId(page)}`);

  // 切到别的章节（平台就是这么换的：换掉顶层地址）
  await page.goto(`${base}/?chapterId=2003`, { waitUntil: 'load' });
  check('切到 2003 → 2003', readCurrentChapterId(page) === '2003', `实际 ${readCurrentChapterId(page)}`);

  await browser.close();
  await new Promise<void>(r => srv.close(() => r()));
}

// ── B. 桩页面驱动真实引擎 ──
const mkChapter = (name: string, chapterId: number): Chapter => ({
  name,
  onclick: `toOld(999999, ${chapterId}, 777, 0)`,
  isCompleted: false,
  jobCount: 1,
  pendingCount: 1,
});

/** 桩页面：只需要 url() / $() / frames()，引擎在测试路径上用到的就这三个 */
function mkEngine(logs: string[], getUrl: () => string) {
  const opts: EngineOptions = {
    page: {
      url: getUrl,
      $: async () => null,
      frames: () => [],
    } as unknown as EngineOptions['page'],
    dataDir: mkdtempSync(path.join(tmpdir(), 'ch-manual-')),
    emit: e => {
      if (e.type === 'log') logs.push(e.msg);
    },
    getVideoSpeed: () => 1,
    getMuted: () => true,
    getAgentEnabled: () => false,
    getVision: () => ({ baseUrl: '', apiKey: '', model: '' }),
    getSubmitCoverRate: () => 0.8,
    getAnswerPopup: () => false,
    getAutoPauseOnVerify: () => false,
  };
  return new ChaoxingEngine(opts) as unknown as {
    startChapterWatch(c: Chapter[]): void;
    pollChapterWatch(): void;
    resetChapterWatch(): void;
    takeManualJump(
      chapters: Chapter[],
      resume: boolean,
      progress: CourseProgress | null
    ): Promise<number | null>;
    expectedChapterOnclick: string;
    preopenedOnclick: string;
    manualJumpIndex: number;
    hooks: { chapterLeft(): boolean };
  };
}

async function partB() {
  console.log('\n[B. 引擎跟随开关（桩页面）]');
  const chapters: Chapter[] = [
    mkChapter('第一节', 2001),
    mkChapter('第二节', 2002),
    mkChapter('第三节', 2003),
    mkChapter('第四节', 2004),
  ];

  let url = 'https://mooc1-1.chaoxing.com/mycourse/studentstudy?courseId=99&chapterId=2001';
  const logs: string[] = [];

  // 白盒：直接驱动私有的跟进逻辑，避免每条断言都等一个 3s 轮询周期
  const eng = mkEngine(logs, () => url);

  check('chapterIdOf 能从合成 onclick 取到 id', chapterIdOf(chapters[1].onclick) === '2002');

  eng.startChapterWatch(chapters);
  eng.expectedChapterOnclick = chapters[0].onclick; // 模拟「已进入第一节」

  // 1) 还在本章 → 不动
  logs.length = 0;
  eng.pollChapterWatch();
  check('仍在第一节 → 不触发', eng.manualJumpIndex === -1 && eng.hooks.chapterLeft() === false);
  check('  且没有多余日志', logs.length === 0, `实际 ${logs.length} 条`);

  // 2) 不在章节页（课程主页 / 两章之间）→ 不动
  url = 'https://mooc1-1.chaoxing.com/mooc-ans/visit/stucoursemiddle?courseid=99&clazzid=1';
  eng.pollChapterWatch();
  check('地址栏没有 chapterId → 不触发', eng.manualJumpIndex === -1, `实际 ${eng.manualJumpIndex}`);

  // 3) 目录里没有这个 id（换了门课 / 平台用了别的 id）→ 不动
  url = 'https://mooc1-1.chaoxing.com/mycourse/studentstudy?chapterId=9999';
  eng.pollChapterWatch();
  check('chapterId 对不上任何一节 → 不触发', eng.manualJumpIndex === -1, `实际 ${eng.manualJumpIndex}`);

  // 4) 本章 id 取不到（目录条目不是 toOld 格式）→ 没有基准，不判
  eng.expectedChapterOnclick = 'void(0)';
  url = 'https://mooc1-1.chaoxing.com/mycourse/studentstudy?chapterId=2003';
  eng.pollChapterWatch();
  check('本章 onclick 取不到 id → 不触发', eng.manualJumpIndex === -1, `实际 ${eng.manualJumpIndex}`);

  // 5) 正例：用户点开了第三节
  eng.expectedChapterOnclick = chapters[0].onclick;
  logs.length = 0;
  eng.pollChapterWatch();
  check('切到第三节 → 记下下标 2', eng.manualJumpIndex === 2, `实际 ${eng.manualJumpIndex}`);
  check('  ← 长循环能读到让位信号', eng.hooks.chapterLeft() === true);
  check(
    '  日志点名是哪一节、并说明会从这一节继续',
    logs.some(m => m.includes('第三节') && m.includes('从这一节重新开始')),
    `实际 ${JSON.stringify(logs)}`
  );

  // 6) 命中后不再重复报
  logs.length = 0;
  eng.pollChapterWatch();
  eng.pollChapterWatch();
  check('已记下结果 → 不再重复判定/刷屏', logs.length === 0 && eng.manualJumpIndex === 2);

  // 7) 定时器真的在跑（正例）+ 收尾后真的停了
  url = 'https://mooc1-1.chaoxing.com/mycourse/studentstudy?chapterId=2001';
  eng.resetChapterWatch();
  eng.startChapterWatch(chapters);
  eng.expectedChapterOnclick = chapters[0].onclick;
  url = 'https://mooc1-1.chaoxing.com/mycourse/studentstudy?chapterId=2004'; // 用户切到第四节
  const t0 = Date.now();
  while (Date.now() - t0 < 6000 && eng.manualJumpIndex < 0) await sleep(150);
  check('定时器在跑：≤6s 内自动发现切到第四节', eng.manualJumpIndex === 3, `实际 ${eng.manualJumpIndex}`);

  eng.resetChapterWatch();
  check('resetChapterWatch 后标记归零', eng.manualJumpIndex === -1 && eng.hooks.chapterLeft() === false);
  logs.length = 0;
  url = 'https://mooc1-1.chaoxing.com/mycourse/studentstudy?chapterId=2002';
  await sleep(3500);
  check('resetChapterWatch 后定时器已停（不再读页面）', eng.manualJumpIndex === -1 && logs.length === 0);

  // ── 8. 让位本身：从哪一节继续、要不要点目录 ──
  console.log('\n[B2. 让位：从他点开的那一节继续]');
  const mkProgress = (done: string[]): CourseProgress => ({
    courseId: '99',
    courseName: '测试课',
    completedChapters: done,
    lastChapter: '',
    updatedAt: Date.now(),
  });
  const jumpUrl = (id: number) => `https://mooc1-1.chaoxing.com/mycourse/studentstudy?chapterId=${id}`;

  // 8a) 页面确实就在他点的那一节 → 保留这一页，下一轮不再点目录
  logs.length = 0;
  url = jumpUrl(2003);
  eng.manualJumpIndex = 2;
  const to1 = await eng.takeManualJump(chapters, true, mkProgress([]));
  check('页面就在那一节 → 交出下标 2', to1 === 2, `实际 ${to1}`);
  check('  标记为「已打开」，下一轮不点目录', eng.preopenedOnclick === chapters[2].onclick);
  check('  日志说明会保留他这一页', logs.some(m => m.includes('不再点目录')), `${JSON.stringify(logs)}`);
  check('  让位信号已清零（不重复触发）', eng.manualJumpIndex === -1);

  // 8b) 页面已经不在那一节（我们自己的导航把它带走了）→ 回目录，下一轮正常点
  logs.length = 0;
  url = 'https://mooc1-1.chaoxing.com/mooc-ans/visit/stucoursemiddle?courseid=99';
  eng.manualJumpIndex = 2;
  const to2 = await eng.takeManualJump(chapters, true, mkProgress([]));
  check('页面不在了 → 仍交出下标 2', to2 === 2, `实际 ${to2}`);
  check('  不假装「已打开」（否则会在错页面上按这一节记账）', eng.preopenedOnclick === '');
  check('  回目录重新进入', logs.some(m => m.includes('回到目录')), `${JSON.stringify(logs)}`);

  // 8c) 他点的那一节本地已记完成 → 跳过它，但必须先回目录（否则后面每节都进不去）
  logs.length = 0;
  url = jumpUrl(2003);
  eng.manualJumpIndex = 2;
  const to3 = await eng.takeManualJump(chapters, true, mkProgress([chapters[2].onclick]));
  check('目标节已完成 → 仍交出下标 2（下一轮会跳过它）', to3 === 2, `实际 ${to3}`);
  check('  不标「已打开」（跳过之后要用目录）', eng.preopenedOnclick === '');
  check(
    '  日志如实说明是「已记完成、跳过」而不是花屏',
    logs.some(m => m.includes('本地已记完成') && m.includes('跳过')),
    `${JSON.stringify(logs)}`
  );

  // 8d) 没发生切换 → 不动任何东西
  eng.manualJumpIndex = -1;
  eng.preopenedOnclick = '';
  logs.length = 0;
  const to4 = await eng.takeManualJump(chapters, true, mkProgress([]));
  check('没有手动切换 → 返回 null 且不动作', to4 === null && eng.preopenedOnclick === '' && logs.length === 0);
}

async function main() {
  await partA();
  await partB();
  if (failed) {
    console.error(`\n${failed} 项断言失败`);
    process.exit(1);
  }
  console.log('\n全部通过');
}

main().catch(e => {
  console.error('测试失败：', e);
  process.exit(1);
});
