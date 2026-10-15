/**
 * B站正片合规自检（M7 机器关 · 发布前必跑）
 *
 * 检查对象（ shipped artifacts ）：
 *   - promo/bilibili/src/render.html   （画面内全部文案，含 esbuild 前的源码形态；
 *                                       同时解码 \uXXXX 形态兜底）
 *   - promo/bilibili/src/narration.json（口播 = 字幕 = 配音的唯一数据源）
 *
 * 命中任一禁用词 → 退出码 1，构建失败。人工抽帧关（每 2s 一帧）在 M7 后半段。
 *
 * 词表与 promo/bilibili/制作计划.md 红线 1 保持一致，改一处必须同步另一处。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  path.join(root, 'promo', 'bilibili', 'src', 'render.html'),
  path.join(root, 'promo', 'bilibili', 'src', 'narration.json'),
];

const BANNED = [
  // 核心红线
  '刷课', 'shuake', '挂机', 'guaji', '挂G', '代刷', '外挂', '脚本',
  '作弊', '破解', '绕过验证', '硬闯',
  // 平台名（标题/标签/画面）
  '超星', '学习通',
  // 调性与效果承诺
  '倍速', '2x', '加速播放', '秒过', '包过', '满分', '无限', '永久', '代做', '代考',
  // 付费/引流语境
  '激活码', '收款', '打赏', '引流', '加群', '公众号',
];

let fail = 0;
const decode = s => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

for (const f of files) {
  const raw = readFileSync(f, 'utf-8');
  const text = decode(raw);
  const lower = text.toLowerCase();
  const rel = path.relative(root, f);
  for (const w of BANNED) {
    const n = lower.split(w.toLowerCase()).length - 1;
    if (n > 0) {
      const at = lower.indexOf(w.toLowerCase());
      console.log(`✗ ${rel} 命中「${w}」×${n}`);
      console.log(`   上下文: …${text.slice(Math.max(0, at - 30), at + 40).replace(/\n/g, ' ')}…`);
      fail += n;
    }
  }
}

// 反向断言：合规品牌文案必须在场（防止误改回旧文案而不自知）。
// 注意「开始运行」在截图 PNG 里（button 是图片的一部分），对 HTML 断言它会误报。
const render = decode(readFileSync(files[0], 'utf-8'));
for (const must of ['课程任务助手']) {
  if (!render.includes(must)) {
    console.log(`✗ render.html 缺少合规文案「${must}」——品牌切换可能失效`);
    fail++;
  }
}

console.log(fail === 0
  ? `✓ 合规自检通过（${files.length} 个文件 × ${BANNED.length} 个禁用词 = 0 命中）`
  : `✗ 共 ${fail} 处命中，禁止发布`);
process.exit(fail === 0 ? 0 : 1);
