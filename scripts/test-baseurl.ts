import { normalizeBaseUrl as n } from '../src/shared/baseUrl';

const cases: Array<[string, string]> = [
  ['https://open.bigmodel.cn/api/paas/v4/chat/completions', 'https://open.bigmodel.cn/api/paas/v4'],
  ['https://open.bigmodel.cn/api/paas/v4/chat/completions/', 'https://open.bigmodel.cn/api/paas/v4'],
  ['https://open.bigmodel.cn/api/paas/v4/', 'https://open.bigmodel.cn/api/paas/v4'],
  ['https://api.deepseek.com', 'https://api.deepseek.com'],
  ['https://api.deepseek.com/chat/completions', 'https://api.deepseek.com'],
  ['  https://api.example.com/v1  ', 'https://api.example.com/v1'],
  ['"https://api.example.com/v1"', 'https://api.example.com/v1'],
  ['HTTPS://X.COM/v1/Chat/Completions', 'HTTPS://X.COM/v1'],
  ['https://host/v1beta/openai/chat/completions', 'https://host/v1beta/openai'],
  ['', ''],
];

let ok = true;
for (const [input, want] of cases) {
  const got = n(input);
  if (got !== want) {
    ok = false;
    console.log('FAIL', JSON.stringify(input), '->', got, 'want', want);
  }
}
console.log(ok ? `ALL PASS (${cases.length})` : 'FAILED');
if (!ok) process.exit(1);
