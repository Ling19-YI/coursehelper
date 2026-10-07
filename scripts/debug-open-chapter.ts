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
  const want = parseInt(process.argv[2] || '3', 10);
  const chIdx = parseInt(process.argv[3] || '1', 10);

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

  const chapters = await getChapters(page);
  console.log(`chapters=${chapters.length}`);
  chapters.slice(0, 6).forEach((c, i) => console.log(` [${i}] ${c.name.replace(/\s+/g, ' ')} | ${c.onclick.substring(0, 70)}`));

  const target = chapters.filter(c => c.onclick.includes('toOld'))[chIdx - 1];
  if (!target) throw new Error('no toOld chapter at index');
  console.log(`\n>>> 点击: ${target.name.replace(/\s+/g, ' ')}`);

  const frame1 = page.frames()[1];
  const el = await frame1.$(`[onclick="${target.onclick}"]`);
  console.log('chapter element found:', !!el);
  if (el) {
    await el.click({ force: true });
    await new Promise(r => setTimeout(r, 6000));
  }

  console.log('\npages after click:', ctx.pages().length);
  for (const [i, p] of ctx.pages().entries()) {
    console.log(`  page[${i}] ${p.url().substring(0, 110)}`);
  }

  for (const [i, f] of page.frames().entries()) {
    let vids = -1;
    let vinfo = '';
    try {
      vids = await f.$$eval('video', els =>
        els.map(v => `ct=${(v as HTMLVideoElement).currentTime.toFixed(1)} d=${(v as HTMLVideoElement).duration || 0} paused=${(v as HTMLVideoElement).paused} rs=${(v as HTMLVideoElement).readyState} src=${String((v as HTMLVideoElement).currentSrc).slice(-50)}`)
      ).then(a => a.length) as number;
      vinfo = JSON.stringify(
        await f.$$eval('video', els =>
          els.map(v => ({
            ct: +(v as HTMLVideoElement).currentTime.toFixed(1),
            d: (v as HTMLVideoElement).duration || 0,
            paused: (v as HTMLVideoElement).paused,
            rs: (v as HTMLVideoElement).readyState,
            src: String((v as HTMLVideoElement).currentSrc).slice(-60),
          }))
        )
      );
    } catch {
      vids = -2;
    }
    let body = '';
    try {
      body = ((await f.$eval('body', b => (b as HTMLElement).innerText)) || '')
        .replace(/\s+/g, ' ')
        .substring(0, 220);
    } catch {
      body = '(no body)';
    }
    console.log(`frame[${i}] name="${f.name()}" videos=${vids}`);
    console.log(`   url=${f.url().substring(0, 100)}`);
    if (vids > 0) console.log(`   ${vinfo}`);
    console.log(`   body: ${body}`);
  }

  await page.screenshot({ path: 'app/debug-chapter-open.png' });
  console.log('\nscreenshot → app/debug-chapter-open.png');

  console.log('\n=== 打开10s后返回章节页，读平台进度 ===');
  await new Promise(r => setTimeout(r, 10000));
  await page.goto(course.url, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 6000));
  const tab2 = await page.$('text=章节');
  if (tab2) {
    await tab2.click({ force: true });
    await new Promise(r => setTimeout(r, 5000));
  }
  for (const f of page.frames()) {
    try {
      const t: string = await f.$eval('body', b => (b as HTMLElement).innerText);
      const m = t.match(/已完成任务点[:：]\s*\d+\s*\/\s*\d+/);
      if (m) console.log('platform →', m[0]);
    } catch {}
  }
  await browser.close();
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
