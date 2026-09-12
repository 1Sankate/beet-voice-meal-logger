import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createApp } from './app.js';
import { connectDb, disconnectDb } from './db.js';

// One .env at the repo root configures all three processes; server/.env can
// override it if you want the API configured separately.
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: [path.resolve(here, '../../.env'), path.resolve(here, '../.env')] });

const port = Number(process.env.PORT || 4000);

await connectDb();
const server = createApp().listen(port, () => {
  console.log(`[api] beet-server listening on http://localhost:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.close();
    await disconnectDb();
    process.exit(0);
  });
}
