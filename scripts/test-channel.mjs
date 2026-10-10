/**
 * 验证「只配了多模态、没配 DeepSeek」的场景能正确走通。
 * 用户反馈：配置了多模态，答题却提示「未配置 DeepSeek API Key」。
 */

function pickChannel(vision, deepseekKey) {
  if (vision?.apiKey) {
    return { baseUrl: vision.baseUrl, apiKey: vision.apiKey, model: vision.model, label: '多模态' };
  }
  if (deepseekKey) {
    return { baseUrl: 'https://api.deepseek.com/v1', apiKey: deepseekKey, model: 'deepseek-chat', label: 'DeepSeek' };
  }
  return null;
}

const cases = [
  {
    name: '用户报告的场景：只配了多模态',
    vision: { baseUrl: 'https://tokendance.space/gateway/v1', apiKey: 'sk-vision-key', model: 'mimo-v2.6-flash' },
    deepseekKey: '',
    expect: '多模态',
  },
  {
    name: '只配了 DeepSeek（老用户）',
    vision: { baseUrl: 'https://tokendance.space/gateway/v1', apiKey: '', model: 'mimo-v2.6-flash' },
    deepseekKey: 'sk-ds-key',
    expect: 'DeepSeek',
  },
  {
    name: '两个都配了：应优先多模态',
    vision: { baseUrl: 'https://gateway/v1', apiKey: 'sk-vision', model: 'mimo' },
    deepseekKey: 'sk-ds',
    expect: '多模态',
  },
  {
    name: '都没配：应返回 null 并提示未配置',
    vision: { baseUrl: 'https://gateway/v1', apiKey: '', model: 'mimo' },
    deepseekKey: '',
    expect: null,
  },
];

console.log('=== 通道选择逻辑 ===');
let pass = 0;
for (const c of cases) {
  const ch = pickChannel(c.vision, c.deepseekKey);
  const got = ch ? ch.label : null;
  const ok = got === c.expect;
  if (ok) pass++;
  console.log(`  [${ok ? '✓' : '✗'}] ${c.name}`);
  console.log(`      期望 ${c.expect}，实得 ${got}`);
  if (ch) {
    console.log(`      → ${ch.baseUrl}/chat/completions`);
    console.log(`      → model=${ch.model}`);
  }
}

console.log(`\n${pass}/${cases.length} 通过`);
process.exit(pass === cases.length ? 0 : 1);