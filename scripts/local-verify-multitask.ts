/**
 * 实机验证：同一章节内多个任务点是否都能刷完。
 *
 * 针对用户反馈的 bug——「一个章节里出了多个视频（包含多个任务点），
 * 只会完成第一个任务点，不会接着完成下面的」。
 *
 * 做法：直接驱动修过的几个函数（findChapterFrame 经由 getChapters /
 * clickChapter / goBackToCourse），只跑指定章节（默认 1.2）下的任务点，
 * 逐个点击→播放→返回，观察第二个及以后的任务点是否也能进去并完成。
 *
 * 关键诊断：每次点击前打印 frames 列表与被选中的 frame，
 * 直接证明「返回课程后 frame 下标会不会变」这个根因。
 *
 * 用法：
 *   node scripts/local-verify-multitask.ts                  # 默认计算机图形学 / 1.2
 *   node scripts/local-verify-multitask.ts --course 图形 --section 1.2
 *   node scripts/local-verify-multitask.ts --speed 2
 */

import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TaskControl } from '../src/main/engine/control';
import {
  login,
  getCourses,
  openCourseChapters,
  getChapters,
  clickChapter,
  goBackToCourse,
  type Chapter,
} from '../src/main/engine/chaoxing';
import { isQuizPage } from '../src/main/engine/quiz';
import { waitForVideo, waitForVideoEnd } from '../src/main/engine/video';
import type { EngineHooks } from '../src/main/engine/hooks';

const LEGACY_DIR = 'C:\\Users\\colorful\\Documents\\Default Project\\-';
const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
];

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const COURSE_KEY = arg('course', '图形');
const SECTION = arg('section', '1.2');
const SPEED = Number(arg('speed', '2'));
const LIST_ONLY = process.argv.includes('--list-only');

const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

async function main() {
  const creds = JSON.parse(fs.readFileSync(path.join(LEGACY_DIR, 'credentials.json'), 'utf-8'));
  const dataDir = path.resolve('test-data');
  fs.mkdirSync(dataDir, { recursive: true });

  const browser = await chromium.launch({ headless: false, args: LAUNCH_ARGS });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const ctl = new TaskControl();
  ctl.reset();

  const hooks: EngineHooks = {
    ctl,
    log: (lvl, msg) => log(`[${lvl}] ${msg}`),
    onTick: () => {},
    diag: async () => null,
    speed: () => SPEED,
    muted: () => true,
    agentEnabled: () => false,
    vision: () => ({ baseUrl: '', apiKey: '', model: '' }),
    answerPopup: () => false,
    visionChannel: () => null,
    deepseekKey: () => '',
    deepseekBaseUrl: () => '',
    deepseekModel: () => '',
    tiku: () => null,
    submitCoverRate: () => 0.8,
  };

  /** 打印当前 frames 与被选中的目录 frame——直接验证根因 */
  const dumpFrames = (tag: string) => {
    const frames = page.frames();
    const picked = frames.find(f => f.url().includes('studentcourse'));
    log(`  ── frames @ ${tag}（共 ${frames.length} 个）──`);
    frames.forEach((f, i) => {
      const isTarget = f === picked;
      log(
        `    [${i}] ${isTarget ? '★目录frame' : '         '} ${f.url().slice(0, 95)}`
      );
    });
    if (!picked) log('    ⚠ 没有任何 frame 的 URL 含 studentcourse（将退化为下标 1）');
  };

  // ── 登录 ──
  log('登录中…');
  const ok = await login(page, hooks, creds.username, creds.password);
  if (!ok) {
    log('✗ 登录失败，终止');
    await browser.close();
    process.exit(1);
  }
  log('✓ 登录成功');

  // ── 找课程 ──
  // 不引 Engine 类：它叫 ChaoxingEngine，而且这里只需要 getCourses()
  const courses = await getCourses(page, hooks);
  const course = courses.find(c => c.name.includes(COURSE_KEY));
  if (!course) {
    log(`✗ 没找到含「${COURSE_KEY}」的课程。可选：`);
    for (const c of courses) log(`    - ${c.name}`);
    await browser.close();
    process.exit(1);
  }
  log(`✓ 课程：${course.name}`);

  // ── 打开章节页 ──
  const { chapters } = await openCourseChapters(page, hooks, course);
  log(`✓ 共 ${chapters.length} 个任务点`);
  dumpFrames('刚打开章节页');

  // 无论如何都打印完整目录——筛子匹配不上时，全靠它判断章节结构
  log('\n────── 完整任务点目录 ──────');
  chapters.forEach((c, i) =>
    log(`  [${String(i).padStart(2)}] ${c.name}${c.isCompleted ? '   ✓已完成' : ''}`)
  );
  log('──────────────────────────');

  // ── 筛出目标章节的任务点 ──
  const targets = chapters.filter(c => c.name.replace(/\s/g, '').includes(SECTION));
  if (!targets.length) {
    log(`✗ 没找到含「${SECTION}」的任务点。全部任务点：`);
    chapters.forEach((c, i) => log(`    [${i}] ${c.name}${c.isCompleted ? '  (已完成)' : ''}`));
    await browser.close();
    process.exit(1);
  }
  log(`\n目标章节「${SECTION}」下共 ${targets.length} 个任务点：`);
  targets.forEach((c, i) =>
    log(`    ${i + 1}. ${c.name}${c.isCompleted ? '  (平台已标记完成)' : ''}`)
  );

  if (LIST_ONLY) {
    log('\n（--list-only：仅列目录，不刷课）');
    await browser.close();
    return;
  }

  // ── 逐个刷 ──
  const results: { name: string; entered: boolean; outcome: string }[] = [];
  for (let i = 0; i < targets.length; i++) {
    const ch = targets[i];
    log(`\n━━━━━━━━ [${i + 1}/${targets.length}] ${ch.name.replace(/\s+/g, ' ').trim()} ━━━━━━━━`);
    log(`  该章节共 ${ch.jobCount} 个任务点，待完成 ${ch.pendingCount} 个`);

    // 与引擎一致的重入逻辑：一章多任务点时要反复点同一个条目
    let rounds = 0;
    let lastPending = ch.pendingCount;
    for (;;) {
      if (++rounds > 8) {
        log('  ✗ 重入超过 8 次，放弃');
        break;
      }
      log(`  ── 第 ${rounds} 轮 ──`);
      dumpFrames(`点击前 #${i + 1}.${rounds}`);

      const entered = await clickChapter(page, hooks, ch);
      if (!entered) {
        log(`  ✗ 没能进入「${ch.name}」——这正是 bug 的症状`);
        results.push({ name: ch.name, entered: false, outcome: 'enter_failed' });
        break;
      }
      log('  ✓ 已点击进入');

      const quiz = await isQuizPage(page);
      if (quiz) {
        log('  这是答题页（本次验证脚本不处理答题，跳过）');
        results.push({ name: ch.name, entered: true, outcome: 'quiz_skipped' });
        await goBackToCourse(page, hooks);
        break;
      }

      const hasVideo = await waitForVideo(page, hooks);
      if (!hasVideo) {
        log('  ⚠ 没有等到视频');
        results.push({ name: ch.name, entered: true, outcome: 'no_video' });
        await goBackToCourse(page, hooks);
        break;
      }
      log('  ✓ 视频已就绪，等待播放完成…');

      const outcome = await waitForVideoEnd(page, hooks);
      log(`  ⇒ 播放结果：${outcome}`);
      results.push({ name: ch.name, entered: true, outcome });

      await goBackToCourse(page, hooks);
      dumpFrames('返回课程后');

      // 关键：重新读该章节的待完成数，决定要不要再点一次
      const after = await getChapters(page);
      const now_ = after.find(c => c.onclick === ch.onclick);
      if (!now_) {
        log('  返回后目录里没有该条目了，视为处理完');
        break;
      }
      log(`  返回后：共 ${after.length} 个任务点；本章待完成 ${now_.pendingCount}/${now_.jobCount}`);
      if (now_.isCompleted || now_.pendingCount <= 0) {
        log(`  ✅ 本章 ${now_.jobCount} 个任务点全部完成`);
        break;
      }
      if (now_.pendingCount >= lastPending) {
        log(`  ⚠ 待完成数未下降（${now_.pendingCount}），再点也只会打开同一个，停止重入`);
        break;
      }
      lastPending = now_.pendingCount;
      log(`  → 还剩 ${now_.pendingCount} 个，继续处理下一个任务点`);
    }
  }

  // ── 汇总 ──
  log('\n══════════ 汇总 ══════════');
  for (const r of results) {
    const mark = r.entered ? (r.outcome === 'completed' ? '✓' : '△') : '✗';
    log(`  ${mark} ${r.name}  → ${r.entered ? r.outcome : '未能进入'}`);
  }
  const done = results.filter(r => r.outcome === 'completed').length;
  const entered = results.filter(r => r.entered).length;
  const totalJobs = targets.reduce((s, t) => s + Math.max(1, t.jobCount), 0);
  log(`\n  进入 ${entered}/${results.length} 个条目，播放完成 ${done} 次`);
  log(`  目标章节声明的任务点总数：${totalJobs}`);
  if (totalJobs > 1 && done >= totalJobs) {
    log('  ✅ 一章多任务点全部刷完——bug 已修复');
  } else if (totalJobs > 1 && done < totalJobs) {
    log(`  ❌ 只刷完 ${done}/${totalJobs} 个任务点——bug 未修复`);
  } else if (totalJobs <= 1) {
    log('  ⚠ 目标章节只有 1 个任务点，无法验证多任务点场景');
  }

  await browser.close();
}

main().catch(e => {
  console.error('测试脚本异常：', e);
  process.exit(1);
});
