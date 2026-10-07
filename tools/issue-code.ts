import { sign, createPrivateKey } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { verifyCode } from '../src/main/licensing';

/**
 * 发码脚本（私钥仅存本机 tools/keys/private.pem，绝不进仓库）
 * 用法:
 *   npx tsx tools/issue-code.ts            生成一个永久码
 *   npx tsx tools/issue-code.ts --days 30  30 天有效期
 *   npx tsx tools/issue-code.ts --id A1B2C3 指定 codeId
 */
const keysDir = path.resolve('tools/keys');
const privFile = path.join(keysDir, 'private.pem');
if (!fs.existsSync(privFile)) {
  console.error('未找到私钥，请先运行: npx tsx tools/gen-keypair.ts');
  process.exit(1);
}

const args = process.argv.slice(2);
const daysIdx = args.indexOf('--days');
const days = daysIdx >= 0 ? parseInt(args[daysIdx + 1], 10) : 0;
const idIdx = args.indexOf('--id');
const id = idIdx >= 0 ? args[idIdx + 1] : Math.random().toString(36).substring(2, 8).toUpperCase();

const payload: { id: string; v: number; iat: number; exp?: number } = {
  id,
  v: 1,
  iat: Date.now(),
};
if (days > 0) payload.exp = Date.now() + days * 24 * 3600 * 1000;

const bodyBytes = Buffer.from(JSON.stringify(payload), 'utf-8');
const bodyB64 = bodyBytes.toString('base64url');
const privPem = fs.readFileSync(privFile, 'utf-8');
const sig = sign(null, bodyBytes, createPrivateKey(privPem));
const code = `CH1.${bodyB64}.${sig.toString('base64url')}`;

const check = verifyCode(code);
if (!check.ok) {
  console.error('自检失败:', check.message);
  process.exit(1);
}

console.log('激活码:');
console.log(code);
console.log('');
console.log(`codeId=${id}  有效期=${days > 0 ? days + ' 天' : '永久'}  自检=PASS`);
