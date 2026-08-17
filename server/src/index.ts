import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { PmusClient } from './pmus/client.js';
import { KalshiClient } from './kalshi/client.js';
import { GapHistory } from './analysis/history.js';
import type { CuratedPair } from './analysis/pairs.js';
import { apiRouter, currentPairs } from './routes/api.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

const pmus = new PmusClient({ keyId: config.keyId, secret: config.secret });
const kalshi = new KalshiClient();
const history = new GapHistory(path.join(repoRoot, 'data/gaps.jsonl'));

function loadCurated(): CuratedPair[] {
  const file = path.join(repoRoot, 'curated-pairs.json');
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8')) as CuratedPair[];
}
const curated = loadCurated();

const deps = { pmus, kalshi, history, curated };

const app = express();
app.use('/api', apiRouter(deps));

const webDist = path.resolve(repoRoot, 'web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.message);
  res.status(502).json({ error: err.message });
});

/** One gap sample per matched pair per minute — neither venue serves
 * price history, so the charts are entirely self-observed. */
async function sampleGaps(): Promise<void> {
  try {
    const { pairs } = await currentPairs(deps);
    for (const p of pairs) {
      // Low-trust pairs are review-queue noise; recording all ~1.5k pairs
      // would also grow the JSONL by >100MB/day.
      if (p.trust === 'low') continue;
      if (p.pm.mid !== undefined && p.kalshi.mid !== undefined) {
        history.record(p.id, p.pm.mid, p.kalshi.mid);
      }
    }
  } catch (err) {
    console.error('gap sampling failed:', (err as Error).message);
  }
}

void sampleGaps();
setInterval(sampleGaps, 60_000);

app.listen(config.port, () => {
  console.log(
    `crossbook on http://localhost:${config.port} ` +
      `(${curated.length} curated pairs, pmus auth: ${pmus.isAuthenticated ? 'yes' : 'no'})`,
  );
});
