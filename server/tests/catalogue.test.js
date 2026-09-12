/**
 * The catalogue layer is where a wrong answer is most expensive: every logged
 * calorie comes out of these three functions, and the "only dishes in this set"
 * constraint is enforced by resolveFood alone. So it gets the densest tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { foods, getFood, macrosForGrams, resolveFood, resolveUnit } from '../src/lib/catalogue.js';
import { inferMealType, sumMacros } from '../src/services/meals.js';

test('catalogue loads the full foods.json', () => {
  assert.equal(foods.length, 30);
  assert.ok(foods.every((f) => f.id && f.name && f.units.length && f.macrosPer100g));
});

test('resolves ids, names, aliases and plurals', () => {
  const cases = [
    ['roti', 'roti'],
    ['Roti', 'roti'],
    ['two rotis', 'roti'],
    ['chapati', 'roti'],
    ['a katori of dal', 'dal_tadka'],
    ['daal', 'dal_tadka'],
    ['kidney bean curry', 'rajma'],
    ['chhole', 'chole'],
    ['steamed rice', 'plain_rice'],
    ['uble ande', 'boiled_egg'],
    ['mix veg', 'mixed_veg_sabzi'],
    ['badam', 'almonds'],
    ['tea', 'chai'],
    ['idlis', 'idli'],
  ];
  for (const [spoken, expected] of cases) {
    const result = resolveFood(spoken);
    assert.equal(result.status, 'ok', `"${spoken}" should resolve`);
    assert.equal(result.food.id, expected, `"${spoken}" -> ${result.food?.id}`);
  }
});

test('refuses food that is not in the database', () => {
  for (const spoken of ['pizza', 'cheeseburger', 'protein shake', '']) {
    assert.equal(resolveFood(spoken).status, 'unknown', `"${spoken}" must not resolve`);
  }
});

test('flags genuinely ambiguous speech instead of guessing', () => {
  const result = resolveFood('paneer');
  assert.equal(result.status, 'ambiguous');
  const ids = result.candidates.map((c) => c.id).sort();
  assert.deepEqual(ids, ['paneer_butter_masala', 'palak_paneer'].sort());
});

test('units: synonyms, plurals and per-dish validation', () => {
  const roti = getFood('roti');
  assert.equal(resolveUnit(roti, 'pieces').unit.grams, 40);
  assert.equal(resolveUnit(roti, 'piece').unit.grams, 40);
  assert.equal(resolveUnit(roti, 'g').unit.grams, 1);
  assert.equal(resolveUnit(roti, 'grams').unit.grams, 1);
  // no unit spoken -> the dish's natural serving, which is the first one listed
  assert.equal(resolveUnit(roti, undefined).unit.name, 'piece');
  assert.equal(resolveUnit(roti, 'one serving').unit.name, 'piece');

  const pbm = getFood('paneer_butter_masala');
  const bad = resolveUnit(pbm, 'glass');
  assert.match(bad.error, /cannot be logged in "glass"/);
  assert.deepEqual(bad.allowed, ['katori', 'gram']);
});

test('macros are computed per 100g and rounded once', () => {
  const roti = getFood('roti');
  // 2 pieces = 80g of a 297 kcal/100g food
  assert.deepEqual(macrosForGrams(roti, 80), { calories: 238, protein: 9, carbs: 46.4, fat: 3 });

  const dal = getFood('dal_tadka');
  assert.deepEqual(macrosForGrams(dal, 150), { calories: 180, protein: 9, carbs: 21, fat: 6.8 });

  const almonds = getFood('almonds');
  assert.deepEqual(macrosForGrams(almonds, 20), { calories: 116, protein: 4.2, carbs: 4.4, fat: 10 });
});

test('totals add the stored numbers, so the page and the entries agree', () => {
  const totals = sumMacros([
    { macros: { calories: 238, protein: 9, carbs: 46.4, fat: 3 } },
    { macros: { calories: 180, protein: 9, carbs: 21, fat: 6.8 } },
  ]);
  assert.deepEqual(totals, { calories: 418, protein: 18, carbs: 67.4, fat: 9.8 });
});

test('meal type falls back to the time of day', () => {
  const at = (h) => inferMealType(new Date(2026, 8, 13, h, 0, 0));
  assert.equal(at(8), 'breakfast');
  assert.equal(at(13), 'lunch');
  assert.equal(at(17), 'snack');
  assert.equal(at(20), 'dinner');
  assert.equal(at(2), 'snack');
});
