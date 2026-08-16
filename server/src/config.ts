import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Minimal .env loader (repo root), no dependency. Real env vars win. */
function loadDotEnv(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(here, '../../.env'),
    path.resolve(here, '../../../.env'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const [, key, rawValue] = m;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.replace(/^["']|["']$/g, '');
    }
    break;
  }
}

loadDotEnv();

export const config = {
  keyId: process.env.PMUS_KEY_ID || undefined,
  secret: process.env.PMUS_SECRET || undefined,
  port: parseInt(process.env.PORT ?? '8787', 10),
};
