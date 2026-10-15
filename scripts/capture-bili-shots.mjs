/**
 * 宣传素材截图（B站正片专用 · 合规皮肤版）
 *
 * 与旧的 capture-app.mjs 不同：不启动已安装的 Electron 应用，而是——
 *   1) 用 CH_BRAND=compliant 构建出的渲染层产物（app/renderer，品牌文案已切换）
 *   2) 起本地静态服务 + Playwright addInitScript 注入假的 window.ch（mock IPC）
 *   3) 截 .panel 元素 → promo/bilibili/shots/
 *
 * 好处：
 *   - 画面里没有任何真实账号/课程/本机路径（假数据全是通用课程名 + 掩码手机号）
 *   - 不用装/卸安装包，不会动用户机器上的应用
 *   - 日志内容完全可控——只写合规措辞，天然过禁用词表
 *
 * 前置：CH_BRAND=compliant npx vite build（见 package.json 注释）
 * 用法：node scripts/capture-bili-shots.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'app', 'renderer');
const outDir = path.join(root, 'promo', 'bilibili', 'shots');
if (!existsSync(dist)) {
  console.error('未找到 app/renderer，先跑：CH_BRAND=compliant npx vite build');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

/* ---------- 假数据（全部通用化，无真实信息） ---------- */
const COURSES = [
  { index: 1, name: '大学英语（二）', url: '#', courseId: 'c-eng2' },
  { index: 2, name: '高等数学 B', url: '#', courseId: 'c-math' },
  { index: 3, name: '中国近现代史纲要', url: '#', courseId: 'c-history' },
  { index: 4, name: '数据结构', url: '#', courseId: 'c-ds' },
  { index: 5, name: '马克思主义基本原理', url: '#', courseId: 'c-marx' },
  { index: 6, name: '大学物理（上）', url: '#', courseId: 'c-phy' },
];

const MOCK = `
const SETTINGS = {
  autoResume: true, startMinimized: false,
  dataDir: 'D:\\\\CourseHelperData',
  videoSpeed: 1, muted: true,
  agentEnabled: true, answerPopup: false, autoPauseOnVerify: false,
  submitCoverRate: 0.8,
  visionBaseUrl: 'https://api.deepseek.com/v1',
  visionModel: 'deepseek-flash',
  windowBounds: null,
};
window.__SETTINGS = SETTINGS;
window.ch = {
  getSettings: async () => SETTINGS,
  setSettings: async (patch) => { Object.assign(SETTINGS, patch); return SETTINGS; },
  getUsername: async () => '138****6621',
  setCredentials: async () => {}, clearCredentials: async () => {},
  getAppInfo: async () => ({ version: '2.1.2', userData: '', dataDir: '' }),
  getProgress: async () => [],
  getState: async () => ({ state: 'idle', running: false, mode: 'embedded' }),
  listCourses: async () => ${JSON.stringify(COURSES)},
  start: async () => {}, pause() {}, resume() {}, stop() {},
  onEngineEvent: (fn) => { window.__emit = fn; return () => {}; },
  onPanelWidth: (fn) => { fn(760); return () => {}; },
  getVision: async () => ({ configured: true, hint: '••••••a1b2' }),
  setVision: async () => ({ configured: true }),
  checkUpdate: async () => {}, downloadUpdate() {}, installUpdate() {},
  getUpdateState: async () => ({ checking: false, available: false }),
  onUpdateEvent: () => () => {},
};
`;

/* ---------- 合规日志剧本（给日志页截图用） ---------- */
const LOG_SCRIPT = [
  ['state', { type: 'state', state: 'running', detail: '正在处理已选课程' }],
  ['ok', '✓ 已登录课程平台'],
  ['ok', 'AI 通道自检：就绪（deepseek-flash，答题与看图解题共用）'],
  ['info', '▶ 第 3/12 节：大学英语（二）'],
  ['info', '  · 课件播放中 05:12 / 12:40'],
  ['video', { type: 'video', chapter: '大学英语（二）', ct: 312, d: 760, paused: false }],
  ['ok', '✓ 第 3 节完成，平台已记录'],
  ['chapter', { type: 'chapter', index: 4, total: 12, name: '数据结构', result: '' }],
  ['info', '▶ 第 4/12 节：数据结构'],
  ['info', '  · 文档浏览 8 / 21 页'],
  ['info', '  · 进度已保存，可随时暂停'],
  ['ok', '✓ 第 4 节完成'],
  ['info', '▶ 第 5/12 节：中国近现代史纲要'],
  ['info', '  · 课件播放中 01:05 / 09:30'],
];

/* ---------- 静态服务 ---------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const f = path.join(dist, p);
  try {
    const buf = readFileSync(f);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end('nf');
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
console.log('静态服务:', `http://127.0.0.1:${port}`);

/* ---------- 截图 ---------- */
const { chromium } = await import('playwright-core');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 780, height: 1000 }, deviceScaleFactor: 2 });
page.on('pageerror', e => console.error('[pageerror]', e.message));
await page.addInitScript(MOCK);
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForSelector('text=课程任务助手', { timeout: 15000 });
await page.waitForTimeout(400);

const shot = async name => {
  const el = page.locator('.panel');
  await el.screenshot({ path: path.join(outDir, name) });
  console.log('✓', name);
};
const nav = async label => {
  await page.click(`.ant-menu >> text=${label}`);
  await page.waitForTimeout(350);
};

// 1) 课程页：全选 → 任务页（dashboard 显示「已选 6 门」+ 开始运行按钮）
await nav('课程');
await page.click('button:has-text("全选")');
await page.waitForTimeout(250);
await shot('bili-panel-courses.png');

await nav('任务');
await page.waitForTimeout(250);
await shot('bili-panel-dashboard.png');

// 2) 日志页：先切过去（组件挂载订阅事件），再喂剧本
await nav('日志');
await page.evaluate(script => {
  let ts = Date.now() - script.length * 9000;
  for (const [kind, payload] of script) {
    if (typeof payload === 'string') window.__emit({ type: 'log', level: kind, msg: payload, ts: (ts += 9000) });
    else window.__emit({ ...payload, ts: (ts += 9000) });
  }
}, LOG_SCRIPT);
await page.waitForTimeout(400);
await shot('bili-panel-monitor.png');

// 3) 设置页（备选用）
await nav('设置');
await page.waitForTimeout(300);
await shot('bili-panel-settings.png');

await browser.close();
server.close();
console.log('\n全部输出到', outDir);
