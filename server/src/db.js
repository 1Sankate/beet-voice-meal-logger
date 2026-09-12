/**
 * Mongo connection.
 *
 * MONGODB_URI wins if it is set (Atlas, Docker, a local mongod — anything).
 * If it is not, we start an embedded mongod with an on-disk dbPath so the
 * assignment still runs on a machine with nothing installed *and* still
 * satisfies "a restart shouldn't lose the user's logs".
 */
import path from 'node:path';
import mongoose from 'mongoose';

let memoryServer = null;

export async function connectDb({ uri = process.env.MONGODB_URI, dbName = process.env.MONGODB_DB || 'beet' } = {}) {
  let target = uri;

  if (!target) {
    // ponytail: embedded mongod is a convenience for local runs; point MONGODB_URI
    // at a real server (Atlas/Docker) for anything that matters.
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const dbPath = path.resolve(process.env.EMBEDDED_DB_PATH || '.data/mongo');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dbPath, { recursive: true });
    memoryServer = await MongoMemoryServer.create({
      instance: { dbPath, storageEngine: 'wiredTiger' },
    });
    target = memoryServer.getUri();
    console.log(`[db] no MONGODB_URI set — started embedded mongod, data persisted in ${dbPath}`);
  }

  mongoose.set('strictQuery', true);
  await mongoose.connect(target, { dbName });
  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}
