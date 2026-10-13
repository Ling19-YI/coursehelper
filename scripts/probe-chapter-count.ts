/**
 * 探针：确认章节目录里「章节名后面那个数字」的语义。
 *
 * 背景：用户反馈「一个章节里多个任务点只刷第一个」。实机发现
 * "2.5 编程环境配置与示例程序演示\n2" 是一个 chapter_item，
 * 名字第二行的 "2" 疑似该章节包含的任务点数。
 * 这个探针把原始 outerHTML 打出来，确认那个数字到底是什么、
 * 在 DOM 的哪个节点上，以免照着猜测写修复。
 *
 * 用法：tsx scripts/probe-chapter-count.ts [课程关键字] [章节号]
 */

import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { login, getCourses, openCourseChapters } from '../src/main/engine/chaoxing';
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
    log: (l, m) => console.log(`[${l}] ${m}`),
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
  console.log(`课程：${course.name}\n`);

  await openCourseChapters(page, hooks, course);

  const frame = page.frames().find(f => f.url().includes('studentcourse'));
  if (!frame) throw new Error('找不到目录 frame');

  // 把所有 chapter_item 的结构化信息 + 目标章节的原始 HTML 打出来
  const dump = await frame.$$eval('[class*="chapter_item"]', (els: any[]) =>
    els.map((el, i) => {
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      const html = el.outerHTML || '';
      // 找出所有子节点里可能是"任务点数"的元素
      const badgeCandidates: string[] = [];
      el.querySelectorAll('*').forEach((c: any) => {
        const t = (c.innerText || '').trim();
        const cls = String(c.className || '');
        if (t && t.length <= 4 && /^\d+$/.test(t)) {
          badgeCandidates.push(`<${c.tagName} class="${cls}">${t}</${c.tagName}>`);
        }
      });
      return {
        i,
        text: text.slice(0, 60),
        classes: String(el.className),
        onclick: (el.getAttribute('onclick') || '').slice(0, 80),
        digits: badgeCandidates.slice(0, 6),
        htmlLen: html.length,
      };
    })
  );

  console.log('─── 全部 chapter_item ───');
  for (const d of dump) {
    console.log(
      `[${String(d.i).padStart(2)}] "${d.text}"\n      class="${d.classes}"  digits=${JSON.stringify(d.digits)}`
    );
  }

  // 目标章节的完整 outerHTML
  const target = dump.find(d => d.text.replace(/\s/g, '').includes(SECTION));
  if (target) {
    console.log(`\n─── 目标章节「${SECTION}」完整 outerHTML ───`);
    const html = await frame.$$eval('[class*="chapter_item"]', (els: any[]) =>
      els.map(e => e.outerHTML || '')
    );
    console.log(html[target.i]);
  } else {
    console.log(`\n（没找到含「${SECTION}」的条目）`);
  }

  await browser.close();
}

main().catch(e => {
  console.error('探针失败：', e);
  process.exit(1);
});
