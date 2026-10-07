import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const entries = [
  { in: 'src/main/index.ts', out: 'main/index' },
  { in: 'src/preload/index.ts', out: 'preload/index' },
];

export const esbuildOptions = {
  entryPoints: entries.map(e => ({ in: e.in, out: e.out })),
  outdir: 'app/dist',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron', 'chromium-bidi'],
  sourcemap: 'inline',
  logLevel: 'info',
  absWorkingDir: root,
};
