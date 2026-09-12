/**
 * The three things the assignment asks for, driven through exactly the HTTP
 * calls the LiveKit agent makes — resolve, log, list-to-find, patch, delete.
 *
 * This is the test that would actually catch a broken demo: it asserts on what
 * the web page would show after each turn, not just on status codes.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { clearMeals, setupApi, teardownApi, todayAt } from './helpers.js';
import { mealEvents } from '../src/services/meals.js';

let api;

before(async () => {
  api = await setupApi();
});
after(teardownApi);
beforeEach(clearMeals);

/** What the page renders for today. */
const page = async () => (await api.get('/api/meals').expect(200)).body;

test('turn 1: "I had two rotis and a katori of dal for lunch"', async () => {
  // The agent checks the catalogue before it commits to anything.
  const roti = await api.get('/api/foods/resolve?q=rotis').expect(200);
  assert.equal(roti.body.food.id, 'roti');
  const dal = await api.get('/api/foods/resolve?q=dal').expect(200);
  assert.equal(dal.body.food.id, 'dal_tadka');

  await api
    .post('/api/meals')
    .send({ foodId: 'roti', quantity: 2, unit: 'piece', mealType: 'lunch', source: 'voice', spokenAs: 'two rotis', loggedAt: todayAt(13) })
    .expect(201);
  await api
    .post('/api/meals')
    .send({ foodId: 'dal_tadka', quantity: 1, unit: 'katori', mealType: 'lunch', source: 'voice', spokenAs: 'a katori of dal', loggedAt: todayAt(13) })
    .expect(201);

  const view = await page();
  assert.deepEqual(
    view.entries.map((e) => `${e.quantity} ${e.unit} ${e.foodName}`),
    ['2 piece Roti', '1 katori Dal Tadka'],
  );
  assert.deepEqual(view.totals, { calories: 418, protein: 18, carbs: 67.4, fat: 9.8 });
  assert.ok(view.entries.every((e) => e.mealType === 'lunch' && e.source === 'voice'));
});

test('turn 2: "actually make that three rotis" edits, never duplicates', async () => {
  const created = await api
    .post('/api/meals')
    .send({ foodId: 'roti', quantity: 2, unit: 'piece', mealType: 'lunch', loggedAt: todayAt(13) })
    .expect(201);

  // The agent finds the entry by dish rather than inventing an id.
  const found = await api.get('/api/meals?food=roti').expect(200);
  assert.equal(found.body.entries.length, 1);
  assert.equal(found.body.entries[0].id, created.body.id);

  await api.patch(`/api/meals/${found.body.entries[0].id}`).send({ quantity: 3, spokenAs: 'three rotis' }).expect(200);

  const view = await page();
  assert.equal(view.entries.length, 1, 'an edit must not leave the old entry behind');
  assert.equal(view.entries[0].quantity, 3);
  assert.equal(view.entries[0].grams, 120);
  assert.equal(view.entries[0].spokenAs, 'three rotis');
  assert.deepEqual(view.totals, { calories: 356, protein: 13.4, carbs: 69.6, fat: 4.4 });
});

test('turn 3: "remove the chai I logged this morning" removes only that one', async () => {
  await api.post('/api/meals').send({ foodId: 'chai', quantity: 1, unit: 'cup', mealType: 'breakfast', loggedAt: todayAt(8) });
  await api.post('/api/meals').send({ foodId: 'chai', quantity: 1, unit: 'cup', mealType: 'snack', loggedAt: todayAt(17) });
  await api.post('/api/meals').send({ foodId: 'roti', quantity: 2, unit: 'piece', mealType: 'lunch', loggedAt: todayAt(13) });

  const morning = await api.get('/api/meals?food=chai&mealType=breakfast').expect(200);
  assert.equal(morning.body.entries.length, 1);
  await api.delete(`/api/meals/${morning.body.entries[0].id}`).expect(200);

  const view = await page();
  assert.deepEqual(
    view.entries.map((e) => `${e.mealType}:${e.foodId}`),
    ['lunch:roti', 'snack:chai'],
  );
});

test('a meal the catalogue does not have never reaches the log', async () => {
  const resolved = await api.get('/api/foods/resolve?q=pizza').expect(200);
  assert.equal(resolved.body.status, 'unknown'); // agent stops here and says so
  await api.post('/api/meals').send({ food: 'pizza', quantity: 1 }).expect(422); // and the API would refuse anyway
  assert.equal((await page()).entries.length, 0);
});

test('every write announces itself so the page can follow the conversation', async () => {
  const seen = [];
  const listener = (payload) => seen.push(payload.type);
  mealEvents.on('change', listener);

  const created = await api.post('/api/meals').send({ food: 'roti', quantity: 1 }).expect(201);
  await api.patch(`/api/meals/${created.body.id}`).send({ quantity: 2 }).expect(200);
  await api.delete(`/api/meals/${created.body.id}`).expect(200);

  mealEvents.off('change', listener);
  assert.deepEqual(seen, ['created', 'updated', 'deleted']);
});

test('the log survives a restart', async () => {
  await api.post('/api/meals').send({ food: 'khichdi', quantity: 1, unit: 'bowl', loggedAt: todayAt(20) }).expect(201);

  // Same database, a brand new Express app object — i.e. what a restart looks
  // like to the data. (Durability of the mongod itself is Mongo's job.)
  const { createApp } = await import('../src/app.js');
  const supertest = (await import('supertest')).default;
  const restarted = supertest(createApp());

  const view = (await restarted.get('/api/meals').expect(200)).body;
  assert.equal(view.entries.length, 1);
  assert.equal(view.entries[0].foodId, 'khichdi');
  assert.equal(view.entries[0].grams, 200);
});
