import { generateKeyPairSync, createPublicKey, createPrivateKey, sign, verify } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 生成 Ed25519 密钥对（只在本机运行一次）：
 *  - private.pem  → 私钥，留在本机，绝不进仓库
 *  - src/main/licensing/public-key.ts → 内置公钥
 */
const keysDir = path.resolve('tools/keys');
if (!fs.existsSync(keysDir)) fs.mkdirSync(keysDir, { recursive: true });

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

fs.writeFileSync(path.join(keysDir, 'private.pem'), privPem, { mode: 0o600 });
fs.writeFileSync(path.join(keysDir, 'public.pem'), pubPem);

const pubJwk = createPublicKey(pubPem).export({ format: 'jwk' }) as any;
const rawPub = Buffer.from(pubJwk.x, 'base64url').toString('base64url');

const out = `// 由 tools/gen-keypair.ts 生成，勿手工修改
export const PUBLIC_KEY_B64URL = '${rawPub}';
`;

const target = path.resolve('src/main/licensing/public-key.ts');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, out);

// 自检：能用私钥签名并被公钥验证
const msg = Buffer.from('selftest');
const sig = sign(null, msg, createPrivateKey(privPem));
const ok = verify(null, msg, createPublicKey(pubPem), sig);

console.log('已生成:');
console.log('  tools/keys/private.pem  (私钥，保密)');
console.log('  tools/keys/public.pem');
console.log('  src/main/licensing/public-key.ts');
console.log('自检签名验证:', ok ? 'PASS' : 'FAIL');
