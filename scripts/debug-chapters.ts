import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { ChaoxingEngine } from '../src/main/engine/index';

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

  console.log(`\n=== 打开课程: ${course.name} ===`);
  console.log('url:', course.url);
  await page.goto(course.url, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 6000));

  console.log('page url after goto:', page.url());
  for (const [i, f] of page.frames().entries()) {
    let count = -1;
    let bodyHead = '';
    try {
      count = await f.$$eval('[class*="chapter_item"]', els => els.length);
    } catch (e) {
      count = -2;
    }
    try {
      bodyHead = ((await f.$eval('body', b => b.innerText)) || '').replace(/\s+/g, ' ').substring(0, 160);
    } catch {
      bodyHead = '(no body)';
    }
    console.log(`frame[${i}] name="${f.name()}" url=${f.url().substring(0, 90)}`);
    console.log(`   chapter_items=${count} body: ${bodyHead}`);
  }

  const tab = await page.$('text=章节');
  console.log('\nclick 章节 tab:', !!tab);
  if (tab) {
    await tab.click({ force: true });
    await new Promise(r => setTimeout(r, 5000));
  }

  for (const [i, f] of page.frames().entries()) {
    let count = -1;
    try {
      count = await f.$$eval('[class*="chapter_item"]', els => els.length);
    } catch {
      count = -2;
    }
    let bodyHead = '';
    try {
      bodyHead = ((await f.$eval('body', b => b.innerText)) || '').replace(/\s+/g, ' ').substring(0, 200);
    } catch {
      bodyHead = '(no body)';
    }
    console.log(`AFTER frame[${i}] name="${f.name()}" chapter_items=${count}`);
    console.log(`   url=${f.url().substring(0, 90)}`);
    console.log(`   body: ${bodyHead}`);
  }

  await page.screenshot({ path: 'app/debug-chapters.png', fullPage: false });
  console.log('screenshot → app/debug-chapters.png');
  await browser.close();
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
