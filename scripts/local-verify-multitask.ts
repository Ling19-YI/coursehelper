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
import {
  waitForVideo,
  waitForVideoEnd,
  readUnfinishedCount,
  detectDailyLimit,
  gotoUnfinishedJob,
} from '../src/main/engine/video';
import { handleDocument } from '../src/main/engine/document';
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
    autoPauseOnVerify: () => false,
    visionChannel: () => null,
    deepseekKey: () => '',
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

    // 与引擎一致的逻辑：进入一次，页面内推进多个任务点
    let rounds = 0;
    for (;;) {
      if (++rounds > 8) {
        log('  ✗ 超过 8 轮，放弃');
        break;
      }
      log(`  ── 第 ${rounds} 轮 ──`);

      if (rounds === 1) {
        dumpFrames(`点击前 #${i + 1}`);
        const entered = await clickChapter(page, hooks, ch);
        if (!entered) {
          log(`  ✗ 没能进入「${ch.name}」`);
          results.push({ name: ch.name, entered: false, outcome: 'enter_failed' });
          break;
        }
        log('  ✓ 已点击进入');
      }

      if (await detectDailyLimit(page)) {
        log('  ⚠ 平台提示「今日视频任务点完成数已达上限」——视频能放但不记完成');
        results.push({ name: ch.name, entered: true, outcome: 'daily_limit' });
        break;
      }

      const quiz = await isQuizPage(page);
      if (quiz) {
        log('  这是答题页（验证脚本不处理答题）');
        results.push({ name: ch.name, entered: true, outcome: 'quiz_skipped' });
        break;
      }

      const hasVideo = await waitForVideo(page, hooks);
      if (!hasVideo) {
        log('  无视频，按文档型任务点处理…');
        const doc = await handleDocument(page, hooks);
        log(`  ⇒ 文档处理结果：${doc}`);
        const left = await readUnfinishedCount(page);
        const done = left !== null && left <= 0;
        log(`  平台未完成计数：${left === null ? '读不到' : left} → ${done ? '已完成 ✓' : '未标记'}`);
        results.push({
          name: ch.name,
          entered: true,
          outcome: done ? 'doc_done' : doc === 'unsupported' ? 'doc_unsupported' : 'doc_not_marked',
        });
        break;
      }

      log('  ✓ 视频已就绪，等待播放完成…');
      const outcome = await waitForVideoEnd(page, hooks);
      log(`  ⇒ 播放结果：${outcome}`);
      results.push({ name: ch.name, entered: true, outcome });

      const left = await readUnfinishedCount(page);
      log(`  本章未完成计数：${left === null ? '读不到' : left}`);
      if (left === null) {
        // 读不到 ≠ 做完了。可能已离开章节页（反爬验证页等），别误报成功。
        log('  ⚠ 读不到未完成计数，本轮结果不可判定');
        break;
      }
      if (left <= 0) {
        log('  ✓ 本章无剩余任务点');
        break;
      }
      const jumped = await gotoUnfinishedJob(page);
      log(`  → 还有 ${left} 个未完成，跳转${jumped ? '成功' : '失败'}`);
      if (!jumped) break;
      await hooks.ctl.sleep(1500);
    }

    dumpFrames('本章结束');
    await goBackToCourse(page, hooks);
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
