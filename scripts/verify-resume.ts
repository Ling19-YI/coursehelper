import { chromium } from 'playwright';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChaoxingEngine } from '../src/main/engine';
import { openCourseChapters, login, getCourses } from '../src/main/engine/chaoxing';
import type { EngineEvent } from '../src/shared/types';
import type { EngineHooks } from '../src/main/engine/hooks';
import { TaskControl } from '../src/main/engine/control';

/**
 * 验证修复：断点续跑是否跳过"用户手动完成过"的章节
 * 用法: npx tsx scripts/verify-resume.ts <课程名关键字>
 * 逻辑：对比平台标记的第一个未完成章节 与 引擎实际开始处理的章节
 */
async function main() {
  const legacyDir = process.env.COURSEHELPER_LEGACY_DIR || path.join(os.homedir(), 'Documents', 'Default Project', '-');
  const creds = JSON.parse(fs.readFileSync(path.join(legacyDir, 'credentials.json'), 'utf-8'));
  const keyword = process.argv[2] || '大学计算机基础';
  const dataDir = path.join(process.cwd(), 'test-data', 'verify-resume');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  // 先算出期望值（平台标记的第一个未完成章节）
  const probeCtl = new TaskControl();
  const probeHooks = { ctl: probeCtl, log: () => {}, onTick: () => {}, diag: () => {} } as unknown as EngineHooks;
  if (!(await login(page, probeHooks, creds.username, creds.password))) throw new Error('登录失败');
  const course = (await getCourses(page, probeHooks)).find(c => c.name.includes(keyword));
  if (!course) throw new Error('未找到课程: ' + keyword);
  const { chapters, platform } = await openCourseChapters(page, probeHooks, course);
  const todoable = chapters.filter(c => c.onclick.includes('toOld'));
  const expectedIdx = todoable.findIndex(c => !c.isCompleted);
  console.log(`课程: ${course.name}`);
  console.log(`平台进度: ${platform ? platform.done + '/' + platform.total : 'n/a'}`);
  console.log(`可刷章节: ${todoable.length}，平台标记完成: ${todoable.filter(c => c.isCompleted).length}`);
  console.log(`期望从第 ${expectedIdx + 1} 个可刷章节开始: "${todoable[expectedIdx]?.name}"`);

  // 再让引擎真跑，跑到第一个章节开始就停
  // 用独立 context（独立 cookie），否则探测阶段的登录态会让引擎的登录表单不出现
  await browser.close();
  const browser2 = await chromium.launch({ headless: true });
  const ctx2 = await browser2.newContext({ viewport: { width: 1400, height: 900 } });
  const page2 = await ctx2.newPage();

  let firstProcessed = '';
  let stopped = false;
  const engine = new ChaoxingEngine({
    page: page2,
    dataDir,
    getDeepseekKey: () => '',
    emit: (e: EngineEvent) => {
      if (e.type === 'log') console.log('  [引擎]', e.msg);
      if (e.type === 'chapter' && !stopped) {
        firstProcessed = `${e.index}/${e.total} ${e.name}`;
        console.log('  [引擎] 首个处理章节:', firstProcessed);
        engine.stop();
        stopped = true;
      }
      if (e.type === 'error') console.log('  [引擎][error]', e.message);
    },
  });

  const summary = await engine.run([course], creds, { resume: true });
  console.log('\n结果:');
  const expectedName = (todoable[expectedIdx]?.name || '').replace(/\s+/g, ' ').trim();
  const actualName = firstProcessed.replace(/^\d+\/\d+\s*/, '').replace(/\s+/g, ' ').trim();
  console.log('  期望首章节:', expectedName || '(无，全部已完成)');
  console.log('  实际首章节:', actualName || '(未开始)');
  const ok = expectedIdx < 0 ? !firstProcessed : actualName === expectedName;
  console.log(ok ? '\n✓ PASS：断点正确跳过了手动完成的章节' : '\n✗ FAIL：起始章节不符');
  console.log('  汇总:', JSON.stringify(summary));
  await browser2.close();
  process.exit(ok ? 0 : 1);
}

main();