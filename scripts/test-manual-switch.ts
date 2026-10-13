/**
 * 「用户中途手动切换章节，从手动点的这一节重新开始」的结构断言。
 *
 * 需求原话：「我希望用户中途手动切换章节后，能从手动点的这一节重新开始」。
 *
 * 难点不在「发现用户切走了」，而在**发现之后不能装作没事继续按本章记账**：
 * 新章节的视频会顺着同一段逻辑跑完，然后被 markChapterDone 记到旧章节头上
 * ——完成数虚增，真正做完的那节反而没记，续跑时还会被永久跳过。
 *
 * 这里守住三层：
 *   1. 章节识别只认地址栏，判不准就别判（判错的代价是把用户拽走）
 *   2. 长循环（等视频 / 过文档）每轮问一次，命中立刻让位
 *   3. 记账只有一个出口，且出口带闸
 */
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { chapterIdOf } from '../src/main/engine/chaoxing';

const root = new URL('../src/main/engine/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, root), 'utf8');

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
};

const chaoxing = read('chaoxing.ts');
const index = read('index.ts');
const video = read('video.ts');
const document = read('document.ts');
const hooks = read('hooks.ts');
const types = readFileSync(new URL('../src/shared/types.ts', import.meta.url), 'utf8');
const util = readFileSync(new URL('../src/renderer/util.ts', import.meta.url), 'utf8');

// ═══ 1. 章节 id：只取 toOld 的第二个参数 ═══
console.log('\n[章节 id 解析]');
check(
  'toOld(courseId, chapterId, clazzId, 0) 取第二个参数',
  chapterIdOf('toOld(123456, 654321, 111, 0)') === '654321',
  `实际 ${chapterIdOf('toOld(123456, 654321, 111, 0)')}`
);
check(
  '无空格/带引号/多参也能取对',
  chapterIdOf('toOld(123456,654321,111,0)') === '654321' &&
    chapterIdOf("toOld('123456', '654321', '111', 0)") === '654321'
);
check(
  '不是 toOld 的 onclick 返回 null（不硬凑）',
  chapterIdOf('void(0)') === null && chapterIdOf('') === null && chapterIdOf('toOld(1)') === null
);
check(
  '不把第一个参数（courseId）当章节 id',
  chapterIdOf('toOld(123456, 654321, 111, 0)') !== '123456',
  '同门课所有章节的 courseId 相同，认错会把每一节都判成第 1 节'
);
check(
  '导出 chapterIdOf / readCurrentChapterId',
  /export function chapterIdOf\(/.test(chaoxing) &&
    /export function readCurrentChapterId\(/.test(chaoxing),
  '缺导出'
);

// ═══ 2. 当前章节 id 只认顶层地址，不做猜测 ═══
console.log('\n[当前章节识别：宁可不判，不可判错]');
check(
  'readCurrentChapterId 只读 page.url()',
  /export function readCurrentChapterId\(page: Page\)[\s\S]{0,400}page\.url\(\)/.test(chaoxing),
  '没读地址栏'
);
check(
  '不遍历 iframe 地址（返回课程后旧内容 iframe 还残留上一节的 chapterId）',
  !/export function readCurrentChapterId[\s\S]{0,900}page\.frames\(\)/.test(chaoxing),
  '读 frame 地址会把「上一节」判成「用户切走了」，来回弹跳'
);
check(
  '没有用目录高亮态兜底（类名各版本不一致，猜错就把用户拽走）',
  !/export function readCurrentChapterId[\s\S]{0,900}posCatalog_select/.test(chaoxing),
  '拿不可靠信号兜底'
);
check(
  '读不到 chapterId 时返回 null（=没发生）',
  /return m \? decodeURIComponent\(m\[1\]\) : null;/.test(chaoxing) &&
    /chapterId=\(\[\^&#\]\+\)/.test(chaoxing),
  '缺 null 语义'
);

// ═══ 3. 跟随开关：定时器 + 内存标记 ═══
console.log('\n[跟随开关]');
check(
  '引擎有开始/停止跟随的定时器',
  /private startChapterWatch\(chapters: Chapter\[\]\)/.test(index) &&
    /private stopChapterWatch\(\)/.test(index) &&
    /private resetChapterWatch\(\)/.test(index),
  '缺生命周期管理'
);
check(
  '定时器 unref（不拖住进程退出）',
  /this\.navTimer\.unref\?\.\(\)/.test(index),
  '定时器会让退出挂住'
);
check(
  '轮询周期 3s 且只读地址栏（同步，无竞态）',
  /setInterval\(\(\) => void this\.pollChapterWatch\(\), 3000\)/.test(index) &&
    /private pollChapterWatch\(\): void/.test(index),
  '异步轮询需要额外互斥，容易引入新竞态'
);
check(
  '命中后只置内存标记，不再重复判定',
  /if \(this\.manualJumpIndex >= 0\) return;\s*\n\s*const expect = this\.expectedChapterOnclick/.test(
    index
  ),
  '重复判定会刷屏'
);
check(
  '映射不上任何一节就不下结论',
  /const idx = this\.chapterList\.findIndex\(c => chapterIdOf\(c\.onclick\) === seen\)/.test(index) &&
    /if \(idx < 0\) return;/.test(index),
  '换了门课/别的 id 形式时会误判'
);
check(
  '本章 id 取不到时不判（没有可比基准就别下结论）',
  /const here = chapterIdOf\(expect\);[\s\S]{0,300}if \(!here\) return;/.test(index) &&
    /if \(here === seen\) return;/.test(index),
  '拿不到本章 id 还去比对，会把本章判成「切走了」'
);
check(
  'hooks 暴露 chapterLeft（纯内存读，长循环可每轮问）',
  /chapterLeft\(\): boolean;/.test(hooks) && /chapterLeft: \(\) => this\.manualJumpIndex >= 0/.test(index),
  '长循环拿不到让位信号'
);
check(
  '收尾时停表并清状态',
  /this\.resetChapterWatch\(\);/.test(index) && /finally \{[\s\S]{0,300}resetChapterWatch/.test(index),
  '定时器会活到下一次任务'
);

// ═══ 4. 长循环必须每轮让位（等视频可能几十分钟）═══
console.log('\n[长循环让位]');
check(
  "VideoResult 有 'left'",
  /export type VideoResult = 'completed' \| 'no_video' \| 'stuck' \| 'unexpected' \| 'left';/.test(
    video
  ),
  ''
);
check(
  'waitForVideoEnd 每轮开头就问 chapterLeft 并立刻返回 left',
  /while \(true\) \{\s*\n\s*ctl\.throwIfStopped\(\);\s*\n\s*iteration\+\+;[\s\S]{0,600}if \(h\.chapterLeft\(\)\) return 'left';/.test(
    video
  ),
  '用户切走后还会把新章节的视频当成本章的继续等、继续播'
);
check(
  "DocResult 有 'left'",
  /export type DocResult = 'scrolled' \| 'unsupported' \| 'left';/.test(document),
  ''
);
check(
  'handleDocument 在进入时与滚动循环里都问一次',
  (document.match(/if \(h\.chapterLeft\(\)\) return 'left';/g) || []).length >= 2,
  '滚动 60 步最长 48s，不问就会对着新章节的容器滚'
);

// ═══ 5. 记账只有一个出口，且出口带闸 ═══
console.log('\n[记账不能记错章节]');
check(
  'index 里 markChapterDone 只出现在 markDone 里',
  (index.match(/this\.store\.markChapterDone\(/g) || []).length === 1 &&
    /const markDone = \(\): boolean => \{\s*\n\s*if \(this\.manualJumpIndex >= 0\) return false;/.test(
      index
    ),
  '有绕过闸门的记账点'
);
check(
  '三条完成路径都走 markDone()',
  (index.match(/if \(markDone\(\)\) summary\.completed\+\+;/g) || []).length === 2 &&
    /if \(credited && markDone\(\)\) \{/.test(index),
  '答题/视频/文档里有直接记账的'
);
check(
  '本轮切走了就一律改判成 user_switched',
  /if \(this\.manualJumpIndex >= 0 && result !== 'user_switched'\) \{\s*\n\s*result = 'user_switched';/.test(
    index
  ),
  '本章的结论（跳过/未完成）会盖到用户刚打开的新页面上'
);
check(
  "ChapterResult 含 'user_switched' 且渲染层有中文标签",
  /'user_switched'/.test(types) && /user_switched: \{ text: '/.test(util),
  '新结果会以红字原样显示 key'
);

// ═══ 6. 重新定位：从他点开的那一节继续 ═══
console.log('\n[从手动点开的那一节重新开始]');
check(
  '让位集中在 takeManualJump 一处',
  /private async takeManualJump\(/.test(index) &&
    /if \(this\.manualJumpIndex < 0\) return null;/.test(index),
  '缺统一入口，逻辑会散在多处'
);
check(
  '两种时机都让位：进下一节之前 / 本章内层循环结束后',
  (index.match(/await this\.takeManualJump\(chapters, !!options\.resume, progress\)/g) || []).length === 2,
  '只在内层循环后让位的话，「返回课程」那几秒里用户点的章节会被无视'
);
check(
  '外层游标挪到用户点开的那一节',
  /const jumpedHere = await this\.takeManualJump[\s\S]{0,200}i = jumpedHere - 1;/.test(index) &&
    /const jumped = await this\.takeManualJump[\s\S]{0,200}i = jumped - 1;/.test(index),
  '没有重新定位，下一轮又回到原处'
);
check(
  '「他那一页还开着」必须用地址栏核实，不能只信标记',
  /const stillOpen =\s*\n\s*!!wantId && !willSkip && readCurrentChapterId\(this\.opts\.page\) === wantId;/.test(
    index
  ),
  '我们自己的导航（返回课程/点下一节）会把标记变成假话，照标记跳过点击就会在错页面上记账'
);
check(
  '已在屏幕上的那一节不再点目录',
  /if \(stillOpen\) \{\s*\n\s*this\.preopenedOnclick = target\.onclick;/.test(index) &&
    /const claimedOpen = this\.preopenedOnclick === chapter\.onclick;/.test(index),
  '点目录会把用户从他点开的那一节拽回目录再跳一次'
);
check(
  '进入前再核一次，对不上就先回目录',
  /let alreadyOpen = claimedOpen && !!enterId && readCurrentChapterId\(this\.opts\.page\) === enterId;/.test(
    index
  ) && /if \(claimedOpen && !alreadyOpen\) \{[\s\S]{0,300}await goBackToCourse/.test(index),
  '页面被刷新走时会对着没有目录的页面找条目'
);
check(
  '目标节本地已完成时先回目录（否则后面每节都进不去）',
  /const willSkip = resume && !!progress\?\.completedChapters\.includes\(target\.onclick\);/.test(
    index
  ) && /if \(stillOpen\) \{[\s\S]{0,600}else \{[\s\S]{0,400}await goBackToCourse/.test(index),
  '跳过目标节后手上没有目录，后续 clickChapter 全部失败'
);
check(
  '导航期间挂起跟随（换章节时清空期望值）',
  /\/\/ 换章节前先把跟随目标清空[\s\S]{0,200}this\.expectedChapterOnclick = '';/.test(index) &&
    /this\.expectedChapterOnclick = chapter\.onclick;/.test(index),
  '我们自己的导航会被当成用户切章节'
);

// ═══ 7. 纯函数自检（上面几条的运行时对照）═══
console.log('\n[chapterIdOf 边界]');
assert.equal(chapterIdOf('toOld(1, 2, 3, 0)'), '2');
assert.equal(chapterIdOf('toOld(1,2,3)'), '2');
assert.equal(chapterIdOf('javascript:void(0)'), null);
check('chapterIdOf 运行时行为与断言一致', true);

if (failed) {
  console.error(`\n${failed} 项断言失败`);
  process.exit(1);
}
console.log('\n全部通过');
