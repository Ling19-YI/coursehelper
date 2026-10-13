/**
 * 生成推理预算探针要用的题图（无需登录、不碰超星）。
 *
 * 两种形态都要，因为推理长度差别很大：
 *   quiz.png   —— 5 道题拼在一张图上（模型一眼扫完，推理只有几百字）
 *   q1..q5.png —— 每题一张图（与 App 实际抓图方式一致，推理会涨到上千字）
 *
 * 只测前者会得出「800 token 预算足够」的错误结论，而真实场景是后者：
 * 实测 5 张不同的题图下 max_tokens=800 必然被推理吃光（finish=length、
 * content 0 字），要 16000 才 finish=stop。
 *
 * 用法：node scripts/probe-gen-quiz-images.mjs
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const QS = [
  ['设 A 为 3 阶方阵，|A| = 2，则 |2A| =', ['4', '8', '16', '6']],
  ['向量组 α1, α2, α3 线性无关，则 α1+α2, α2+α3, α3+α1 的秩为', ['1', '2', '3', '不确定']],
  ['若齐次线性方程组 Ax = 0 有非零解，则 A 的秩', ['等于未知量个数', '小于未知量个数', '大于未知量个数', '必为 0']],
  ['矩阵可逆的充要条件是行列式', ['大于 0', '小于 0', '不等于 0', '等于 1']],
  ['两个 n 阶矩阵 A、B 相似的充要条件是它们有相同的', ['秩', '行列式', '特征多项式', '若尔当标准形']],
];

const CSS = `body{font-family:"Microsoft YaHei",sans-serif;font-size:15px;padding:14px;background:#fff;color:#111;margin:0}
.q{margin:0 0 14px}
.t{font-weight:600;margin-bottom:8px;line-height:1.5}
.o{margin-left:22px;color:#222;line-height:1.7}`;

/** 单道题的 HTML 片段 */
const qHtml = ([t, os], i) =>
  `<div class="q"><div class="t">${i + 1}. ${t}</div>` +
  os.map((o, j) => `<div class="o">${'ABCD'[j]}. ${o}</div>`).join('') +
  `</div>`;

const doc = inner =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${inner}</body></html>`;

/** 每道题一张图（App 的真实形态） */
const one = (q, i) => doc(qHtml(q, i));

/** 五道题拼一张（对照组） */
const all = doc(QS.map(qHtml).join(''));

const dir = path.join(process.cwd(), '.probe');
mkdirSync(dir, { recursive: true });

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();

for (let i = 0; i < QS.length; i++) {
  await page.setContent(one(QS[i], i), { waitUntil: 'load' });
  const shot = await page.screenshot({ type: 'png', fullPage: true });
  writeFileSync(path.join(dir, `q${i + 1}.png`), shot);
}
await page.setContent(all, { waitUntil: 'load' });
writeFileSync(path.join(dir, 'quiz.png'), await page.screenshot({ type: 'png', fullPage: true }));

console.log(`已生成 .probe/quiz.png 与 .probe/q1..q${QS.length}.png`);
process.exit(0);
