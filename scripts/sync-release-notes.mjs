/*
 * 发布说明单一来源同步器。
 *
 * 背景：GitHub 与 GitCode 两个发布脚本各内嵌一份 notes，历史上两次出现
 * 「两平台说明不同步」，根因就是在两个文件里各写一遍。本脚本把
 * docs/v<版本>发布说明.md 的「发布说明正文」段抽出，写进两个脚本的
 * `const notes = \`…\`;`，然后逐字比对两边是否一致。
 *
 * 用法：
 *   node scripts/local-sync-notes.mjs 2.1.2        # 同步 + 校验
 *   node scripts/local-sync-notes.mjs 2.1.2 --check # 只校验，不写文件
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ver = (process.argv[2] || '').replace(/^v/, '');
const checkOnly = process.argv.includes('--check');
if (!ver) {
  console.error('用法: node scripts/local-sync-notes.mjs <版本号> [--check]');
  process.exit(2);
}

const docPath = `docs/v${ver}发布说明.md`;
if (!existsSync(docPath)) {
  console.error(`✗ 找不到权威文本: ${docPath}`);
  process.exit(2);
}

const MARK = '## 二、发布说明正文（复制以下全部内容）';
const doc = readFileSync(docPath, 'utf-8');
const at = doc.indexOf(MARK);
if (at < 0) {
  console.error(`✗ ${docPath} 里找不到标记行「${MARK}」`);
  process.exit(2);
}
const body = doc.slice(at + MARK.length).trim();
if (!body) {
  console.error('✗ 正文为空');
  process.exit(2);
}
// 模板字符串里反引号与 ${ 要转义（正文用的是 Markdown 行内代码，带反引号）
const escaped = body.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

const files = ['scripts/local-release.mjs', 'scripts/local-gc-release.mjs'];
// 注意：正文里会有转义后的反引号（\`），所以不能简单地用 /`[\s\S]*?`;/ 去匹配——
// 那个正则会在第一个转义反引号处提前收尾，把脚本改坏。
const NOTES_RE = /const notes = `(?:[^`\\]|\\.)*`;/;
let changed = 0;

for (const f of files) {
  const src = readFileSync(f, 'utf-8');
  if (!NOTES_RE.test(src)) {
    console.error(`✗ ${f} 里找不到 const notes = \`…\`;`);
    process.exit(2);
  }
  const next = src.replace(NOTES_RE, () => 'const notes = `' + escaped + '`;');
  if (next === src) {
    console.log(`  · ${f} 已是最新`);
  } else if (checkOnly) {
    console.log(`  ✗ ${f} 与权威文本不一致`);
    process.exit(1);
  } else {
    writeFileSync(f, next, 'utf-8');
    console.log(`  ✓ ${f} 已同步`);
    changed++;
  }
}

// 逐字比对：两个脚本抽出来的 notes 必须完全相同
const grab = f => {
  const m = readFileSync(f, 'utf-8').match(/const notes = `((?:[^`\\]|\\.)*)`;/);
  // 源码里是转义后的形态，还原成真正的文本再比
  return m ? m[1].replace(/\\([`\\$])/g, '$1') : null;
};
const a = grab(files[0]);
const b = grab(files[1]);
if (a === null || b === null) {
  console.error('✗ 抽取 notes 失败');
  process.exit(2);
}
if (a !== b) {
  console.error('✗ 两平台 notes 不一致（这正是历史上出过两次的事故）');
  process.exit(1);
}
if (a !== body) {
  console.error('✗ 脚本内 notes 与权威文本不一致');
  process.exit(1);
}
console.log(`\n✓ 两平台 notes 逐字一致，且与 ${docPath} 一致（${body.length} 字符）`);
if (changed && checkOnly) process.exit(1);
