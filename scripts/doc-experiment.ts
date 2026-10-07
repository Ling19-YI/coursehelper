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

  await page.goto(course.url, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 6000));
  const tab = await page.$('text=章节');
  if (tab) {
    await tab.click({ force: true });
    await new Promise(r => setTimeout(r, 5000));
  }

  const chapters = await getChapters(page);
  const target = chapters.filter(c => c.onclick.includes('toOld'))[0];
  const frame1 = page.frames()[1];
  const el = await frame1.$(`[onclick="${target.onclick}"]`);
  if (el) {
    await el.click({ force: true });
    await new Promise(r => setTimeout(r, 8000));
  }

  for (const f of page.frames()) {
    if (!/panView|wpsView|pdf/.test(f.url() + f.name())) continue;
    console.log(`\n=== viewer frame: name=${f.name()} url=${f.url().substring(0, 90)} ===`);
    try {
      const info = await f.evaluate(() => {
        const out: any = {};
        out.scrollables = Array.from(document.querySelectorAll('*'))
          .filter((e: any) => e.scrollHeight > e.clientHeight + 50 && e.clientHeight > 100)
          .slice(0, 5)
          .map((e: any) => ({
            tag: e.tagName,
            cls: String(e.className).substring(0, 60),
            sh: e.scrollHeight,
            ch: e.clientHeight,
          }));
        out.controls = Array.from(
          document.querySelectorAll('button, [class*="next"], [class*="page"], [class*="btn"], [class*="arrow"], [role="button"]')
        )
          .slice(0, 25)
          .map((e: any) => ({
            tag: e.tagName,
            cls: String(e.className).substring(0, 50),
            txt: (e.innerText || '').trim().substring(0, 20),
            aria: e.getAttribute('aria-label') || '',
          }));
        out.canvas = document.querySelectorAll('canvas').length;
        out.iframes = document.querySelectorAll('iframe').length;
        out.bodyCls = String(document.body.className).substring(0, 80);
        out.htmlHead = document.documentElement.outerHTML.substring(0, 600);
        return out;
      });
      console.log(JSON.stringify(info, null, 2).substring(0, 3500));
    } catch (e: any) {
      console.log('  evaluate failed:', e.message);
    }
  }

  await browser.close();
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
