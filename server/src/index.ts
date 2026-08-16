import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { PmusClient } from './pmus/client.js';
import { KalshiClient } from './kalshi/client.js';
import { ActivitySampler } from './analysis/sampler.js';
import { PriceTracker } from './analysis/tracker.js';
import { apiRouter } from './routes/api.js';
import { quotePx } from './pmus/types.js';

const pmus = new PmusClient({ keyId: config.keyId, secret: config.secret });
const kalshi = new KalshiClient();
const tracker = new PriceTracker();
const sampler = new ActivitySampler(pmus);

const app = express();
app.use('/api', apiRouter(pmus, kalshi, tracker, sampler));

// Serve the built dashboard when it exists (npm run build).
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.message);
  res.status(502).json({ error: err.message });
});

/** Sample mid prices for the movers view (no historical price API exists)
 * and rotate BBO polling for open-interest data (list APIs never populate
 * volume/OI fields). */
async function refreshTracker(): Promise<void> {
  try {
    const events = await pmus.getAllActiveEvents();
    for (const ev of events) {
      for (const m of ev.markets ?? []) {
        const bid = quotePx(m.bestBidQuote);
        const ask = quotePx(m.bestAskQuote);
        if (bid === undefined || ask === undefined) continue;
        tracker.record(
          m.slug,
          m.titleShort || m.title || m.question || m.slug,
          ev.slug,
          ev.title,
          (bid + ask) / 2,
        );
      }
    }
    await sampler.cycle(events);
  } catch (err) {
    console.error('tracker refresh failed:', (err as Error).message);
  }
}

void refreshTracker();
setInterval(refreshTracker, 60_000);

app.listen(config.port, () => {
  console.log(
    `polyscope server on http://localhost:${config.port} ` +
      `(auth: ${pmus.isAuthenticated ? 'yes' : 'public-only'})`,
  );
});
