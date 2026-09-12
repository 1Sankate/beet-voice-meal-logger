/**
 * All meal-log business rules live here.
 *
 * Routes are transport, the agent is a client — neither of them is allowed to
 * do nutrition math or decide what a valid entry is. Anything that writes a log
 * goes through createEntry/updateEntry, which is where the catalogue constraint
 * and the macro calculation are enforced exactly once.
 */
import { EventEmitter } from 'node:events';
import { MealEntry, MEAL_TYPES } from '../models/MealEntry.js';
import { getFood, macrosForGrams, resolveFood, resolveUnit, round1 } from '../lib/catalogue.js';

export const mealEvents = new EventEmitter();

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.body = { error: { code, message, ...extra } };
  }
}

/** Time-of-day fallback when the user doesn't say which meal it was. */
export function inferMealType(date = new Date()) {
  const h = date.getHours();
  if (h >= 4 && h < 11) return 'breakfast';
  if (h >= 11 && h < 16) return 'lunch';
  if (h >= 16 && h < 19) return 'snack';
  if (h >= 19 && h < 23) return 'dinner';
  return 'snack';
}

function requireFood({ foodId, food }) {
  if (foodId) {
    const hit = getFood(foodId);
    if (!hit) {
      throw new ApiError(422, 'unknown_food', `"${foodId}" is not in the Beet food database`, { candidates: [] });
    }
    return hit;
  }
  const result = resolveFood(food);
  if (result.status === 'ok') return result.food;
  if (result.status === 'ambiguous') {
    throw new ApiError(409, 'ambiguous_food', `"${food}" could be more than one dish — ask which one`, {
      candidates: result.candidates,
    });
  }
  throw new ApiError(422, 'unknown_food', `"${food}" is not in the Beet food database, so it cannot be logged`, {
    candidates: result.candidates,
  });
}

function requireUnit(food, unit) {
  const result = resolveUnit(food, unit);
  if (result.error) {
    throw new ApiError(422, 'invalid_unit', result.error, { allowed: result.allowed });
  }
  return result.unit;
}

function requireQuantity(quantity) {
  const q = quantity == null || quantity === '' ? 1 : Number(quantity);
  if (!Number.isFinite(q) || q <= 0) {
    throw new ApiError(422, 'invalid_quantity', `quantity must be a positive number, got "${quantity}"`);
  }
  if (q > 1000) {
    throw new ApiError(422, 'invalid_quantity', 'quantity looks wrong — more than 1000 units in one entry');
  }
  return round1(q);
}

function requireMealType(mealType, at) {
  if (mealType == null || mealType === '') return inferMealType(at);
  const m = String(mealType).toLowerCase().trim();
  if (!MEAL_TYPES.includes(m)) {
    throw new ApiError(422, 'invalid_meal_type', `mealType must be one of ${MEAL_TYPES.join(', ')}`);
  }
  return m;
}

function requireDate(value, fallback = new Date()) {
  if (value == null || value === '') return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new ApiError(422, 'invalid_date', `could not read "${value}" as a date`);
  }
  return d;
}

function priceOut(food, quantity, unit) {
  const grams = round1(quantity * unit.grams);
  return { grams, macros: macrosForGrams(food, grams) };
}

export async function createEntry(input = {}) {
  const food = requireFood(input);
  const unit = requireUnit(food, input.unit);
  const quantity = requireQuantity(input.quantity);
  const loggedAt = requireDate(input.loggedAt ?? input.at);
  const mealType = requireMealType(input.mealType, loggedAt);
  const { grams, macros } = priceOut(food, quantity, unit);

  const entry = await MealEntry.create({
    userId: input.userId || 'demo-user',
    foodId: food.id,
    foodName: food.name,
    quantity,
    unit: unit.name,
    grams,
    macros,
    mealType,
    loggedAt,
    spokenAs: input.spokenAs ?? '',
    source: input.source === 'voice' ? 'voice' : 'api',
  });

  mealEvents.emit('change', { type: 'created', entry: entry.toJSON() });
  return entry.toJSON();
}

export async function updateEntry(id, patch = {}) {
  const entry = await findEntryOr404(id, patch.userId);

  const changingFood = Boolean(patch.food || patch.foodId);
  const food = changingFood ? requireFood(patch) : getFood(entry.foodId);
  if (!food) throw new ApiError(500, 'catalogue_drift', `food ${entry.foodId} is no longer in the catalogue`);

  // Changing the dish invalidates the old unit (a katori of dal is not a katori
  // of roti), so fall back to that dish's default unit unless a new one is given.
  const unitHint = patch.unit ?? (changingFood ? undefined : entry.unit);
  const unit = requireUnit(food, unitHint);
  const quantity = patch.quantity == null ? entry.quantity : requireQuantity(patch.quantity);
  const loggedAt = patch.loggedAt == null && patch.at == null ? entry.loggedAt : requireDate(patch.loggedAt ?? patch.at);
  const mealType = patch.mealType == null ? entry.mealType : requireMealType(patch.mealType, loggedAt);
  const { grams, macros } = priceOut(food, quantity, unit);

  entry.set({
    foodId: food.id,
    foodName: food.name,
    quantity,
    unit: unit.name,
    grams,
    macros,
    mealType,
    loggedAt,
    ...(patch.spokenAs ? { spokenAs: patch.spokenAs } : {}),
  });
  await entry.save();

  mealEvents.emit('change', { type: 'updated', entry: entry.toJSON() });
  return entry.toJSON();
}

export async function deleteEntry(id, userId) {
  const entry = await findEntryOr404(id, userId);
  await entry.deleteOne();
  mealEvents.emit('change', { type: 'deleted', entry: entry.toJSON() });
  return entry.toJSON();
}

async function findEntryOr404(id, userId) {
  if (!/^[a-f\d]{24}$/i.test(String(id ?? ''))) {
    throw new ApiError(404, 'entry_not_found', `no meal entry with id "${id}"`);
  }
  const query = { _id: id };
  if (userId) query.userId = userId;
  const entry = await MealEntry.findOne(query);
  if (!entry) throw new ApiError(404, 'entry_not_found', `no meal entry with id "${id}"`);
  return entry;
}

/** Local-time day window. The server is assumed to run in the user's timezone. */
export function dayRange(dateish = new Date()) {
  const d = typeof dateish === 'string' ? parseLocalDate(dateish) : new Date(dateish);
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  return { from, to };
}

function parseLocalDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new ApiError(422, 'invalid_date', `could not read "${s}" as a date`);
  return d;
}

export function sumMacros(entries) {
  const total = entries.reduce(
    (acc, e) => ({
      calories: acc.calories + e.macros.calories,
      protein: acc.protein + e.macros.protein,
      carbs: acc.carbs + e.macros.carbs,
      fat: acc.fat + e.macros.fat,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
  return {
    calories: Math.round(total.calories),
    protein: round1(total.protein),
    carbs: round1(total.carbs),
    fat: round1(total.fat),
  };
}

/**
 * List a day's entries, optionally narrowed by dish or meal.
 *
 * The `food` filter is what lets the agent act on "the chai I logged this
 * morning" without inventing an id: it lists, gets one hit, then edits/deletes.
 */
export async function listEntries({ userId = 'demo-user', date, from, to, food, mealType, limit = 200 } = {}) {
  let window;
  if (from || to) {
    window = { from: requireDate(from, new Date(0)), to: requireDate(to, new Date(8.64e15)) };
  } else {
    window = dayRange(date || new Date());
  }

  const query = { userId, loggedAt: { $gte: window.from, $lt: window.to } };

  if (food) {
    const resolved = resolveFood(food);
    if (resolved.status === 'ok') {
      query.foodId = resolved.food.id;
    } else if (resolved.candidates?.length) {
      query.foodId = { $in: resolved.candidates.map((c) => c.id) };
    } else {
      return { date: toDateKey(window.from), entries: [], totals: sumMacros([]), filteredBy: { food, mealType } };
    }
  }
  if (mealType) query.mealType = requireMealType(mealType);

  const docs = await MealEntry.find(query)
    .sort({ loggedAt: 1, createdAt: 1 })
    .limit(Math.min(Number(limit) || 200, 500));
  const entries = docs.map((d) => d.toJSON());
  return {
    date: toDateKey(window.from),
    entries,
    totals: sumMacros(entries),
    filteredBy: food || mealType ? { food, mealType } : undefined,
  };
}

export function toDateKey(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
