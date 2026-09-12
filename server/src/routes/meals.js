import { Router } from 'express';
import { createEntry, deleteEntry, listEntries, updateEntry } from '../services/meals.js';

export const mealsRouter = Router();

const userOf = (req) => String(req.query.userId || req.body?.userId || 'demo-user');

/** GET /api/meals?date=2026-09-13&food=chai&mealType=breakfast */
mealsRouter.get('/', async (req, res, next) => {
  try {
    res.json(
      await listEntries({
        userId: userOf(req),
        date: req.query.date,
        from: req.query.from,
        to: req.query.to,
        food: req.query.food,
        mealType: req.query.mealType,
        limit: req.query.limit,
      }),
    );
  } catch (err) {
    next(err);
  }
});

mealsRouter.post('/', async (req, res, next) => {
  try {
    res.status(201).json(await createEntry({ ...req.body, userId: userOf(req) }));
  } catch (err) {
    next(err);
  }
});

mealsRouter.patch('/:id', async (req, res, next) => {
  try {
    res.json(await updateEntry(req.params.id, { ...req.body, userId: userOf(req) }));
  } catch (err) {
    next(err);
  }
});

mealsRouter.delete('/:id', async (req, res, next) => {
  try {
    res.json({ deleted: await deleteEntry(req.params.id, userOf(req)) });
  } catch (err) {
    next(err);
  }
});
