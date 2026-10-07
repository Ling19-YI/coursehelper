import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { ChaoxingEngine } from '../src/main/engine/index';
import { getChapters } from '../src/main/engine/chaoxing';

const LEGACY_DIR = 'C:\\Users\\colorful\\Documents\\Default Project\\-';
const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
];

async function main() {
  const dataDir = path.resolve('test-data');
  const creds = JSON.parse(fs.readFileSync(path.join(LEGACY_DIR, 'credentials.json'), 'utf-8'));

  const browser = await chromium.launch({ headless: false, args: LAUNCH_ARGS });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  const engine = new ChaoxingEngine({
    page,
    dataDir,
    emit: e => {
      if (e.type === 'log') console.log(e.msg);
    },
    getDeepseekKey: () => '',
  });

  const courses = await engine.listCourses(creds);
  const course = courses.find(c => c.index === 3);
  if (!course) throw new Error('course not found');

  const readPlatform = async () => {
    for (const f of page.frames()) {
      try {
        const t: string = await f.$eval('body', b => (b as HTMLElement).innerText);
        const m = t.match(/已完成任务点[:：]\s*(\d+)\s*\/\s*(\d+)/);
        if (m) return `${m[1]}/${m[2]}`;
      } catch {}
    }
    return '?';
  };

  await page.goto(course.url, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 6000));
  const tab = await page.$('text=章节');
  if (tab) {
    await tab.click({ force: true });
    await new Promise(r => setTimeout(r, 5000));
  }
  console.log('platform before:', await readPlatform());

  const chapters = await getChapters(page);
  const todoable = chapters.filter(c => c.onclick.includes('toOld'));
  const target = todoable[0];
  console.log('chapter:', target.name.replace(/\s+/g, ' '));

  const frame1 = page.frames()[1];
  const el = await frame1.$(`[onclick="${target.onclick}"]`);
  if (el) {
    await el.click({ force: true });
    await new Promise(r => setTimeout(r, 8000));
  }

  const pan = page.frames().find(f => f.url().includes('pan-yz.chaoxing.com'));
  if (!pan) throw new Error('panView frame not found');

  const H = await pan.evaluate(() => document.documentElement.scrollHeight);
  const C = await pan.evaluate(() => document.documentElement.clientHeight);
  console.log(`panView scrollHeight=${H} client=${C}`);

  const steps = 25;
  for (let i = 1; i <= steps; i++) {
    const y = Math.round((H - C) * (i / steps));
    await pan.evaluate(y2 => window.scrollTo(0, y2), y);
    await new Promise(r => setTimeout(r, 900));
    if (i % 5 === 0) {
      const cur = await pan.evaluate(() => Math.round(window.scrollY));
      const visiblePage = await pan
        .evaluate(() => {
          const els = Array.from(document.querySelectorAll('.pageNum'));
          for (const e of els) {
            const r = e.getBoundingClientRect();
            if (r.top > 0 && r.top < window.innerHeight - 30) return (e as HTMLElement).innerText;
          }
          return '';
        })
        .catch(() => '');
      console.log(`  scroll ${i}/${steps} y=${cur} page≈${visiblePage}`);
    }
  }
  await new Promise(r => setTimeout(r, 4000));

  console.log('\n返回章节页...');
  await page.goto(course.url, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 6000));
  const tab2 = await page.$('text=章节');
  if (tab2) {
    await tab2.click({ force: true });
    await new Promise(r => setTimeout(r, 5000));
  }
  console.log('platform after scroll:', await readPlatform());
  const after = await getChapters(page);
  const t2 = after.find(c => c.onclick === target.onclick);
  console.log('chapter completed flag:', t2 ? t2.isCompleted : 'not found');

  await browser.close();
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
