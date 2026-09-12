import { Router } from 'express';
import { mealEvents } from '../services/meals.js';

export const streamRouter = Router();

/**
 * Server-sent events so the page reflects the conversation as it happens.
 *
 * ponytail: SSE, not websockets — the traffic is one-way and this is ~20 lines.
 * The page also refetches on every event rather than patching state from the
 * payload, so the list can never drift from the database.
 */
streamRouter.get('/', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  res.write('event: ready\ndata: {}\n\n');

  const onChange = (payload) => {
    res.write(`event: meals\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  mealEvents.on('change', onChange);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    mealEvents.off('change', onChange);
  });
});
