/**
 * 应用级实测：让**真实 ChaoxingEngine.run()** 打「本地仿真的学习通」。
 *
 * ── 为什么还要这一轮 ──
 * 前几轮验证都停在单元层或 DOM 层：白盒调私有方法（pollChapterWatch）、
 * 单独调某个模块（jobpoint / visionSearcher）。它们证明的是「零件对」，
 * 没有证明「装机后整条链路对」——真实链路是：
 *
 *   engine.run(courses, creds, {resume})
 *     → ensureLogin → openCourseChapters → 逐章 clickChapter
 *     → 内层任务点循环 → jobpoint 分派 → 视频/文档/测验
 *     → 记账 markChapterDone → 逐章推进 → task-done
 *
 * 本脚本跑的就是这一条，用桩网关 + 本地仿真平台把外部依赖全部拿掉。
 *
 * ── 假平台怎么假 ──
 * 不搭独立 HTTP 服务、也不改生产代码里的 URL：用 Playwright 的 `context.route`
 * 把 `*.chaoxing.com` 的请求就地兑现。引擎看到的仍是真域名、真 URL 形状，
 * 于是 chapterIdOf / readCurrentChapterId / QUIZ_FRAME_URL / ananas/modules/*
 * 这些正则全部走真代码，只有「服务器返回的字节」是假的。
 *
 * 仿真出来的平台行为（都按真机实测的形状写）：
 *   · 章节目录 chapter_item 带 onclick="toOld(courseId,chapterId,clazzId,0)"
 *     + input.knowledgeJobCount + span.catalog_points_yi
 *   · 一章多任务点：多个知识卡并列，各一个 iframe（video / pdf / work 模块）
 *   · input.jobUnfinishCount 随完成递减 ｜ window.scroll2Job() 跳到下一个未完成
 *   · 任务点做完 → 容器加 ans-job-finished（引擎认这个标记，不是我们告诉它的）
 *   · 测验提交要过确认框（#popok）才出现「提交成功」
 *
 * ── 覆盖本次四个改动 ──
 *   A 混合章节：视频+视频+文档+测验 逐个按类型处理并记账（bac831b）
 *   B 用户中途手动切章节：立刻让位、从手动点开的那一节继续（4c39ada）
 *   C AI 未配置时不静默：自检说清缺什么 + 覆盖率不足不交卷（e45f3e1/33c7c8c）
 *   D 首发就给足输出预算：桩网关收到 max_tokens=16000（0ee746b）
 *
 * 用法：npx tsx scripts/e2e-real-engine.ts [--keep-open]
 */

import { chromium, type BrowserContext, type Page, type Route } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { AddressInfo } from 'node:net';

import { ChaoxingEngine, type EngineOptions } from '../src/main/engine/index';
import type { Course, Credentials, EngineEvent } from '../src/shared/types';

// ═══════════════════════════ 断言工具 ═══════════════════════════

let pass = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** 等日志里出现某个片段（引擎的日志走 emit，等价于界面上那一条） */
async function waitForLog(
  logs: string[],
  needle: string,
  timeoutMs = 60000
): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (logs.some(l => l.includes(needle))) return true;
    await sleep(200);
  }
  return false;
}

// ═══════════════════════════ 假平台 ═══════════════════════════

const HOST = 'https://mooc1-1.chaoxing.com';
const SPACE_HOST = 'https://i.mooc.chaoxing.com';

interface JobSpec {
  id: string;
  kind: 'video' | 'document' | 'quiz';
  /** 视频时长（秒） */
  sec?: number;
}
interface ChapterSpec {
  id: number;
  name: string;
  /** 目录里的待完成数（与 jobs 数一致即可） */
  jobs: JobSpec[];
}
interface CourseSpec {
  courseId: string;
  clazzId: string;
  name: string;
  chapters: ChapterSpec[];
}

/** 平台侧状态：哪些任务点已被标记完成（跨页面 reload 保留，模拟平台记账） */
class MockPlatform {
  readonly finished = new Set<string>();
  /** 任务点模块上报完成的次数（用于断言链路真的走过） */
  readonly reports: string[] = [];
  key(cid: number, jid: string) {
    return `${cid}:${jid}`;
  }
  isDone(cid: number, jid: string) {
    return this.finished.has(this.key(cid, jid));
  }
  markDone(cid: number, jid: string) {
    if (this.isDone(cid, jid)) return;
    this.finished.add(this.key(cid, jid));
    this.reports.push(`${cid}/${jid}`);
  }
  chapterDone(c: ChapterSpec) {
    return c.jobs.filter(j => this.isDone(c.id, j.id)).length;
  }
  courseDone(spec: CourseSpec) {
    return spec.chapters.reduce((n, c) => n + this.chapterDone(c), 0);
  }
  courseTotal(spec: CourseSpec) {
    return spec.chapters.reduce((n, c) => n + c.jobs.length, 0);
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 任务点模块 URL —— 类型必须能从 URL 判出来（jobpoint 的口径） */
function moduleUrl(job: JobSpec, cid: number): string {
  const q = `chapter=${cid}&job=${job.id}`;
  switch (job.kind) {
    case 'video':
      return `/ananas/modules/video/index.html?objectId=${job.id}&${q}`;
    case 'document':
      return `/ananas/modules/pdf/index.html?objectId=${job.id}&${q}`;
    default:
      return `/mooc-ans/work/selectWorkQuestionYiPiYue?workId=${job.id}&${q}`;
  }
}

const KIND_LABEL: Record<JobSpec['kind'], string> = {
  video: '视频',
  document: '文档',
  quiz: '测验',
};

/** 视频任务点：真 <video>（真 WebM，真 ended 事件），播完按平台的方式上报 */
function videoModuleHtml(cid: number, job: JobSpec, dataUri: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#111;color:#eee;font:14px sans-serif}
video{display:block;margin:16px auto;background:#000}
</style></head><body>
<video id="v" src="${dataUri}"></video>
<script>
(function(){
  var v = document.getElementById('v');
  function report(){
    try { parent.platformFinishJob(${cid}, '${job.id}'); } catch (e) {}
  }
  // 真机是「看到九成左右就计入完成」（video.ts 的 VIDEO_DONE_TOLERANCE_SEC
  // 注释记录了这一点），而不是等到片尾。mock 必须照这个来：引擎判定「看完」
  // 用的是 d-5 秒容差，若平台只在 ended 才记账，短任务点上引擎会先读到
  // 「计数没变」——那是 mock 不忠实造出来的假故障，不是产品问题。
  v.addEventListener('timeupdate', function(){
    if (v.duration > 0 && v.currentTime >= v.duration * 0.9) report();
  });
  v.addEventListener('ended', report);
})();
</script>
</body></html>`;
}

/** 文档任务点：可滚动阅读器，滚到底按平台的方式上报 */
function docModuleHtml(cid: number, job: JobSpec): string {
  const paras = Array.from(
    { length: 60 },
    (_, i) => `<p>第 ${i + 1} 段：文档内容占位，用于撑出可滚动区域。</p>`
  ).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;font:14px/1.8 sans-serif}
#doc{height:420px;overflow:auto;padding:12px;border:1px solid #ccc}
</style></head><body>
<div id="doc">${paras}</div>
<script>
(function(){
  var el = document.getElementById('doc');
  var reported = false;
  el.addEventListener('scroll', function(){
    if (reported) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 30) {
      reported = true;
      try { parent.platformFinishJob(${cid}, '${job.id}'); } catch (e) {}
    }
  });
})();
</script>
</body></html>`;
}

/** 测验任务点：3 题（单选/单选/判断），提交要过确认框才算成功 */
function quizModuleHtml(cid: number, job: JobSpec): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:12px;font:14px/1.9 sans-serif}
.TiMu{margin-bottom:18px;padding:10px;border:1px solid #eee}
.Zy_TItle{font-weight:600;margin-bottom:6px}
ul{list-style:none;margin:0;padding:0}
li{padding:4px 8px;cursor:pointer}
.popDiv{margin-top:16px;padding:12px;border:1px solid #bbb;background:#fafafa}
.popDiv a{margin-right:16px;color:#06c;cursor:pointer}
.resultBlock{margin-top:12px;color:#080;font-weight:600}
</style></head><body>
<div class="TiMu newTiMu">
  <div class="Zy_TItle"><span class="newZy_TItle">【单选题】</span>一个章节里可以包含几个任务点？</div>
  <ul>
    <li class="before-after" role="radio">A、只能一个</li>
    <li class="before-after" role="radio">B、可以包含多个</li>
    <li class="before-after" role="radio">C、最多两个</li>
    <li class="before-after" role="radio">D、不确定</li>
  </ul>
</div>
<div class="TiMu newTiMu">
  <div class="Zy_TItle"><span class="newZy_TItle">【单选题】</span>平台上任务点是否计入完成由谁决定？</div>
  <ul>
    <li class="before-after" role="radio">A、由本地客户端决定</li>
    <li class="before-after" role="radio">B、由平台自己决定</li>
    <li class="before-after" role="radio">C、由浏览器决定</li>
    <li class="before-after" role="radio">D、由插件决定</li>
  </ul>
</div>
<div class="TiMu newTiMu">
  <div class="Zy_TItle"><span class="newZy_TItle">【判断题】</span>一章之内可以同时存在视频、文档、测验三类任务点。</div>
  <ul>
    <li class="before-after" role="radio">A、正确</li>
    <li class="before-after" role="radio">B、错误</li>
  </ul>
</div>
<button id="submitBtn">提交</button>
<script>
(function(){
  document.getElementById('submitBtn').addEventListener('click', function(){
    if (document.getElementById('popok')) return;
    var box = document.createElement('div');
    box.className = 'popDiv';
    box.innerHTML = '<a id="popok">提交</a><a id="popno">取消</a>';
    document.body.appendChild(box);
    document.getElementById('popok').addEventListener('click', function(){
      box.remove();
      var r = document.createElement('div');
      r.className = 'resultBlock';
      r.textContent = '提交成功，本次得分 100 分';
      document.body.appendChild(r);
      try { parent.platformFinishJob(${cid}, '${job.id}'); } catch (e) {}
    });
  });
})();
</script>
</body></html>`;
}

/** 侧栏章节目录（studentcourse frame） */
function catalogueHtml(spec: CourseSpec): string {
  const items = spec.chapters
    .map(c => {
      const pending = c.jobs.length;
      return `<div class="chapter_item" onclick="toOld(${spec.courseId}, ${c.id}, ${spec.clazzId}, 0)">
  <span class="chapterName">${esc(c.name)}</span>
  <span class="catalog_points_yi">${pending}</span>
  <input type="hidden" class="knowledgeJobCount" value="${c.jobs.length}">
</div>`;
    })
    .join('\n');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:13px/1.7 sans-serif}
.chapter_item{padding:6px 8px;border-bottom:1px solid #eee;cursor:pointer}
.catalog_points_yi{color:#c60;margin-left:6px}
</style></head><body>
${items}
<script>
// 真机：目录条目在 iframe 里，点击后由父页面的 toOld 打开章节
function toOld(courseId, chapterId, clazzId, idx){
  parent.toOld(courseId, chapterId, clazzId, idx);
}
</script>
</body></html>`;
}

/** 章节页（studentstudy）：多任务点并列 + 平台自己的计数与 scroll2Job */
function studentStudyHtml(spec: CourseSpec, chapter: ChapterSpec, mp: MockPlatform): string {
  const jobs = chapter.jobs
    .map(j => {
      const done = mp.isDone(chapter.id, j.id);
      return `<div class="ans-attach-ct ${j.kind}Container${done ? ' ans-job-finished' : ''}" id="job-${j.id}">
  <div class="ans-job-title">${KIND_LABEL[j.kind]}任务点 ${j.id}${done ? '（平台已标记完成）' : ''}</div>
  <iframe src="${moduleUrl(j, chapter.id)}"></iframe>
</div>`;
    })
    .join('\n');

  const unfinish = chapter.jobs.filter(j => !mp.isDone(chapter.id, j.id)).length;
  const back = `${HOST}/mooc-ans/visit/stucoursemiddle?courseid=${spec.courseId}&clazzid=${spec.clazzId}&vc=1&cpi=1&ismooc2=1&v=2`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:13px/1.7 sans-serif}
.topbar{padding:6px 10px;background:#f6f6f6;border-bottom:1px solid #ddd}
.topbar a{margin-right:14px;color:#06c;cursor:pointer}
.layout{display:flex;align-items:flex-start}
.side{width:320px;flex:none}
.main{flex:1;min-width:0}
.ans-attach-ct{height:1000px;border-bottom:2px dashed #ddd;padding:8px;box-sizing:border-box}
.ans-job-title{color:#666;margin-bottom:6px}
.ans-attach-ct iframe{width:100%;height:940px;border:1px solid #eee}
</style></head><body>
<div class="topbar">
  <a id="backCourse" href="javascript:;" onclick="toMiddle()">返回课程</a>
  <a id="tabChapter" href="javascript:;">章节</a>
</div>
<div class="layout">
  <div class="side"><iframe id="catalog" src="/mycourse/studentcourse?courseId=${spec.courseId}&clazzid=${spec.clazzId}"></iframe></div>
  <div class="main">
${jobs}
  </div>
</div>
<input type="hidden" class="jobUnfinishCount" value="${unfinish}">
<script>
function toMiddle(){ location.href = '${back}'; }

// 平台打开章节：真机就是顶层地址变成 studentstudy?...chapterId=...
function toOld(courseId, chapterId, clazzId, idx){
  location.href = '/mycourse/studentstudy?courseId=' + courseId +
    '&clazzid=' + clazzId + '&chapterId=' + chapterId + '&cpi=1&ismooc2=1';
}

// 任务点模块上报完成（真机由平台在播放器/阅读器里记账）
function platformFinishJob(chapterId, jobId){
  // 平台侧把任务点记成完成（真机由播放器/阅读器在上报）
  var box = document.getElementById('job-' + jobId);
  var already = !!box && String(box.className).indexOf('ans-job-finished') >= 0;
  if (box && !already) {
    box.className = box.className + ' ans-job-finished';
  }
  // ⚠️ 计数只在「首次」上报时减一：同一个任务点被报两次（视频重播后再结束、
  // 阅读器重复触发）不该把待完成数多减一次——那会让引擎误以为整章做完了。
  if (!already) {
    var inputs = document.querySelectorAll('input.jobUnfinishCount');
    for (var i = 0; i < inputs.length; i++) {
      var n = Number(inputs[i].value);
      if (isFinite(n) && n > 0) inputs[i].value = String(n - 1);
    }
  }
  // 让服务端记住，翻页回来时状态还在（真机是平台自己的记账）
  try { fetch('/__mock/finish?chapter=' + chapterId + '&job=' + jobId); } catch (e) {}
}

// 平台自带的「滚到下一个未完成任务点」
function scroll2Job(){
  var boxes = document.querySelectorAll('.ans-attach-ct');
  for (var i = 0; i < boxes.length; i++) {
    if (String(boxes[i].className).indexOf('ans-job-finished') >= 0) continue;
    var y = boxes[i].getBoundingClientRect().top + window.pageYOffset - 8;
    window.scrollTo(0, Math.round(y));
    return true;
  }
  return false;
}
</script>
</body></html>`;
}

/** 课程主页（stucoursemiddle）：目录 + 平台进度 */
function courseHomeHtml(spec: CourseSpec, mp: MockPlatform): string {
  const done = mp.courseDone(spec);
  const total = mp.courseTotal(spec);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:13px/1.7 sans-serif}
.topbar{padding:6px 10px;background:#f6f6f6;border-bottom:1px solid #ddd}
.topbar a{color:#06c;cursor:pointer}
.layout{display:flex;align-items:flex-start}
.side{width:320px;flex:none}
.main{flex:1;padding:16px}
</style></head><body>
<div class="topbar"><a id="tabChapter" href="javascript:;">章节</a><a id="tabTask" href="javascript:;">任务</a></div>
<div class="layout">
  <div class="side"><iframe id="catalog" src="/mycourse/studentcourse?courseId=${spec.courseId}&clazzid=${spec.clazzId}"></iframe></div>
  <div class="main">
    <p>课程：${esc(spec.name)}</p>
    <p>已完成任务点：${done} / ${total}</p>
  </div>
</div>
<script>
function toOld(courseId, chapterId, clazzId, idx){
  location.href = '/mycourse/studentstudy?courseId=' + courseId +
    '&clazzid=' + clazzId + '&chapterId=' + chapterId + '&cpi=1&ismooc2=1';
}
</script>
</body></html>`;
}

/** 学习通空间页（登录态探测用） */
function spaceHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="mySpace">
  <div id="nav_course">我学的课</div>
  <div class="nav_content">课程列表占位</div>
</div>
</body></html>`;
}

/** 把 chaoxing 域下的所有请求就地兑现 */
function installMockRoutes(
  ctx: BrowserContext,
  spec: CourseSpec,
  mp: MockPlatform,
  webm: Record<string, string>
): void {
  ctx.route('**/*', async (route: Route) => {
    const url = route.request().url();
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      await route.continue();
      return;
    }
    if (!/(^|\.)chaoxing\.com$/.test(u.hostname)) {
      await route.continue();
      return;
    }

    const html = (body: string) =>
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });

    const p = u.pathname;
    const cid = Number(u.searchParams.get('chapter'));
    const jid = u.searchParams.get('job') || '';

    // ── 任务点模块 ──
    if (p.startsWith('/ananas/modules/video')) {
      const job = findJob(spec, cid, jid);
      const sec = job?.sec ?? 8;
      return html(videoModuleHtml(cid, job ?? { id: jid, kind: 'video' }, webm[String(sec)]));
    }
    if (p.startsWith('/ananas/modules/pdf') || p.startsWith('/ananas/modules/doc')) {
      return html(docModuleHtml(cid, { id: jid, kind: 'document' }));
    }
    if (p.includes('selectWorkQuestion') || /\/work\//.test(p)) {
      return html(quizModuleHtml(cid, { id: jid, kind: 'quiz' }));
    }

    // ── 平台记账回调（模块上报完成） ──
    if (p === '/__mock/finish') {
      mp.markDone(cid, u.searchParams.get('job') || '');
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }

    // ── 章节目录 frame ──
    if (p.includes('/mycourse/studentcourse')) return html(catalogueHtml(spec));

    // ── 章节页 ──
    // ⚠️ 这里的 query 参数是 chapterId（studentstudy 的地址格式），不是任务点
    // 模块用的 chapter。曾经写错一处，导致「点了第二章仍然渲染第一章」，
    // 排查时看起来像引擎的章节推进坏了——所以找不到章节要**响亮地失败**。
    if (p.includes('/mycourse/studentstudy')) {
      const sid = Number(u.searchParams.get('chapterId'));
      const chapter = spec.chapters.find(c => c.id === sid);
      if (!chapter) {
        return html(
          `<!doctype html><html><body>mock: 未知章节 chapterId=${esc(String(sid))}` +
            `（本课只有 ${spec.chapters.map(c => c.id).join('/')}）</body></html>`
        );
      }
      return html(studentStudyHtml(spec, chapter, mp));
    }

    // ── 课程主页 ──
    if (p.includes('stucoursemiddle')) return html(courseHomeHtml(spec, mp));

    // ── 空间页（登录态） ──
    if (u.hostname.startsWith('i.mooc')) return html(spaceHtml());

    return html('<!doctype html><html><body>mock: ' + esc(p) + '</body></html>');
  });
}

function findJob(spec: CourseSpec, cid: number, jid: string): JobSpec | undefined {
  return spec.chapters.find(c => c.id === cid)?.jobs.find(j => j.id === jid);
}

// ═══════════════════════════ 桩 AI 网关 ═══════════════════════════

interface GatewayHit {
  path: string;
  model: string;
  maxTokens: number | null;
  temperature: unknown;
  questionCount: number;
}

/**
 * OpenAI 兼容的桩网关。
 * 从提示词里读题号与题型，给出「全对」的答案 —— 目的是让覆盖率闸门放行、
 * 把交卷链路走通，同时**记录引擎实际发来的预算**（max_tokens）。
 */
async function startGateway(): Promise<{
  baseUrl: string;
  hits: GatewayHit[];
  close: () => Promise<void>;
}> {
  const hits: GatewayHit[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      let payload: any = {};
      try {
        payload = JSON.parse(body || '{}');
      } catch {}
      const userMsg = String(payload?.messages?.[1]?.content ?? '');
      const qs: Array<{ i: number; kind: string }> = [];
      const re = /第(\d+)题 \[(单选|多选|判断|填空)\]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(userMsg)) !== null) qs.push({ i: Number(m[1]), kind: m[2] });

      hits.push({
        path: req.url || '',
        model: String(payload?.model ?? ''),
        maxTokens: typeof payload?.max_tokens === 'number' ? payload.max_tokens : null,
        temperature: payload?.temperature,
        questionCount: qs.length,
      });

      const answers = qs.map(q => ({
        i: q.i,
        answer: q.kind === '判断' ? '对' : q.kind === '多选' ? 'AB' : q.kind === '填空' ? '答案' : 'B',
        note: 'e2e stub',
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'e2e-stub',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: JSON.stringify(answers) },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        })
      );
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>(r => {
        server.close(() => r());
      }),
  };
}

// ═══════════════════════════ 素材：真 WebM ═══════════════════════════

/**
 * 用 ffmpeg 造真视频（VP8/WebM —— Playwright 的 Chromium 不带 H.264 专有编解码）。
 * 真播放才有真的 ended 事件与真的 duration，比给 <video> 打属性桩可信。
 * 时长必须 > 5s：video.ts 的完成容差是 5s，比容差还短的视频一进 markTargetVideo
 * 就被当成「已播完」直接跳过（真机行为，不是 mock 的问题）。
 */
function ensureWebm(sec: number): string {
  const dir = path.join(process.cwd(), '.e2e');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `clip-${sec}s.webm`);
  if (!fs.existsSync(file) || fs.statSync(file).size < 500) {
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=0x224466:s=320x180:r=10:d=${sec}`,
        '-c:v',
        'libvpx',
        '-b:v',
        '80k',
        '-an',
        file,
      ],
      { stdio: 'ignore' }
    );
  }
  return `data:video/webm;base64,${fs.readFileSync(file).toString('base64')}`;
}

// ═══════════════════════════ 跑一轮引擎 ═══════════════════════════

interface RunResult {
  events: EngineEvent[];
  logs: string[];
  chapters: Array<{ name: string; result: string }>;
  summary: { completed: number; skipped: number };
  progressFile: string;
  dataDir: string;
}

interface RunSetup {
  spec: CourseSpec;
  mp: MockPlatform;
  webm: Record<string, string>;
  getVision: () => { baseUrl: string; apiKey: string; model: string };
  agentEnabled?: boolean;
  resume?: boolean;
  /** 运行中要做的事（例如模拟用户点侧栏切章节） */
  duringRun?: (ctx: { page: Page; logs: string[]; engine: ChaoxingEngine }) => Promise<void>;
}

async function runEngine(browserCtx: BrowserContext, setup: RunSetup): Promise<RunResult> {
  const page = await browserCtx.newPage();
  installMockRoutes(browserCtx, setup.spec, setup.mp, setup.webm);

  const dataDir = mkdtempSync(path.join(tmpdir(), 'ch-e2e-'));
  const events: EngineEvent[] = [];
  const logs: string[] = [];

  const opts: EngineOptions = {
    page,
    dataDir,
    emit: e => {
      events.push(e);
      if (e.type === 'log') logs.push(e.msg);
    },
    getVideoSpeed: () => 2,
    getMuted: () => true,
    getAgentEnabled: () => setup.agentEnabled !== false,
    getVision: setup.getVision,
    getSubmitCoverRate: () => 0.8,
    getAnswerPopup: () => false,
    getAutoPauseOnVerify: () => false,
  };

  const engine = new ChaoxingEngine(opts);
  const creds: Credentials = { username: '13800000000', password: 'e2e' };
  const course: Course = {
    index: 1,
    name: setup.spec.name,
    courseId: setup.spec.courseId,
    url:
      `${HOST}/mooc-ans/visit/stucoursemiddle?courseid=${setup.spec.courseId}` +
      `&clazzid=${setup.spec.clazzId}&vc=1&cpi=1&ismooc2=1&v=2`,
  };

  const during = setup.duringRun
    ? setup.duringRun({ page, logs, engine }).catch(e => {
        console.log(`  ⚠ duringRun 异常：${String(e?.message || e)}`);
      })
    : Promise.resolve();

  const summary = await engine.run([course], creds, { resume: !!setup.resume });
  await during;
  await page.close();

  return {
    events,
    logs,
    chapters: events
      .filter((e): e is Extract<EngineEvent, { type: 'chapter' }> => e.type === 'chapter')
      .map(e => ({ name: e.name, result: e.result })),
    summary,
    progressFile: path.join(dataDir, `${setup.spec.courseId}.json`),
    dataDir,
  };
}

/** 读回进度文件（ProgressStore 按 courseId 命名：<数据目录>/<courseId>.json） */
function readProgress(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/** 从进度 JSON 里把任意层级的 completedChapters 挖出来（结构可能随版本变化） */
function collectCompleted(node: unknown, out: string[] = []): string[] {
  if (!node || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'completedChapters' && Array.isArray(v)) {
      for (const s of v) if (typeof s === 'string') out.push(s);
    } else if (typeof v === 'object') {
      collectCompleted(v, out);
    }
  }
  return out;
}

// ═══════════════════════════ 场景 ═══════════════════════════

const CH1: ChapterSpec = {
  id: 2001,
  name: '第一章 混合任务点',
  jobs: [
    { id: 'v1', kind: 'video', sec: 8 },
    // 第二个视频故意长一些：同页两个视频时，各自的保活 ticker 会各自播放，
    // 8s 的两个会在同一轮里先后播完，轮次就不确定了。用 40s 把「引擎自己
    // 一轮一轮往下推」这条路径钉死（这正是用户反馈「一章多个任务点」的核心）。
    { id: 'v2', kind: 'video', sec: 40 },
    { id: 'd1', kind: 'document' },
    { id: 'q1', kind: 'quiz' },
  ],
};
const CH2: ChapterSpec = { id: 2002, name: '第二章 单个视频', jobs: [{ id: 'v3', kind: 'video', sec: 8 }] };
const COURSE_A: CourseSpec = {
  courseId: '111',
  clazzId: '222',
  name: 'E2E 混合章节课',
  chapters: [CH1, CH2],
};

async function scenarioA(browserCtx: BrowserContext, gwBase: string, webm: Record<string, string>) {
  console.log('\n【场景 A】混合章节：视频+视频+文档+测验，逐个按类型处理并记账');
  const mp = new MockPlatform();
  const r = await runEngine(browserCtx, {
    spec: COURSE_A,
    mp,
    webm,
    getVision: () => ({ baseUrl: gwBase, apiKey: 'sk-e2e', model: 'e2e-stub' }),
  });

  check('复用已有登录会话（不再走一次表单登录）', r.logs.some(l => l.includes('已处于登录状态')), dumpLogs(r.logs));
  check(
    'AI 通道自检：就绪（单一通道）',
    r.logs.some(l => l.includes('AI 通道自检：就绪')),
    dumpLogs(r.logs)
  );
  check('读到 2 个章节（目录解析正常）', r.logs.some(l => l.includes('找到 2 个任务点')), dumpLogs(r.logs));
  check(
    '第一章识别为 4 个任务点',
    r.logs.some(l => l.includes('本章共 4 个任务点')),
    dumpLogs(r.logs)
  );
  check('第 1 轮先做视频（不被同页测验 iframe 劫持）', r.logs.some(l => l.includes('当前是视频')), dumpLogs(r.logs));

  // 只看第一章那一段的日志：第二章也有一个 8s 视频，不能混进来数
  const ch1Logs = (() => {
    const i = r.logs.findIndex(l => l.includes('[2/2]'));
    return (i < 0 ? r.logs : r.logs.slice(0, i)).join('\n');
  })();
  const v8 = (ch1Logs.match(/✓ 视频: 8s/g) || []).length;
  check('第 1 个视频播完并记账（8s）', v8 === 1, `第一章出现 ${v8} 次 "✓ 视频: 8s"`);
  check(
    '第 2 轮自己接着做第 2 个视频（40s）——不是卡在第一个反复播',
    ch1Logs.includes('✓ 视频: 40s') && v8 === 1,
    `8s 出现 ${v8} 次，40s ${ch1Logs.includes('✓ 视频: 40s') ? '有' : '无'}`
  );
  check('第三个任务点被识别为文档', r.logs.some(l => l.includes('检测到可滚动文档')), dumpLogs(r.logs));
  check('文档任务点被平台记为完成', r.logs.some(l => l.includes('✓ 文档任务点完成')), dumpLogs(r.logs));
  check('第四个任务点被识别为测验并作答', r.logs.some(l => l.includes('✓ 答题完成')), dumpLogs(r.logs));
  check('测验解析出 3 题', r.logs.some(l => l.includes('解析出 3 题')), dumpLogs(r.logs));
  check('覆盖率闸门放行（3/3）', /答案覆盖 3\/3/.test(r.logs.join('\n')), dumpLogs(r.logs));
  check('第一章任务点全部完成', r.logs.some(l => l.includes('本章任务点已全部完成')), dumpLogs(r.logs));

  console.log(`  章节事件：${r.chapters.map(c => `${c.name}=${c.result}`).join(' | ')}`);
  check(
    '第一章四轮的类型分派依次是 视频/视频/文档/测验',
    r.chapters.slice(0, 4).map(c => c.result).join(',') === 'completed,completed,doc_done,quiz_ok',
    r.chapters.map(c => c.result).join(',')
  );
  check('第二章自动接着处理', r.chapters[4]?.name.includes('第二章') && r.chapters[4]?.result === 'completed', JSON.stringify(r.chapters));
  check('汇总：完成 5 个', r.summary.completed === 5, JSON.stringify(r.summary));
  check('平台侧 5 个任务点全部记账', mp.finished.size === 5, [...mp.finished].join(','));

  const prog = readProgress(r.progressFile);
  const done = collectCompleted(prog);
  check('进度写盘：两章都记为完成', done.length === 2, JSON.stringify(done));

  // AI 预算（D）
  return r;
}

async function scenarioB(browserCtx: BrowserContext, gwBase: string, webm: Record<string, string>) {
  console.log('\n【场景 B】用户中途手动切章节：让位并从手动点开的那一节继续');
  const spec: CourseSpec = {
    courseId: '111',
    clazzId: '222',
    name: 'E2E 手动切章节课',
    chapters: [
      { id: 2001, name: '第一章 长视频', jobs: [{ id: 'v1', kind: 'video', sec: 40 }] },
      { id: 2002, name: '第二章 视频', jobs: [{ id: 'v2', kind: 'video', sec: 8 }] },
      { id: 2003, name: '第三章 视频', jobs: [{ id: 'v3', kind: 'video', sec: 8 }] },
      { id: 2004, name: '第四章 视频', jobs: [{ id: 'v4', kind: 'video', sec: 8 }] },
    ],
  };
  const mp = new MockPlatform();

  const r = await runEngine(browserCtx, {
    spec,
    mp,
    webm,
    getVision: () => ({ baseUrl: gwBase, apiKey: 'sk-e2e', model: 'e2e-stub' }),
    duringRun: async ({ page, logs }) => {
      // 等第一章的视频真的开始播，再模拟「用户点侧栏目录切到第三章」
      await waitForLog(logs, '✓ 视频: 40s', 60000);
      await sleep(1500);
      const cat = page.frames().find(f => f.url().includes('studentcourse'));
      if (!cat) {
        console.log('  ⚠ 找不到章节目录 frame，无法模拟手动切章');
        return;
      }
      console.log('  · 模拟用户点击侧栏目录「第三章 视频」');
      await cat.click('[onclick="toOld(111, 2003, 222, 0)"]');
    },
  });

  console.log(`  章节事件：${r.chapters.map(c => `${c.name}=${c.result}`).join(' | ')}`);
  check('检测到用户切走了本节', r.chapters[0]?.result === 'user_switched', JSON.stringify(r.chapters));
  check(
    '日志点名切到了哪一节、并说明会从这一节继续',
    r.logs.some(l => l.includes('第三章') && l.includes('从这一节重新开始')),
    dumpLogs(r.logs)
  );
  check('保留用户已打开的那一页，不再点目录把他拽回去', r.logs.some(l => l.includes('已在你手动打开的这一节')), dumpLogs(r.logs));
  check(
    '从第三章继续往后处理',
    r.chapters.slice(1).map(c => c.name.slice(0, 3)).join(',') === '第三章,第四章',
    JSON.stringify(r.chapters)
  );
  check('第三、四章都完成', r.chapters.slice(1).every(c => c.result === 'completed'), JSON.stringify(r.chapters));
  check('前面的第二章本轮不回头处理（从手动那一节开始）', !r.chapters.some(c => c.name.includes('第二章')), JSON.stringify(r.chapters));

  const done = collectCompleted(readProgress(r.progressFile));
  check('被切走的第一章没有记账（不虚增完成数）', !done.some(s => s.includes('2001')), JSON.stringify(done));
  check('实际做完的第三、四章都记上了', done.some(s => s.includes('2003')) && done.some(s => s.includes('2004')), JSON.stringify(done));
  check('平台侧只完成 2 个任务点（第三、四章）', mp.finished.size === 2, [...mp.finished].join(','));
  return r;
}

async function scenarioC(browserCtx: BrowserContext, webm: Record<string, string>) {
  console.log('\n【场景 C】AI 未配置：不静默，明说缺什么，覆盖率不足不交卷');
  const spec: CourseSpec = {
    courseId: '111',
    clazzId: '222',
    name: 'E2E 未配置 AI',
    chapters: [{ id: 2001, name: '第一章 测验', jobs: [{ id: 'q1', kind: 'quiz' }] }],
  };
  const mp = new MockPlatform();
  const r = await runEngine(browserCtx, {
    spec,
    mp,
    webm,
    // key 与地址都没填 —— 用户最常见的「配了却没生效」现场
    getVision: () => ({ baseUrl: '', apiKey: '', model: '' }),
  });

  check(
    '自检明确说清两个输入框都缺',
    r.logs.some(l => l.includes('AI 通道自检：未配置') && l.includes('API Key') && l.includes('接口地址')),
    dumpLogs(r.logs)
  );
  check('答题前再亮一次「未配置 AI 接口」', r.logs.some(l => l.includes('未配置 AI 接口')), dumpLogs(r.logs));
  check('覆盖率 0% 且闸门不放行', r.logs.some(l => l.includes('覆盖率不足')), dumpLogs(r.logs));
  check('章节结果如实记为 quiz_skip（不是静默成功）', r.chapters[0]?.result === 'quiz_skip', JSON.stringify(r.chapters));
  check('未配置时不上报完成', mp.finished.size === 0, [...mp.finished].join(','));
  return r;
}

function dumpLogs(logs: string[], max = 10): string {
  return '\n      实际日志尾部：\n' + logs.slice(-max).map(l => '        ' + l).join('\n');
}

// ═══════════════════════════ 入口 ═══════════════════════════

async function main() {
  const webm = {
    '8': ensureWebm(8),
    '40': ensureWebm(40),
  };
  console.log(`素材就绪：WebM ${Object.keys(webm).join('s / ')}s`);

  const gw = await startGateway();
  console.log(`桩网关：${gw.baseUrl}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });

  let a: RunResult | null = null;
  try {
    const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    a = await scenarioA(ctxA, gw.baseUrl, webm);
    await ctxA.close();

    const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await scenarioB(ctxB, gw.baseUrl, webm);
    await ctxB.close();

    const ctxC = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await scenarioC(ctxC, webm);
    await ctxC.close();
  } finally {
    await browser.close();
    await gw.close();
  }

  // ── 场景 D：AI 预算（在 A 的真实运行中采集，不另跑一遍） ──
  console.log('\n【场景 D】首发就给足输出预算（桩网关实际收到的参数）');
  check('答题确实调用了 AI（桩网关收到请求）', gw.hits.length >= 1, `实际 ${gw.hits.length} 次`);
  check('提示词里带了题目（3 题）', gw.hits.some(h => h.questionCount === 3), JSON.stringify(gw.hits));
  check(
    '首发 max_tokens = 16000（不再从 800 往上爬）',
    gw.hits[0]?.maxTokens === 16000,
    `实际 ${gw.hits[0]?.maxTokens}`
  );
  check('请求打到 /chat/completions 且带上了模型名', gw.hits[0]?.path === '/chat/completions' && gw.hits[0]?.model === 'e2e-stub', JSON.stringify(gw.hits[0]));
  check('只有一轮请求（没有「饿一次再补」的重试）', gw.hits.length === 1, `实际 ${gw.hits.length} 次：${JSON.stringify(gw.hits.map(h => h.maxTokens))}`);

  if (a) {
    console.log('\n──── 场景 A 完整日志（可当人工回归的对照）────');
    for (const l of a.logs) console.log('    ' + l.trimEnd());
  }

  console.log(`\n结论：${pass} 项通过，${failures.length} 项失败`);
  if (failures.length) {
    console.log('失败项：\n' + failures.map(f => '  - ' + f).join('\n'));
    process.exitCode = 1;
  }
}

main().catch(e => {
  console.error('E2E 异常：', e);
  process.exitCode = 1;
});
