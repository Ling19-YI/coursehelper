import { createHash, createPublicKey, verify } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PUBLIC_KEY_B64URL } from './licensing/public-key';
import type { ActivateResult, LicenseInfo } from '../shared/api';

export interface LicensePayload {
  id: string;
  v: number;
  iat: number;
  exp?: number;
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function publicKey() {
  const raw = Buffer.from(PUBLIC_KEY_B64URL, 'base64url');
  const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

export function getMachineId(): string {
  const macs = Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i && !i.internal && i.mac !== '00:00:00:00:00:00')
    .map(i => i!.mac)
    .sort()
    .join(',');
  const parts = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.cpus()[0]?.model || '',
    String(os.totalmem()),
    macs,
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex').substring(0, 24);
}

export function parseCode(raw: string): { payload: LicensePayload; sig: Buffer } | null {
  try {
    const s = String(raw || '').trim().replace(/\s+/g, '');
    const m = s.match(/^CH1\.([A-Za-z0-9_\-]+)\.([A-Za-z0-9_\-]+)$/);
    if (!m) return null;
    const payload = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf-8'));
    if (!payload || typeof payload.id !== 'string') return null;
    return { payload, sig: Buffer.from(m[2], 'base64url') };
  } catch {
    return null;
  }
}

export function verifyCode(raw: string): { ok: boolean; payload?: LicensePayload; message: string } {
  const parsed = parseCode(raw);
  if (!parsed) return { ok: false, message: '激活码格式不正确' };
  const body = Buffer.from(String(raw).trim().replace(/\s+/g, '').split('.')[1], 'base64url');
  let valid = false;
  try {
    valid = verify(null, body, publicKey(), parsed.sig);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, message: '激活码签名校验失败' };
  if (parsed.payload.exp && Date.now() > parsed.payload.exp) {
    return { ok: false, message: '激活码已过期' };
  }
  return { ok: true, payload: parsed.payload, message: 'ok' };
}

function licenseFile(userData: string) {
  return path.join(userData, 'license.json');
}

interface LicenseFile {
  code: string;
  machineId: string;
  activatedAt: number;
}

export function getLicenseInfo(userData: string): LicenseInfo | null {
  try {
    const f = licenseFile(userData);
    if (!fs.existsSync(f)) return null;
    const data: LicenseFile = JSON.parse(fs.readFileSync(f, 'utf-8'));
    const v = verifyCode(data.code);
    if (!v.ok || !v.payload) return null;
    if (data.machineId !== getMachineId()) return null;
    return { codeId: v.payload.id, activatedAt: data.activatedAt, machineId: data.machineId };
  } catch {
    return null;
  }
}

export function activate(rawCode: string, userData: string): ActivateResult {
  const v = verifyCode(rawCode);
  if (!v.ok || !v.payload) return { ok: false, message: v.message };

  const machineId = getMachineId();
  const existing = getLicenseInfo(userData);
  if (existing && existing.codeId !== v.payload.id) {
    // 已有有效授权：同机允许换码覆盖（防串码场景由人工处理）
  }
  const data: LicenseFile = {
    code: String(rawCode).trim().replace(/\s+/g, ''),
    machineId,
    activatedAt: Date.now(),
  };
  fs.writeFileSync(licenseFile(userData), JSON.stringify(data, null, 2), 'utf-8');
  return {
    ok: true,
    message: '激活成功',
    info: { codeId: v.payload.id, activatedAt: data.activatedAt, machineId },
  };
}

export function clearLicense(userData: string) {
  try {
    fs.unlinkSync(licenseFile(userData));
  } catch {}
}
