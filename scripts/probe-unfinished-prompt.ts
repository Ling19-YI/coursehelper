/**
 * 探针：章节页内「还有任务点未完成」提示与「去学习」按钮的结构。
 *
 * 前一个探针发现：同一章节的多个任务点 iframe 同时挂在一个页面里，
 * 而引擎只播了其中一个就回目录了。页面自己会弹
 * 「当前章节还有任务点未完成，是否去完成？」并带一个「去学习」按钮——
 * 如果这个按钮能跳到未完成任务点，就用它来做章节内推进，比回目录重新点可靠。
 *
 * 本探针把该提示区、按钮的 onclick、以及各视频容器的完成状态 dump 出来。
 *
 * 用法：tsx scripts/probe-unfinished-prompt.ts [课程] [章节]
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

  await clickChapter(page, hooks, target);
  await page.waitForTimeout(8000);

  // 主 frame：提示区与按钮
  const main = await page.frames()[0].evaluate(() => {
    const out: any = {};

    // 1) 「还有任务点未完成」提示区
    const tips = Array.from(document.querySelectorAll('[class*="jobFinishTip"],[class*="jobLimitTip"]'));
    out.tips = tips.slice(0, 4).map(e => ({
      cls: String(e.className),
      text: (e as HTMLElement).innerText?.replace(/\s+/g, ' ').trim().slice(0, 80),
      visible: (() => {
        const s = getComputedStyle(e as HTMLElement);
        return s.display !== 'none' && s.visibility !== 'hidden';
      })(),
    }));

    // 2) 未完成计数元素
    out.unfinish = Array.from(document.querySelectorAll('[class*="jobUnfinishCount"]'))
      .slice(0, 4)
      .map(e => ({
        cls: String(e.className),
        text: (e as HTMLElement).innerText?.trim(),
        html: (e as HTMLElement).outerHTML?.slice(0, 160),
      }));

    // 3) 「去学习」按钮及其 onclick
    const btns = Array.from(document.querySelectorAll('a,button,div,span'))
      .filter(e => /去学习|去完成|继续学习/.test((e as HTMLElement).innerText || ''))
      .slice(0, 6);
    out.goLearn = btns.map(e => ({
      tag: e.tagName,
      cls: String(e.className).slice(0, 60),
      text: (e as HTMLElement).innerText?.replace(/\s+/g, ' ').trim().slice(0, 30),
      onclick: (e.getAttribute('onclick') || '').slice(0, 140),
      href: (e as HTMLAnchorElement).getAttribute?.('href') || '',
      visible: (() => {
        const s = getComputedStyle(e as HTMLElement);
        return s.display !== 'none' && s.visibility !== 'hidden';
      })(),
    }));

    // 4) 所有 iframe 的 src（视频任务点）
    out.iframes = Array.from(document.querySelectorAll('iframe')).map((f, i) => ({
      i,
      src: (f.getAttribute('src') || '').slice(0, 90),
      cls: String(f.className).slice(0, 40),
    }));

    return out;
  });

  console.log('=== 「还有任务点未完成」提示 ===');
  for (const t of main.tips) console.log(`  [${t.visible ? '显示' : '隐藏'}] ${t.cls}\n      "${t.text}"`);

  console.log('\n=== 未完成计数 ===');
  for (const u of main.unfinish) console.log(`  ${u.cls} = "${u.text}"  ${u.html}`);

  console.log('\n=== 「去学习」按钮 ===');
  for (const b of main.goLearn) {
    console.log(`  <${b.tag} class="${b.cls}"> "${b.text}" [${b.visible ? '显示' : '隐藏'}]`);
    if (b.onclick) console.log(`      onclick=${b.onclick}`);
    if (b.href) console.log(`      href=${b.href}`);
  }

  console.log('\n=== 页面 iframe ===');
  for (const f of main.iframes) console.log(`  [${f.i}] ${f.cls}  ${f.src}`);

  // knowledge/cards frame 里各任务点容器的完成状态
  const cardsFrame = page.frames().find(f => f.url().includes('knowledge/cards'));
  if (cardsFrame) {
    const jobs = await cardsFrame.evaluate(() => {
      const out: any[] = [];
      document.querySelectorAll('[class*="ans-attach-ct"],[class*="jobTitle"],[class*="ans-job"]').forEach(e => {
        const cls = String(e.className);
        if (!/ans-attach-ct|jobTitle/.test(cls)) return;
        out.push({
          cls: cls.slice(0, 90),
          finished: cls.includes('ans-job-finished'),
          text: (e as HTMLElement).innerText?.replace(/\s+/g, ' ').trim().slice(0, 40),
        });
      });
      return out.slice(0, 12);
    });
    console.log('\n=== knowledge/cards 里的任务点容器 ===');
    for (const j of jobs) {
      console.log(`  ${j.finished ? '✓已完成' : '○未完成'}  ${j.cls}`);
      if (j.text) console.log(`        "${j.text}"`);
    }
  }

  await browser.close();
}

main().catch(e => {
  console.error('探针失败：', e);
  process.exit(1);
});
