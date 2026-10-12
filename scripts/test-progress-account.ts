/**
 * 验证进度按 (账号, courseId) 归属。
 *
 * 用户反馈：换了舍友的账号后，检测不到任务点 / 任务点不刷。
 * 主因是课表缓存（已在 ipc.ts 修），次因是进度文件只按 courseId 命名——
 * 同一门课被两个账号选修时，后一个账号会拿前一个的完成记录去跳过章节。
 *
 * 本脚本直接实例化 ProgressStore，用临时目录验证归属判定。
 *
 * 用法：tsx scripts/test-progress-account.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProgressStore } from '../src/main/engine/progress';
import type { CourseProgress } from '../src/shared/types';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`);
  }
}

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-progress-'));
  const store = new ProgressStore(dir);
  const COURSE = '266995218';
  const A = '13800001111';
  const B = '18305897195';

  const mk = (account?: string): CourseProgress => ({
    courseId: COURSE,
    courseName: '计算机图形学原理',
    completedChapters: ["toOld('1', '11', '111',0)"],
    lastChapter: "toOld('1', '11', '111',0)",
    updatedAt: Date.now(),
    ...(account ? { account } : {}),
  });

  console.log('\n[同账号]');
  store.save(mk(A));
  const same = store.load(COURSE, A);
  check('同账号能读到自己的进度', !!same && same.completedChapters.length === 1);

  console.log('\n[换账号：不得串用]');
  const other = store.load(COURSE, B);
  check('换账号后读不到别人的进度', other === null, `实际 ${JSON.stringify(other)}`);

  console.log('\n[老数据兼容]');
  // 老版本写的进度文件没有 account 字段
  fs.writeFileSync(
    path.join(dir, `${COURSE}.json`),
    JSON.stringify({
      courseId: COURSE,
      courseName: '计算机图形学原理',
      completedChapters: ['legacy'],
      lastChapter: 'legacy',
      updatedAt: Date.now(),
    })
  );
  const legacy = store.load(COURSE, B);
  check('老进度不认账号，沿用不丢', !!legacy && legacy.completedChapters.includes('legacy'));

  console.log('\n[不传账号：向后兼容]');
  store.save(mk(A));
  const noAcc = store.load(COURSE);
  check('调用方不传账号时不过滤', !!noAcc);

  console.log('\n[save 后归属被记录]');
  const fresh = mk(B);
  store.save(fresh);
  const afterB = store.load(COURSE, B);
  const afterA = store.load(COURSE, A);
  check('新写入的进度归属当前账号', !!afterB && afterB.account === B);
  check('原账号此时读不到（文件已被覆盖）', afterA === null);

  console.log('\n[listAll 仍可用]');
  const all = store.listAll();
  check('listAll 返回全部进度', all.length === 1 && all[0].courseId === COURSE, `${all.length} 条`);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
