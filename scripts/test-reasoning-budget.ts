/**
 * 推理预算 —— 真实行为验证（无需登录、不碰真接口）。
 *
 * 用户日志暴露的故障：截图识别 HTTP 200、`content` 为空、只有 `reasoning_content`
 * （7544 字 / 4440 字），`max_tokens` 被推理吃光。真实接口探针复现并量出：
 *
 *   max_tokens=800    → finish=length，content 0 字，推理 1772 字就撞顶
 *   max_tokens=3200   → 用户日志里同样撞顶（推理 4440 字）
 *   max_tokens=16000  → finish=stop，出 11404 token（其中 11358 全是推理）、84 秒
 *
 * 结论（本次修复）：**第一发就给足预算**，不再「先饿一次再补」——饿那一轮纯属
 * 白花：烧掉整轮预算、拿回 0 字 content，然后升档再烧一遍。
 *
 * 本脚本起一个桩网关（OpenAI 兼容 /chat/completions），用真实浏览器页面喂
 * 真实的 VisionSearcher，断言：
 *   1. 第一发就是 16000（防止有人把起点再调小）
 *   2. 撞顶（finish=length）会升到 32000 重试，并把答案拿回来
 *   3. 两次都撞顶时退回已吐出的部分内容，而不是整批丢空
 *   4. 超时跟着预算一起放宽（否则故障只是换个面孔：从「content 为空」变「超时」）
 *
 * 用法：tsx scripts/test-reasoning-budget.ts
 */
import * as http from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { VisionSearcher } from '../src/main/engine/visionSearcher';
import type { QuizQuestion } from '../src/main/engine/quizTypes';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:sans-serif}
.q{height:150px;margin:8px;padding:8px;border:1px solid #ccc;font-size:14px}
</style></head><body>
<div class="q" data-qh-root="1">1. 设 A 为 3 阶方阵，|A|=2，则 |2A| =<br>A. 4　B. 8　C. 16　D. 6<div style="height:90px"></div></div>
<div class="q" data-qh-root="2">2. 矩阵可逆的充要条件是行列式<br>A. 大于 0　B. 不等于 0　C. 等于 1　D. 小于 0<div style="height:90px"></div></div>
</body></html>`;

const QUESTIONS: QuizQuestion[] = [
  { index: 1, stem: '', type: 'single', options: [{ label: 'A', text: '4' }, { label: 'B', text: '8' }, { label: 'C', text: '16' }, { label: 'D', text: '6' }], hasInput: false, encrypted: true },
  { index: 2, stem: '', type: 'single', options: [{ label: 'A', text: '大于0' }, { label: 'B', text: '不等于0' }, { label: 'C', text: '等于1' }, { label: 'D', text: '小于0' }], hasInput: false, encrypted: true },
];

const OK_BODY = { answers: [{ id: 1, choices: ['B'] }, { id: 2, choices: ['B'] }] };

/** 桩网关：按 mode 决定第几次请求返回「撞顶」 */
interface Hit {
  max_tokens?: number;
  temperature?: number;
  hasImages: number;
  minimal: boolean;
}
type Mode = 'ok' | 'truncate-then-ok' | 'always-truncate';

function makeServer(hits: Hit[], mode: Mode) {
  const srv = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
      return;
    }
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const user = (body.messages || []).find((m: any) => m.role === 'user');
      hits.push({
        max_tokens: body.max_tokens,
        temperature: body.temperature,
        hasImages: Array.isArray(user?.content) ? user.content.filter((p: any) => p.type === 'image_url').length : 0,
        minimal: !('max_tokens' in body),
      });

      const attempt = hits.length; // 第几次请求（从 1 开始）
      const truncate = mode === 'always-truncate' || (mode === 'truncate-then-ok' && attempt === 1);
      const content = truncate
        ? mode === 'always-truncate'
          ? JSON.stringify({ answers: [{ id: 1, choices: ['B'] }] }) // 部分：只答出第 1 题
          : ''
        : JSON.stringify(OK_BODY);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: truncate ? 'length' : 'stop',
              message: {
                role: 'assistant',
                content,
                reasoning_content: truncate ? '推理'.repeat(900) : '推理'.repeat(20),
              },
            },
          ],
          usage: { prompt_tokens: 1938, completion_tokens: truncate ? (body.max_tokens ?? 0) : 138 },
        })
      );
    });
  });
  return srv;
}

async function run(mode: Mode) {
  const hits: Hit[] = [];
  const logs: string[] = [];
  const srv = makeServer(hits, mode);
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as any).port;

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });

    const vs = new VisionSearcher({
      page,
      channel: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'stub-model', label: '多模态' },
      frameFor: () => page.mainFrame(),
      selectorFor: q => `[data-qh-root="${q.index}"]`,
      log: (_lv, m) => logs.push(m),
    });

    const got = await vs.invokeAll(QUESTIONS);
    return { hits, logs, got };
  } finally {
    await browser.close();
    await srv.close();
  }
}

async function main() {
  console.log('\n[A. 正常一轮：第一发就必须是足额预算]');
  {
    const { hits, logs, got } = await run('ok');
    check('只发 1 次请求', hits.length === 1, `实际 ${hits.length}`);
    check('第一发 max_tokens = 16000（不是 800/3200 那种饿着发）', hits[0]?.max_tokens === 16000, `实际 ${hits[0]?.max_tokens}`);
    check('带 temperature=0（不是最小体）', hits[0]?.temperature === 0 && !hits[0]?.minimal);
    check('题目截图真的带上去了', (hits[0]?.hasImages ?? 0) === 2, `实际 ${hits[0]?.hasImages}`);
    check('答案解析正确', got.get(1) === 'B' && got.get(2) === 'B', `实际 ${JSON.stringify([...got])}`);
    check('没有多余的升档噪音日志', !logs.some(m => m.includes('升到')), JSON.stringify(logs.filter(m => m.includes('升到'))));
  }

  console.log('\n[B. 撞顶：升档重试，并把答案拿回来（用户那条日志的正面版）]');
  {
    const { hits, logs, got } = await run('truncate-then-ok');
    check('发了 2 次请求', hits.length === 2, `实际 ${hits.length}`);
    check('第一发 16000，升档后 32000', hits[0]?.max_tokens === 16000 && hits[1]?.max_tokens === 32000, `实际 [${hits.map(h => h.max_tokens)}]`);
    check('重试提升了预算（不是原样重发）', (hits[1]?.max_tokens ?? 0) > (hits[0]?.max_tokens ?? 0));
    check('升档后拿到全部答案', got.get(1) === 'B' && got.get(2) === 'B', `实际 ${JSON.stringify([...got])}`);
    check('日志说明了「推理吃光预算 + 升到多少」', logs.some(m => m.includes('推理') && m.includes('16000') && m.includes('32000')), JSON.stringify(logs.filter(m => m.includes('推理'))));
    check('不再出现「请求失败」这种误判成答不出来的说法', !logs.some(m => m.includes('请求失败')));
  }

  console.log('\n[C. 两次都撞顶：退回已吐出的部分内容，而不是整批丢空]');
  {
    const { hits, logs, got } = await run('always-truncate');
    check('发了 2 次请求（升档一次就到顶）', hits.length === 2, `实际 ${hits.length}`);
    check('部分答案被采纳（第 1 题）', got.get(1) === 'B', `实际 ${JSON.stringify([...got])}`);
    check('只采纳能解析的那道，不硬造第 2 题', !got.has(2));
    check('日志如实说明改用部分内容', logs.some(m => m.includes('部分内容')), JSON.stringify(logs.filter(m => m.includes('部分'))));
  }

  console.log('\n[D. 源码闸门：预算与超时必须同改]');
  {
    const vs = readFileSync(new URL('../src/main/engine/visionSearcher.ts', import.meta.url), 'utf-8');
    const se = readFileSync(new URL('../src/main/engine/searcher.ts', import.meta.url), 'utf-8');
    const ag = readFileSync(new URL('../src/main/engine/agent/llm.ts', import.meta.url), 'utf-8');
    check('截图识别首发预算 ≥ 16000', /const VISION_MAX_TOKENS = (\d+)/.test(vs) && Number(vs.match(/const VISION_MAX_TOKENS = (\d+)/)![1]) >= 16000);
    check('截图识别超时 ≥ 180s（84 秒那次实测逼出来的）', /const VISION_TIMEOUT_MS = (\d+)/.test(vs) && Number(vs.match(/const VISION_TIMEOUT_MS = (\d+)/)![1]) >= 180000);
    check('文本答题超时 ≥ 180s', /const LIMIT_MS = (\d+)/.test(se) && Number(se.match(/const LIMIT_MS = (\d+)/)![1]) >= 180000);
    check('文本答题首发预算 ≥ 16000', /attempt === 0 \? (\d+)/.test(se) && Number(se.match(/attempt === 0 \? (\d+)/)![1]) >= 16000);
    check('两条路径都读 finish_reason（只看 content 为空分不清撞顶/截断/真空）', /finish === 'length'/.test(vs) && /finish_reason/.test(se));
    check('未接线的 agent 基座用同一个上限口径（以后接线不再踩）', /max_tokens: 16000/.test(ag) && !/max_tokens: 3000/.test(ag));
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('测试异常：', e);
  process.exit(1);
});
