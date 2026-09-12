import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { clearMeals, setupApi, teardownApi, todayAt } from './helpers.js';

let api;

before(async () => {
  api = await setupApi();
});
after(teardownApi);
beforeEach(clearMeals);

test('POST /api/meals stores the entry with server-computed macros', async () => {
  const res = await api
    .post('/api/meals')
    .send({ food: 'two rotis', quantity: 2, unit: 'piece', mealType: 'lunch', spokenAs: 'two rotis' })
    .expect(201);

  assert.equal(res.body.foodId, 'roti');
  assert.equal(res.body.foodName, 'Roti');
  assert.equal(res.body.grams, 80);
  assert.deepEqual(res.body.macros, { calories: 238, protein: 9, carbs: 46.4, fat: 3 });
  assert.equal(res.body.mealType, 'lunch');
  assert.equal(res.body.spokenAs, 'two rotis');
  assert.match(res.body.id, /^[a-f\d]{24}$/);
});

test('macros sent by the client are ignored — the catalogue decides', async () => {
  const res = await api
    .post('/api/meals')
    .send({ food: 'roti', quantity: 1, unit: 'piece', macros: { calories: 5, protein: 99, carbs: 0, fat: 0 } })
    .expect(201);
  assert.deepEqual(res.body.macros, { calories: 119, protein: 4.5, carbs: 23.2, fat: 1.5 });
});

test('rejects a dish that is not in foods.json', async () => {
  const res = await api.post('/api/meals').send({ food: 'pizza', quantity: 1 }).expect(422);
  assert.equal(res.body.error.code, 'unknown_food');
  assert.match(res.body.error.message, /not in the Beet food database/);
});

test('rejects an unknown foodId even when it looks well-formed', async () => {
  const res = await api.post('/api/meals').send({ foodId: 'butter_chicken', quantity: 1 }).expect(422);
  assert.equal(res.body.error.code, 'unknown_food');
});

test('asks instead of guessing when the dish is ambiguous', async () => {
  const res = await api.post('/api/meals').send({ food: 'paneer', quantity: 1 }).expect(409);
  assert.equal(res.body.error.code, 'ambiguous_food');
  assert.equal(res.body.error.candidates.length, 2);
});

test('rejects a unit the dish does not support, and says which are allowed', async () => {
  const res = await api.post('/api/meals').send({ food: 'palak paneer', quantity: 1, unit: 'glass' }).expect(422);
  assert.equal(res.body.error.code, 'invalid_unit');
  assert.deepEqual(res.body.error.allowed, ['katori', 'gram']);
});

test('rejects nonsense quantities', async () => {
  await api.post('/api/meals').send({ food: 'roti', quantity: 0 }).expect(422);
  await api.post('/api/meals').send({ food: 'roti', quantity: -3 }).expect(422);
  await api.post('/api/meals').send({ food: 'roti', quantity: 'many' }).expect(422);
  await api.post('/api/meals').send({ food: 'roti', quantity: 5000 }).expect(422);
});

test('quantity defaults to 1 and unit defaults to the natural serving', async () => {
  const res = await api.post('/api/meals').send({ food: 'dal' }).expect(201);
  assert.equal(res.body.quantity, 1);
  assert.equal(res.body.unit, 'katori');
  assert.equal(res.body.grams, 150);
});

test('PATCH recomputes grams and macros', async () => {
  const created = await api.post('/api/meals').send({ food: 'roti', quantity: 2, unit: 'piece' }).expect(201);
  const patched = await api.patch(`/api/meals/${created.body.id}`).send({ quantity: 3 }).expect(200);

  assert.equal(patched.body.quantity, 3);
  assert.equal(patched.body.grams, 120);
  assert.deepEqual(patched.body.macros, { calories: 356, protein: 13.4, carbs: 69.6, fat: 4.4 });
  assert.equal(patched.body.id, created.body.id, 'edit must not create a new entry');
});

test('PATCH can change the unit, the meal and the dish itself', async () => {
  const created = await api.post('/api/meals').send({ food: 'dal', quantity: 1, unit: 'katori' }).expect(201);

  const toBowl = await api.patch(`/api/meals/${created.body.id}`).send({ unit: 'bowl' }).expect(200);
  assert.equal(toBowl.body.grams, 200);

  const toDinner = await api.patch(`/api/meals/${created.body.id}`).send({ mealType: 'dinner' }).expect(200);
  assert.equal(toDinner.body.mealType, 'dinner');

  // "actually that was rajma" — the unit must be re-validated against the new dish
  const toRajma = await api.patch(`/api/meals/${created.body.id}`).send({ food: 'rajma' }).expect(200);
  assert.equal(toRajma.body.foodId, 'rajma');
  assert.equal(toRajma.body.unit, 'katori');
  assert.equal(toRajma.body.macros.calories, 210);
});

test('PATCH keeps the catalogue constraint', async () => {
  const created = await api.post('/api/meals').send({ food: 'roti', quantity: 1 }).expect(201);
  await api.patch(`/api/meals/${created.body.id}`).send({ food: 'sushi' }).expect(422);
  await api.patch(`/api/meals/${created.body.id}`).send({ unit: 'bucket' }).expect(422);
  const after = await api.get(`/api/meals`).expect(200);
  assert.equal(after.body.entries[0].foodId, 'roti', 'a rejected edit must leave the entry untouched');
});

test('DELETE removes the entry and is 404 the second time', async () => {
  const created = await api.post('/api/meals').send({ food: 'chai', quantity: 1, unit: 'cup' }).expect(201);
  await api.delete(`/api/meals/${created.body.id}`).expect(200);
  await api.delete(`/api/meals/${created.body.id}`).expect(404);
  const list = await api.get('/api/meals').expect(200);
  assert.equal(list.body.entries.length, 0);
});

test('unknown or malformed ids are 404, not 500', async () => {
  await api.patch('/api/meals/not-an-id').send({ quantity: 2 }).expect(404);
  await api.delete('/api/meals/ffffffffffffffffffffffff').expect(404);
});

test('GET /api/meals returns the day, its entries and its totals', async () => {
  await api.post('/api/meals').send({ food: 'roti', quantity: 2, unit: 'piece', loggedAt: todayAt(13) });
  await api.post('/api/meals').send({ food: 'dal', quantity: 1, unit: 'katori', loggedAt: todayAt(13, 5) });

  const res = await api.get('/api/meals').expect(200);
  assert.equal(res.body.entries.length, 2);
  assert.deepEqual(res.body.totals, { calories: 418, protein: 18, carbs: 67.4, fat: 9.8 });
  assert.deepEqual(
    res.body.entries.map((e) => e.foodId),
    ['roti', 'dal_tadka'],
    'entries come back in the order they were eaten',
  );
});

test('GET /api/meals filters by dish and by meal, which is how delete-by-speech works', async () => {
  await api.post('/api/meals').send({ food: 'chai', quantity: 1, unit: 'cup', loggedAt: todayAt(8), mealType: 'breakfast' });
  await api.post('/api/meals').send({ food: 'chai', quantity: 1, unit: 'cup', loggedAt: todayAt(17), mealType: 'snack' });
  await api.post('/api/meals').send({ food: 'roti', quantity: 2, unit: 'piece', loggedAt: todayAt(13), mealType: 'lunch' });

  const morningChai = await api.get('/api/meals?food=tea&mealType=breakfast').expect(200);
  assert.equal(morningChai.body.entries.length, 1);
  assert.equal(morningChai.body.entries[0].foodId, 'chai');
  assert.equal(morningChai.body.entries[0].mealType, 'breakfast');

  const allChai = await api.get('/api/meals?food=chai').expect(200);
  assert.equal(allChai.body.entries.length, 2);
});

test('days do not bleed into each other', async () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(13, 0, 0, 0);

  await api.post('/api/meals').send({ food: 'roti', quantity: 1, loggedAt: yesterday.toISOString() });
  await api.post('/api/meals').send({ food: 'dal', quantity: 1, loggedAt: todayAt(13) });

  const today = await api.get('/api/meals').expect(200);
  assert.equal(today.body.entries.length, 1);
  assert.equal(today.body.entries[0].foodId, 'dal_tadka');

  const key = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
  const then = await api.get(`/api/meals?date=${key}`).expect(200);
  assert.equal(then.body.entries.length, 1);
  assert.equal(then.body.entries[0].foodId, 'roti');
});

test("one user's log is not another user's", async () => {
  const mine = await api.post('/api/meals?userId=asha').send({ food: 'roti', quantity: 1 }).expect(201);
  const theirs = await api.get('/api/meals?userId=bhavin').expect(200);
  assert.equal(theirs.body.entries.length, 0);
  await api.delete(`/api/meals/${mine.body.id}?userId=bhavin`).expect(404);
  await api.delete(`/api/meals/${mine.body.id}?userId=asha`).expect(200);
});

test('GET /api/foods serves the catalogue with units', async () => {
  const res = await api.get('/api/foods').expect(200);
  assert.equal(res.body.count, 30);
  const roti = res.body.foods.find((f) => f.id === 'roti');
  assert.deepEqual(roti.units, [{ name: 'piece', grams: 40 }, { name: 'gram', grams: 1 }]);
});

test('GET /api/foods/resolve reports ok / ambiguous / unknown', async () => {
  assert.equal((await api.get('/api/foods/resolve?q=chapati')).body.status, 'ok');
  assert.equal((await api.get('/api/foods/resolve?q=paneer')).body.status, 'ambiguous');
  assert.equal((await api.get('/api/foods/resolve?q=lasagna')).body.status, 'unknown');
});

test('LiveKit token endpoint fails loudly when it is not configured', async () => {
  const saved = process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_KEY;
  const res = await api.get('/api/livekit/token').expect(501);
  assert.equal(res.body.error.code, 'livekit_not_configured');
  if (saved) process.env.LIVEKIT_API_KEY = saved;
});
