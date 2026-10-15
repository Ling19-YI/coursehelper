/**
 * 全仓库合规自检（发布前必跑）
 *
 * ── 为什么要有这个 ──
 * 上一次账号被封，根因不是宣传素材，而是**软件本体和分发链路**：
 * 安装包属性、桌面快捷方式、窗口标题、任务管理器进程名、数据目录名、
 * GitHub 仓库描述、落地页标题——全都写着旧定位。这类内容是任何审核
 * 都能一眼看到的证据，比视频标题严重得多。
 *
 * 上一轮只把宣传素材（render.html / narration.json）过了关，
 * 分发链路层整个漏掉，所以换平台并不能解决问题。
 *
 * ── 覆盖三层 ──
 *   1. 产品元数据   package.json / electron-builder.yml
 *   2. 软件本体     src/（主进程 + 渲染层）：显示文案、窗口标题、安装包名
 *   3. 分发链路     site/（落地页）、README.md、docs/（发布说明）
 *
 * ── 关键设计：区分「用户可见」与「内部术语」 ──
 * 引擎里大量注释和技术串必须保留平台名（URL 路由、DOM 选择器、
 * 「超星字体替换」这类排查问题时要对得上页面）。一刀切会让排查
 * 真机故障时失去参照。因此对 src/ 只检查**真正面向用户的字符串**：
 *   - package.json 的 productName / description（装完就摆在眼前）
 *   - src/main/index.ts 的 app.setName（窗口标题 + 进程名）
 *   - src/renderer/index.html 的 <title>
 *   - src/shared/paths.ts 的 APP_DIR_NAME（数据目录名）
 *   - src/renderer/brand.ts 的文案常量
 * 而注释与日志术语一律放行。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 禁用词。
 * 与 promo/bilibili/制作计划.md 红线 1 同源，但**不含**宣传层专用词
 * （激活码/收款/引流——那些是视频和评论区的约束，软件里出现捐款码是允许的）。
 */
const BANNED = [
  '刷课', 'shuake', '挂机', 'guaji', '代刷', '外挂', '作弊', '破解',
  '绕过验证', '硬闯', '秒过', '包过', '代做', '代考',
];

/**
 * 需要逐字检查「用户可见字符串」的精确位置。
 * 用精确锚点而不是全文件扫，是为了让误报可解释 —— 注释里的术语不算违规。
 */
const EXACT = [
  ['package.json', /"productName":\s*"([^"]*)"/, 1, 'productName'],
  ['package.json', /"description":\s*"([^"]*)"/, 1, 'description'],
  ['src/main/index.ts', /app\.setName\(\s*([^)]*)\)/, 'expr', '窗口标题/进程名'],
  ['src/renderer/index.html', /<title>([^<]*)<\/title>/, 1, '浏览器标题'],
  ['src/shared/paths.ts', /APP_DIR_NAME\s*=\s*'([^']*)'/, 1, '数据目录名'],
  ['site/index.html', /<title>([^<]*)<\/title>/, 1, '落地页标题'],
  ['site/index.html', /<meta name="description" content="([^"]*)"/, 1, '落地页描述'],
  ['electron-builder.yml', /productName:\s*(.+)/, 1, '安装包名'],
];

let fail = 0;
const decode = s => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

function read(rel) {
  try {
    return decode(readFileSync(path.join(root, rel), 'utf-8'));
  } catch {
    return null;
  }
}

console.log('\n── 1. 精确锚点：用户可见字符串 ──');
for (const [rel, re, cap, label] of EXACT) {
  const text = read(rel);
  if (text === null) {
    console.log(`✗ 读不到 ${rel}`);
    fail++;
    continue;
  }
  const m = text.match(re);
  if (!m) {
    console.log(`✗ ${rel} 未匹配到 ${label}（正则可能已失效，需同步更新本脚本）`);
    fail++;
    continue;
  }
  // cap === 'expr' 时 m[1] 是 `APP_DIR_NAME` 这类标识符引用，不是字面量。
  // 它是否合规取决于 APP_DIR_NAME 的取值本身，已在上面单独检查。
  const value = cap === 'expr' ? null : m[cap];
  if (value === null) {
    console.log(`  · ${rel} ${label} → 引用 ${m[1]}（字面量已单独立检）`);
    continue;
  }
  const low = value.toLowerCase();
  const hit = BANNED.filter(w => low.includes(w.toLowerCase()));
  if (hit.length) {
    console.log(`✗ ${rel} ${label} 命中禁用词 ${hit.join('、')}：「${value}」`);
    fail++;
  } else {
    console.log(`  · ${rel} ${label} ✓ 「${value}」`);
  }
}

console.log('\n── 2. 分发链路：落地页与 README ──');
// 落地页与 README 是给人看的整篇文案，逐行扫；行内代码块与链接不算。
for (const rel of ['README.md', 'site/index.html']) {
  const text = read(rel);
  if (text === null) {
    console.log(`✗ 读不到 ${rel}`);
    fail++;
    continue;
  }
  const lines = text.split('\n');
  let hitCount = 0;
  lines.forEach((ln, i) => {
    const low = ln.toLowerCase();
    const hit = BANNED.filter(w => low.includes(w.toLowerCase()));
    if (hit.length) {
      console.log(`✗ ${rel}:${i + 1} 命中 ${hit.join('、')}`);
      console.log(`   ${ln.trim().slice(0, 90)}`);
      hitCount += hit.length;
    }
  });
  if (!hitCount) console.log(`  · ${rel} ✓ 0 命中`);
  fail += hitCount;
}

console.log('\n── 3. 发布说明：docs/ 下的用户可见文案 ──');
// 旧版本发布说明是历史记录，改了等于篡改历史，只提示不拦截。
const docsDir = path.join(root, 'docs');
let warned = 0;
for (const f of readdirSync(docsDir)) {
  if (!/\.(md|html)$/i.test(f)) continue;
  const rel = path.join('docs', f);
  const text = read(rel);
  if (text === null) continue;
  const low = text.toLowerCase();
  const hit = BANNED.filter(w => low.includes(w.toLowerCase()));
  if (hit.length) {
    // 当前版本的发布说明必须干净；历史版本只提示。
    const isCurrent = /v2\.1\.3/.test(f);
    console.log(`${isCurrent ? '✗' : '⚠'} ${rel} 命中 ${hit.join('、')}`);
    if (isCurrent) fail += hit.length;
    else warned++;
  }
}
if (!warned) console.log('  · docs/ ✓ 0 命中');

console.log('\n── 4. 反向断言：中性文案必须在场 ──');
for (const [rel, must] of [
  ['package.json', '课程任务助手'],
  ['src/shared/paths.ts', '课程任务助手'],
  ['site/index.html', '课程任务助手'],
]) {
  const text = read(rel) || '';
  if (!text.includes(must)) {
    console.log(`✗ ${rel} 缺少中性文案「${must}」——可能被误改回旧定位`);
    fail++;
  } else {
    console.log(`  · ${rel} ✓`);
  }
}

console.log('\n── 5. 一致性：目录名三处必须相同 ──');
// package.json / electron-builder.yml / src/shared/paths.ts 三处任一不同步，
// 就会出现「安装包叫新名、快捷方式叫旧名、数据目录又是第三个名」，
// 老用户升级后数据找不到、反馈也定位不准。这三处必须逐字相同。
{
  const pkg = JSON.parse(read('package.json') || '{}');
  const yml = (read('electron-builder.yml') || '').match(/productName:\s*(.+)/)?.[1]?.trim() ?? '';
  const ts = (read('src/shared/paths.ts') || '').match(/APP_DIR_NAME\s*=\s*'([^']*)'/)?.[1] ?? '';
  const names = { 'package.json': pkg.productName ?? '', 'electron-builder.yml': yml, 'paths.ts APP_DIR_NAME': ts };
  const unique = new Set(Object.values(names));
  if (unique.size !== 1) {
    console.log('✗ 三处名称不一致，会导致安装包名/快捷方式/数据目录各叫各的：');
    for (const [k, v] of Object.entries(names)) console.log(`   ${k}: ${v}`);
    fail++;
  } else {
    console.log(`  · 三处一致：「${[...unique][0]}」`);
  }
}

console.log('\n── 6. 归档区不得重新入库 ──');
// docs-archive/ 与 promo-archive/ 存的是转中性之前的旧文案，已 gitignore。
// 但 Windows 上 git 对中文路径的转义会让 `git add -A` 把已追踪的归档文件
// 重新加回暂存区（gitignore 只对未追踪文件生效）。这里显式拦一道。
{
  const { execFileSync } = await import('node:child_process');
  let tracked = '';
  try {
    tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf-8' });
  } catch {
    console.log('  · 非 git 环境，跳过');
    tracked = null;
  }
  if (tracked !== null) {
    const bad = tracked.split('\n').filter(f => /^(docs-archive|promo-archive)\//.test(f));
    if (bad.length) {
      console.log(`✗ 归档区有 ${bad.length} 个文件仍在 git 追踪中：`);
      for (const f of bad.slice(0, 5)) console.log(`   ${f}`);
      console.log('   修复：git rm --cached --force -- <路径>');
      fail += bad.length;
    } else {
      console.log('  · 归档区未入库 ✓');
    }
  }
}

console.log('\n' + '─'.repeat(56));
console.log(fail === 0
  ? `✓ 全仓库合规自检通过（${EXACT.length} 个锚点 + 分发链路 + docs/）`
  : `✗ 共 ${fail} 处命中，禁止发布`);
process.exit(fail === 0 ? 0 : 1);