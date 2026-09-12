import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';

export const livekitRouter = Router();

/**
 * Room names carry the user id: beet__<userId>__<session>.
 *
 * The agent is dispatched automatically into whatever room the browser opens,
 * so this is how it learns whose log it is writing to without a second channel.
 */
export function roomNameFor(userId) {
  return `beet__${userId}__${randomUUID().slice(0, 8)}`;
}

export function userIdFromRoom(roomName) {
  const parts = String(roomName ?? '').split('__');
  return parts.length >= 2 && parts[0] === 'beet' ? parts[1] : 'demo-user';
}

livekitRouter.get('/token', async (req, res, next) => {
  try {
    const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL } = process.env;
    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
      return res.status(501).json({
        error: {
          code: 'livekit_not_configured',
          message: 'Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET in .env to enable the voice agent.',
        },
      });
    }

    const userId = String(req.query.userId || 'demo-user');
    const identity = String(req.query.identity || `${userId}-web`);
    const room = String(req.query.room || roomNameFor(userId));

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, ttl: '30m' });
    at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });

    res.json({ token: await at.toJwt(), url: LIVEKIT_URL, room, identity, userId });
  } catch (err) {
    next(err);
  }
});
