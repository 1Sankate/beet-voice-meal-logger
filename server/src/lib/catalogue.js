/**
 * The food catalogue.
 *
 * foods.json is the source of truth for nutrition, so it is loaded read-only at
 * boot and never copied into Mongo. Mongo stores meal *logs*; the catalogue is
 * static reference data that ships with the code. That also makes the hard
 * product constraint ("a user can only log dishes that exist in this set")
 * trivially enforceable: an entry can only be created through resolveFood(),
 * and resolveFood() can only ever return a row that is in this file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize, singularize, tokens } from './text.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FOODS_PATH = process.env.FOODS_PATH
  ? path.resolve(process.env.FOODS_PATH)
  : path.resolve(here, '../../../data/foods.json');

const raw = JSON.parse(fs.readFileSync(FOODS_PATH, 'utf8'));

/** @type {ReadonlyArray<object>} */
export const foods = Object.freeze(raw.foods.map((f) => Object.freeze({ ...f })));
const byId = new Map(foods.map((f) => [f.id, f]));

/** Spoken unit words mapped onto the unit names used in foods.json. */
const UNIT_SYNONYMS = new Map([
  ['g', 'gram'], ['gm', 'gram'], ['gms', 'gram'], ['grams', 'gram'], ['gram', 'gram'],
  ['katori', 'katori'], ['katoris', 'katori'], ['bowl', 'bowl'], ['bowls', 'bowl'],
  ['cup', 'cup'], ['glass', 'glass'], ['plate', 'plate'], ['piece', 'piece'],
  ['pc', 'piece'], ['pcs', 'piece'], ['no', 'piece'], ['nos', 'piece'],
  ['tablespoon', 'tablespoon'], ['tbsp', 'tablespoon'], ['spoon', 'tablespoon'],
  ['handful', 'handful'], ['serving', null], ['portion', null],
]);

const UNIT_WORDS = new Set([...UNIT_SYNONYMS.keys(), 'katori', 'bowl', 'cup', 'glass', 'plate', 'piece']);

/** Every string that can point at a food: its id, its name and its aliases. */
function keysFor(food) {
  return [food.id, food.name, ...(food.aliases ?? [])];
}

const exactIndex = new Map();
for (const food of foods) {
  for (const key of keysFor(food)) {
    const k = tokens(key).join(' ');
    if (k && !exactIndex.has(k)) exactIndex.set(k, food);
  }
}

function foodTokens(query) {
  return tokens(query).filter((t) => !UNIT_WORDS.has(t));
}

function score(queryTokens, keyTokens) {
  if (!queryTokens.length || !keyTokens.length) return 0;
  const key = new Set(keyTokens);
  const hits = queryTokens.filter((t) => key.has(t)).length;
  return hits / Math.max(queryTokens.length, key.size);
}

export function getFood(id) {
  return byId.get(id) ?? null;
}

/**
 * Resolve free speech onto a catalogue row.
 *
 * Returns one of:
 *   { status: 'ok',        food, score }
 *   { status: 'ambiguous', candidates }  — two plausible dishes, ask the user
 *   { status: 'unknown',   candidates }  — not in the catalogue, refuse to log
 */
export function resolveFood(query) {
  const q = foodTokens(query);
  const flat = q.join(' ');
  if (!flat) return { status: 'unknown', query, candidates: [] };

  const exact = exactIndex.get(flat);
  if (exact) return { status: 'ok', food: exact, score: 1, matchedOn: 'exact' };

  const ranked = foods
    .map((food) => ({
      food,
      score: Math.max(...keysFor(food).map((k) => score(q, tokens(k)))),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  const [best, runnerUp] = ranked;
  if (!best || best.score < 0.5) {
    return { status: 'unknown', query, candidates: ranked.slice(0, 3).map(summarize) };
  }
  // Too close to call ("paneer" matches both paneer dishes) -> let the agent ask.
  if (runnerUp && best.score - runnerUp.score < 0.15) {
    return {
      status: 'ambiguous',
      query,
      candidates: ranked.filter((r) => best.score - r.score < 0.15).slice(0, 4).map(summarize),
    };
  }
  return { status: 'ok', food: best.food, score: best.score, matchedOn: 'fuzzy' };
}

function summarize({ food, score: s }) {
  return { id: food.id, name: food.name, units: food.units.map((u) => u.name), score: Number(s.toFixed(2)) };
}

/**
 * Resolve a spoken unit against the units this specific dish allows.
 * Returns { unit } or { error, allowed }.
 */
export function resolveUnit(food, spokenUnit) {
  const allowed = food.units.map((u) => u.name);
  if (spokenUnit == null || String(spokenUnit).trim() === '') {
    return { unit: food.units[0] }; // first listed unit is the natural serving
  }
  const word = singularize(normalize(spokenUnit).split(' ').filter(Boolean).pop() ?? '');
  const canonical = UNIT_SYNONYMS.has(word) ? UNIT_SYNONYMS.get(word) : word;
  if (canonical === null) return { unit: food.units[0] }; // "one serving of dal"
  const unit = food.units.find((u) => u.name === canonical);
  if (!unit) {
    return { error: `${food.name} cannot be logged in "${spokenUnit}"`, allowed };
  }
  return { unit };
}

/** Macros for a given weight. Rounded once, here, so totals always add up. */
export function macrosForGrams(food, grams) {
  const f = grams / 100;
  const m = food.macrosPer100g;
  return {
    calories: Math.round(m.calories * f),
    protein: round1(m.protein * f),
    carbs: round1(m.carbs * f),
    fat: round1(m.fat * f),
  };
}

export function round1(n) {
  return Math.round(n * 10) / 10;
}

export const catalogueForClient = foods.map((f) => ({
  id: f.id,
  name: f.name,
  aliases: f.aliases ?? [],
  macrosPer100g: f.macrosPer100g,
  units: f.units,
}));
