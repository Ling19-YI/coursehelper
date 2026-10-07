import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { ChaoxingEngine } from '../src/main/engine/index';
import type { Course, EngineEvent } from '../src/shared/types';

const LEGACY_DIR = 'C:\\Users\\colorful\\Documents\\Default Project\\-';
const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
];

function argNum(name: string): number | null {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  const v = parseInt(process.argv[i + 1], 10);
  return isNaN(v) ? null : v;
}

function prepareDataDir(): string {
  const dir = path.resolve('test-data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const legacyData = path.join(LEGACY_DIR, 'data');
  if (fs.existsSync(legacyData)) {
    for (const f of fs.readdirSync(legacyData).filter(f => f.endsWith('.json'))) {
      const dst = path.join(dir, f);
      if (!fs.existsSync(dst)) fs.copyFileSync(path.join(legacyData, f), dst);
    }
  }
  return dir;
}

function loadCreds() {
  const p = path.join(LEGACY_DIR, 'credentials.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function printEvent(e: EngineEvent) {
  switch (e.type) {
    case 'log': {
      const tag = { info: '·', ok: '✓', warn: '!', error: '✗' }[e.level];
      console.log(`[${tag}] ${e.msg}`);
      break;
    }
    case 'state':
      console.log(`>>> state = ${e.state}${e.detail ? ' (' + e.detail + ')' : ''}`);
      break;
    case 'courses':
      console.log(`>>> courses: ${e.courses.length} 门`);
      for (const c of e.courses) console.log(`    [${c.index}] ${c.name} (${c.courseId})`);
      break;
    case 'course-progress':
      console.log(
        `>>> progress ${e.courseName}: ${e.completed}/${e.total} last=${(e.lastChapter || '').substring(0, 40)}`
      );
      break;
    case 'video':
      if (e.ct % 1 < 0.1)
        console.log(`    video ct=${e.ct.toFixed(1)}/${Math.round(e.d)} paused=${e.paused}`);
      break;
    case 'chapter':
      console.log(`>>> chapter ${e.index}/${e.total} [${e.result}] ${e.name.substring(0, 40)}`);
      break;
    case 'task-done':
      console.log(`>>> task-done completed=${e.completed} skipped=${e.skipped}`);
      break;
    case 'error':
      console.log(`>>> error: ${e.message}`);
      break;
  }
}

async function main() {
  const action = process.argv[2] || 'list';
  const dataDir = prepareDataDir();
  const creds = loadCreds();
  const stopAfter = argNum('--stop-after');
  const pauseAfter = argNum('--pause-after');
  const resumeAfter = argNum('--resume-after');

  console.log(`dataDir=${dataDir} action=${action}`);

  const browser = await chromium.launch({ headless: false, args: LAUNCH_ARGS });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  const engine = new ChaoxingEngine({
    page,
    dataDir,
    emit: printEvent,
    getDeepseekKey: () => process.env.DEEPSEEK_API_KEY || '',
  });

  if (stopAfter != null) setTimeout(() => engine.stop(), stopAfter * 1000);
  if (pauseAfter != null)
    setTimeout(() => {
      console.log('### 测试: pause()');
      engine.pause();
    }, pauseAfter * 1000);
  if (resumeAfter != null)
    setTimeout(() => {
      console.log('### 测试: resume()');
      engine.resume();
    }, resumeAfter * 1000);

  const t0 = Date.now();
  try {
    if (action === 'list') {
      await engine.listCourses(creds);
    } else if (action === 'run') {
      const courses = await engine.listCourses(creds);
      const want = parseInt(process.argv[3] || '1', 10);
      const selected: Course[] = courses.filter(c => c.index === want);
      if (!selected.length) {
        console.error('未找到课程 #' + want);
        process.exit(2);
      }
      const summary = await engine.run(selected, creds, { resume: true });
      console.log(`\n汇总: ${JSON.stringify(summary)} 耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
    } else if (action === 'progress') {
      console.log(JSON.stringify(engine.getStoredProgress(), null, 2));
    }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`总耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
}

main().then(
  () => process.exit(0),
  e => {
    console.error('FATAL:', e);
    process.exit(1);
  }
);
