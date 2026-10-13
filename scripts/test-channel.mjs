/**
 * 验证 AI 通道选择逻辑：只有多模态一条，且密钥与地址必须同时存在。
 *
 * 历史背景：曾经有第二条通道（旧版 DeepSeek 单密钥回退），造成
 * 「本地可以、用户无解」——两条路径配置真相不一致，其中一条还没有
 * 界面能维护，失效时完全静默。双通道已整体移除，本测试锁住单通道语义。
 */

// 与 ChaoxingEngine.visionChannel() 保持一致的唯一实现
function pickChannel(vision) {
  if (vision?.apiKey && vision.baseUrl) {
    return { baseUrl: vision.baseUrl, apiKey: vision.apiKey, model: vision.model, label: '多模态' };
  }
  return null;
}

const cases = [
  {
    name: '密钥与地址都配了：唯一通道就绪',
    vision: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test-placeholder', model: 'mimo-v2.6-flash' },
    expect: '多模态',
  },
  {
    name: '只配了密钥、地址为空：必须是 null（静默失能事故的根源）',
    vision: { baseUrl: '', apiKey: 'sk-only-key', model: 'mimo-v2.6-flash' },
    expect: null,
  },
  {
    name: '只配了地址、密钥为空：必须是 null',
    vision: { baseUrl: 'https://gateway/v1', apiKey: '', model: 'mimo' },
    expect: null,
  },
  {
    name: '都没配：null',
    vision: { baseUrl: '', apiKey: '', model: 'mimo' },
    expect: null,
  },
  {
    name: '地址带尾斜杠：不影响通道建立（fetch 时会归一化）',
    vision: { baseUrl: 'https://gateway/v1/', apiKey: 'sk-x', model: 'mimo' },
    expect: '多模态',
  },
];

console.log('=== AI 通道选择逻辑（单通道）===');
let pass = 0;
for (const c of cases) {
  const ch = pickChannel(c.vision);
  const got = ch ? ch.label : null;
  const ok = got === c.expect;
  if (ok) pass++;
  console.log(`  [${ok ? '✓' : '✗'}] ${c.name}`);
  console.log(`      期望 ${c.expect}，实得 ${got}`);
  if (ch) {
    console.log(`      → ${ch.baseUrl.replace(/\/$/, '')}/chat/completions`);
    console.log(`      → model=${ch.model}（文本答题与看图解题共用）`);
  }
}

console.log(`\n${pass}/${cases.length} 通过`);
process.exit(pass === cases.length ? 0 : 1);
