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
  const want = parseInt(process.argv[2] || '2', 10);

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
  const course = courses.find(c => c.index === want);
  if (!course) throw new Error('course not found');

  await page.goto(course.url, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 6000));
  const tab = await page.$('text=章节');
  if (tab) {
    await tab.click({ force: true });
    await new Promise(r => setTimeout(r, 5000));
  }

  for (const f of page.frames()) {
    try {
      const t: string = await f.$eval('body', b => (b as HTMLElement).innerText);
      const m = t.match(/已完成任务点[:：]\s*\d+\s*\/\s*\d+/);
      if (m) console.log('platform →', m[0]);
    } catch {}
  }

  const items = await f1(page);
  console.log(`chapter items: ${items.length}`);
  items.forEach((s, i) => {
    console.log(`\n----- item[${i}] -----`);
    console.log(JSON.stringify(s, null, 1));
  });
  await browser.close();
}

async function f1(page: any): Promise<any[]> {
  const frame = page.frames()[1];
  return frame.$$eval('[class*="chapter_item"]', (els: any[]) =>
    els.slice(0, 5).map((el: any) => ({
      ownClass: String(el.className),
      id: el.id || '',
      ownAttrs: Array.from(el.attributes)
        .map((a: any) => `${a.name}=${String(a.value).substring(0, 80)}`)
        .join(' | '),
      innerClasses: Array.from(el.querySelectorAll('*'))
        .map((e: any) => String(e.className))
        .filter(Boolean)
        .join(' ')
        .substring(0, 400),
      text: String(el.innerText || '')
        .replace(/\s+/g, ' ')
        .substring(0, 140),
      hasCompletedText: String(el.innerText || '').includes('已完成'),
      title: el.getAttribute('title') || '',
    }))
  );
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
