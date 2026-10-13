/**
 * 探针：章节内的多任务点到底怎么导航？
 *
 * 背景：用户反馈「一章多任务点只刷第一个」。先前假设是「再点一次同一章节
 * 条目就会打开下一个任务点」，实机验证失败——播完后平台待完成数不降。
 * 抓到的 DOM 显示 onclick="toOld(courseId, chapterId, clazzId, 0)"，
 * 第 4 个参数疑似任务点下标，恒为 0。
 *
 * 而视频页 frames 里出现过两个 ananas/modules/video iframe 和一个
 * knowledge/cards iframe——说明同章节的多个任务点可能都在同一页面里，
 * 需要「章节内部」导航，而不是回目录重新点。
 *
 * 本探针进入指定章节，把任务点列表与可用的导航入口全部 dump 出来。
 *
 * 用法：tsx scripts/probe-taskpoint-nav.ts [课程关键字] [章节号]
 */

import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { login, getCourses, openCourseChapters, clickChapter } from '../src/main/engine/chaoxing';
import { TaskControl } from '../src/main/engine/control';
import type { EngineHooks } from '../src/main/engine/hooks';

const LEGACY_DIR = 'C:\\Users\\colorful\\Documents\\Default Project\\-';
const COURSE_KEY = process.argv[2] || '图形';
const SECTION = process.argv[3] || '2.5';

async function main() {
  const creds = JSON.parse(fs.readFileSync(path.join(LEGACY_DIR, 'credentials.json'), 'utf-8'));
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();

  const ctl = new TaskControl();
  ctl.reset();
  const hooks: EngineHooks = {
    ctl,
    log: () => {},
    onTick: () => {},
    diag: async () => null,
    speed: () => 2,
    muted: () => true,
    agentEnabled: () => false,
    vision: () => ({ baseUrl: '', apiKey: '', model: '' }),
    answerPopup: () => false,
    autoPauseOnVerify: () => false,
    visionChannel: () => null,
    tiku: () => null,
    submitCoverRate: () => 0.8,
    chapterLeft: () => false,
  };

  await login(page, hooks, creds.username, creds.password);
  const courses = await getCourses(page, hooks);
  const course = courses.find(c => c.name.includes(COURSE_KEY));
  if (!course) throw new Error(`找不到课程 ${COURSE_KEY}`);
  const { chapters } = await openCourseChapters(page, hooks, course);
  const target = chapters.find(c => c.name.replace(/\s/g, '').includes(SECTION));
  if (!target) throw new Error(`找不到章节 ${SECTION}`);

  console.log('=== 目录里的条目 ===');
  console.log(`  name   = ${JSON.stringify(target.name)}`);
  console.log(`  onclick= ${target.onclick}`);
  console.log(`  jobCount=${target.jobCount} pendingCount=${target.pendingCount} done=${target.isCompleted}`);

  console.log(`\n=== toOld 的参数 ===`);
  const m = /toOld\(([^)]*)\)/.exec(target.onclick);
  if (m) {
    const args = m[1].split(',').map(s => s.trim());
    console.log(`  ${args.length} 个参数：`);
    args.forEach((a, i) => console.log(`    [${i}] ${a}`));
  }

  console.log('\n=== 进入该章节 ===');
  await clickChapter(page, hooks, target);
  await page.waitForTimeout(6000);

  console.log(`当前 URL: ${page.url()}\n`);

  // 遍历所有 frame，dump 任务点列表与导航入口
  for (const [i, f] of page.frames().entries()) {
    const info = await f
      .evaluate(() => {
        const out: any = { url: location.href.slice(0, 120) };

        // 1) 带 toOld 的可点元素（章节内导航？）
        out.toOld = Array.from(document.querySelectorAll('[onclick*="toOld"]'))
          .slice(0, 10)
          .map(e => ({
            tag: e.tagName,
            cls: String(e.className).slice(0, 40),
            text: (e as HTMLElement).innerText?.replace(/\s+/g, ' ').trim().slice(0, 40),
            onclick: (e.getAttribute('onclick') || '').slice(0, 90),
          }));

        // 2) 任务点/知识卡列表
        out.cards = Array.from(
          document.querySelectorAll('[class*="card"],[class*="job"],[class*="knowledge"]')
        )
          .slice(0, 12)
          .map(e => ({
            cls: String(e.className).slice(0, 50),
            text: (e as HTMLElement).innerText?.replace(/\s+/g, ' ').trim().slice(0, 50),
            onclick: (e.getAttribute('onclick') || '').slice(0, 70),
          }));

        // 3) 明显的导航按钮
        const NAV = /下一个|下一节|下一页|继续学习|下一任务|next/i;
        out.nav = Array.from(document.querySelectorAll('a,button,div,span,li'))
          .filter(e => NAV.test((e as HTMLElement).innerText || ''))
          .slice(0, 10)
          .map(e => ({
            tag: e.tagName,
            cls: String(e.className).slice(0, 40),
            text: (e as HTMLElement).innerText?.replace(/\s+/g, ' ').trim().slice(0, 30),
            onclick: (e.getAttribute('onclick') || '').slice(0, 70),
          }));

        // 4) 视频
        out.videos = Array.from(document.querySelectorAll('video')).map(v => ({
          src: (v.currentSrc || v.src || '').slice(0, 70),
          duration: Math.round(v.duration || 0),
          current: Math.round(v.currentTime || 0),
          visible: (() => {
            const r = v.getBoundingClientRect();
            return r.width >= 100 && r.height >= 60;
          })(),
        }));

        return out;
      })
      .catch(() => null);
    if (!info) continue;

    const interesting =
      info.toOld.length || info.cards.length || info.nav.length || info.videos.length;
    if (!interesting) continue;

    console.log(`─── frame[${i}] ${info.url} ───`);
    if (info.videos.length) console.log('  视频:', JSON.stringify(info.videos));
    if (info.toOld.length) {
      console.log('  toOld 元素:');
      info.toOld.forEach((t: any) =>
        console.log(`    <${t.tag} class="${t.cls}"> "${t.text}"  onclick=${t.onclick}`)
      );
    }
    if (info.nav.length) {
      console.log('  导航入口:');
      info.nav.forEach((t: any) => console.log(`    <${t.tag}> "${t.text}"  onclick=${t.onclick}`));
    }
    if (info.cards.length) {
      console.log('  卡片/任务点:');
      info.cards.forEach((t: any) => console.log(`    class="${t.cls}" "${t.text}"`));
    }
    console.log();
  }

  await browser.close();
}

main().catch(e => {
  console.error('探针失败：', e);
  process.exit(1);
});
