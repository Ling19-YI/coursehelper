/**
 * AI 答题链路「静默失能」问题的静态结构断言。
 *
 * 背景（v2.1.0 用户反馈）：配了 API Key，答题时日志只有「无解，留空」，
 * 没有任何 AI 解题迹象，用户完全不知道该换 key、换模型名还是填地址。
 * 逐个读代码发现四层问题，全是「不抛异常、编译通过、运行时静默」型：
 *
 *   1. resolveAnswers 的 catch 只 console.warn —— 那是主进程终端输出，
 *      用户日志面板永远看不到 AI 失败原因（401/超时/格式错全被吞）
 *   2. askAI 的错误不带响应体 —— 「接口 400」分不清是模型名错、
 *      参数不支持还是地址错；且不处理推理模型 content 为空
 *   3. ipc vision:get 的 configured 只看 key 不看地址，而引擎要求两者
 *      都有 → 设置页显示「已配置」、引擎算出空通道，两边定义不一致
 *   4. 启动自检只说「未配置」，不说缺哪一半
 *
 * 这些都不会抛异常，只能靠结构断言守住。
 */
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const root = new URL('../src/main/engine/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, root), 'utf8');
const readRoot = (f: string) => readFileSync(new URL(f, new URL('../', import.meta.url)), 'utf8');

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
};

const searcher = read('searcher.ts');
const quiz = read('quiz.ts');
const index = read('index.ts');
const ipc = readRoot('src/main/ipc.ts');
const settings = readRoot('src/renderer/pages/Settings.tsx');

// ---- 1. resolveAnswers 必须把失败报到界面 ----
check(
  'resolveAnswers 有 onError 参数',
  /onError\?: \(searcherName: string, err: any\) => void/.test(searcher),
  '缺 onError 签名'
);
check(
  'catch 里调用 onError（不只是 console.warn）',
  /console\.warn\([^)]*\);?\s*\n\s*onError\?\.\(s\.name, e\)/.test(searcher),
  '失败仍只进主进程终端，用户看不到'
);

// ---- 2. handleQuiz 把 AI 失败写进日志面板 ----
check(
  'handleQuiz 调用 resolveAnswers 时传了错误回调',
  /resolveAnswers\(\s*plain,\s*chain,[\s\S]{0,200}name, e/.test(quiz),
  '未接线：AI 失败仍然静默'
);
check(
  '未配置 AI 接口的提示指向设置项',
  /未配置 AI 接口\\u0028|未配置 AI 接口\uff08|未配置 AI 接口（设置/.test(quiz) ||
    /\\u8bbe\\u7f6e \\u2192 \\u591a\\u6a21\\u6001/.test(quiz),
  '提示没说去哪配'
);

// ---- 3. askAI 的错误必须带响应体 ----
check(
  'askAI 非 2xx 时读取响应体拼进错误',
  /\(await resp\.text\(\)\)\s*\n?\s*\.replace\(\/\\s\+\/g, ' '\)\.slice\(0, 300\)/.test(searcher) ||
    /detail = \(await resp\.text\(\)\)\.replace/.test(searcher),
  '「接口 400」不带响应体，分不清模型名错/参数不支持/地址错'
);
check(
  'askAI 处理推理模型 content 为空',
  /reasoning_content/.test(searcher),
  '推理模型把 token 花在 reasoning 上时会整批废掉'
);
check(
  'askAI 区分空响应体与非 JSON',
  /返回空响应体/.test(searcher) && /返回非 JSON/.test(searcher),
  '空体/SSE/截断看不出区别'
);
check(
  'askAI 401/402 直接抛出不重试',
  /接口 \(401\|402\)/.test(searcher),
  '鉴权失败重试三次是浪费'
);
check(
  'askai 有最小体重试（绕过不收 temperature 的网关）',
  /minimal = attempt === 2/.test(searcher),
  '部分自建网关 400 于 temperature/max_tokens'
);

// ---- 4. ipc 的 configured 判定必须和引擎一致（key && baseUrl）----
check(
  'vision:get 的 configured 同时要求 key 和 baseUrl',
  /configured = !!key && !!baseUrl/.test(ipc),
  '只看 key → 设置页说已配置、引擎算空通道'
);

// ---- 5. 启动自检说清缺哪一半 ----
check(
  '启动自检列出缺失项（API Key / 接口地址）',
  /missing\.push\('API Key'\)/.test(index) && /missing\.push\('接口地址'\)/.test(index),
  '「未配置」不说缺什么，用户无从下手'
);

// ---- 6. 设置页拦阻「有 key 无地址」 ----
check(
  '设置页保存时拦截空地址',
  /已填写 API Key 但接口地址为空/.test(settings),
  '缺保存校验'
);
check(
  '设置页地址为空时给 Inline 警示',
  /接口地址为空：密钥已保存但 AI 答题不会被调用/.test(settings),
  '缺 Inline 提示'
);

if (failed) {
  console.error(`\n${failed} 项断言失败`);
  process.exit(1);
}
console.log('\n全部通过');
