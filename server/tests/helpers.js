import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { createApp } from '../src/app.js';

let mongod;

/** Boot an isolated in-memory Mongo + app. One per test file. */
export async function setupApi() {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'beet-test' });
  return request(createApp());
}

export async function teardownApi() {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await mongod?.stop();
}

export async function clearMeals() {
  await mongoose.connection.collection('mealentries').deleteMany({});
}

/** Today at a fixed hour, so meal-type inference is never flaky. */
export function todayAt(hour, minute = 0) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}
