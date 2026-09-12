import { Router } from 'express';
import { catalogueForClient, resolveFood } from '../lib/catalogue.js';

export const foodsRouter = Router();

/** The whole catalogue. The web page uses it; the agent uses /resolve instead. */
foodsRouter.get('/', (_req, res) => {
  res.json({ foods: catalogueForClient, count: catalogueForClient.length });
});

/**
 * Speech -> catalogue row.
 *
 * The agent calls this before logging anything it is unsure about, which is how
 * "can only log dishes that exist in this set" turns into a conversation
 * ("we don't have pizza — want to log something else?") instead of a 422.
 */
foodsRouter.get('/resolve', (req, res) => {
  const q = String(req.query.q ?? '');
  const result = resolveFood(q);
  if (result.status === 'ok') {
    const { food } = result;
    return res.json({
      status: 'ok',
      food: { id: food.id, name: food.name, units: food.units, macrosPer100g: food.macrosPer100g },
      score: Number(result.score.toFixed(2)),
      matchedOn: result.matchedOn,
    });
  }
  return res.json({ status: result.status, query: q, candidates: result.candidates });
});
