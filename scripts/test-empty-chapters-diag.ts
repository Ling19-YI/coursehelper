/**
 * 验证 diagnoseEmptyChapters 能把「目录为空」的几种原因区分开。
 *
 * 背景：用户反馈「换了舍友的账号后检测不到任务点」。真因是课表缓存带着
 * 旧账号的 clazzid/cpi，新账号打开是无权限页。但原来的日志只有一句
 * 「未找到章节，跳过该课程」，从这个现象根本推不出原因。
 *
 * 本脚本用【伪造的 courseid】构造出真实的无权限/异常页，确认诊断函数
 * 给出的原因是可区分的、而不是永远同一句。
 *
 * 用法：tsx scripts/test-empty-chapters-diag.ts
 */

import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { login, diagnoseEmptyChapters, openCourseChapters } from '../src/main/engine/chaoxing';
import { TaskControl } from '../src/main/engine/control';
import type { EngineHooks } from '../src/main/engine/hooks';
import type { Course } from '../src/shared/types';

const LEGACY_DIR = 'C:\\Users\\colorful\\Documents\\Default Project\\-';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

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
  };

  await login(page, hooks, creds.username, creds.password);
  const acc = creds.username;
  console.log(`账号 ${acc}\n`);

  // ── 场景 1：不存在的课程 ID（模拟「无权限 / 课不存在」） ──
  console.log('[伪造 courseid → 应给出可区分的原因]');
  const bogus: Course = {
    index: 999,
    name: '不存在的课程',
    courseId: '999999999',
    url:
      'https://mooc1-1.chaoxing.com/mooc-ans/visit/stucoursemiddle' +
      '?courseid=999999999&clazzid=1&vc=1&cpi=1&ismooc2=1&v=2',
  } as Course;

  const { chapters } = await openCourseChapters(page, hooks, bogus);
  const reason = await diagnoseEmptyChapters(page);
  console.log(`   章节数=${chapters.length}  诊断="${reason}"`);

  check('伪造课程确实拿不到任务点', chapters.length === 0, `实际 ${chapters.length}`);
  check('诊断给出了非空原因', reason.length > 0, `"${reason}"`);
  check(
    '原因不是「该课程确实没有任务点」这种误导性说法',
    !reason.includes('确实没有任务点'),
    `"${reason}"`
  );
  check('原因能指向无权限/异常，而非空泛', /无权限|会话|框架|登录|异常|失败/.test(reason), `"${reason}"`);

  // ── 场景 2：真实存在的课程（对照组，不应给出错误诊断） ──
  console.log('\n[对照：真实课程不应被误诊]');
  const real: Course = {
    index: 0,
    name: '计算机图形学原理',
    courseId: '266995218',
    url:
      'https://mooc1-1.chaoxing.com/mooc-ans/visit/stucoursemiddle' +
      '?courseid=266995218&clazzid=154464243&vc=1&cpi=1&ismooc2=1&v=2',
  } as Course;
  const r2 = await openCourseChapters(page, hooks, real);
  const reason2 = await diagnoseEmptyChapters(page);
  console.log(`   章节数=${r2.chapters.length}  诊断="${reason2}"`);
  check('真实课程能拿到任务点', r2.chapters.length > 0, `${r2.chapters.length} 个`);

  await browser.close();
  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('诊断测试异常：', e);
  process.exit(1);
});
