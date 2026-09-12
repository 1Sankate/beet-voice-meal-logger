import express from 'express';
import cors from 'cors';
import { foodsRouter } from './routes/foods.js';
import { mealsRouter } from './routes/meals.js';
import { livekitRouter } from './routes/livekit.js';
import { streamRouter } from './routes/stream.js';
import { ApiError } from './services/meals.js';

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'beet-server' }));
  app.use('/api/foods', foodsRouter);
  app.use('/api/meals', mealsRouter);
  app.use('/api/livekit', livekitRouter);
  app.use('/api/stream', streamRouter);

  app.use((_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'no such route' } }));

  // Every failure leaves here as { error: { code, message, ... } } — the agent
  // reads `message` straight out to the user, so the wording is part of the UX.
  app.use((err, _req, res, _next) => {
    if (err instanceof ApiError) return res.status(err.status).json(err.body);
    if (err?.name === 'ValidationError') {
      return res.status(422).json({ error: { code: 'validation_failed', message: err.message } });
    }
    console.error('[api] unhandled', err);
    return res.status(500).json({ error: { code: 'internal_error', message: 'something broke on our side' } });
  });

  return app;
}
