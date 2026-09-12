import { Room, RoomEvent, Track } from 'livekit-client';

/**
 * Voice session plumbing.
 *
 * ponytail: livekit-client directly instead of the React component kit — the
 * page needs exactly three things (join, publish the mic, play the agent) and
 * this is all three without taking on a UI framework's opinions.
 */
export async function startVoiceSession({ userId = 'demo-user', onState, onTranscript }) {
  const res = await fetch(`/api/livekit/token?userId=${encodeURIComponent(userId)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'could not get a LiveKit token');

  const room = new Room({ adaptiveStream: true, dynacast: true });

  room.on(RoomEvent.Connected, () => onState?.('connected'));
  room.on(RoomEvent.Disconnected, () => onState?.('idle'));
  room.on(RoomEvent.Reconnecting, () => onState?.('reconnecting'));
  room.on(RoomEvent.ParticipantConnected, () => onState?.('listening'));

  // Play whatever the agent says.
  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === Track.Kind.Audio) {
      const el = track.attach();
      el.autoplay = true;
      el.style.display = 'none';
      document.body.appendChild(el);
    }
  });

  await room.connect(data.url, data.token);
  await room.localParticipant.setMicrophoneEnabled(true);

  // Live captions for both sides of the conversation.
  room.registerTextStreamHandler('lk.transcription', async (reader, participant) => {
    const speaker = participant.identity === data.identity ? 'you' : 'agent';
    // Streams arrive in pieces; each piece extends the same caption line.
    let text = '';
    for await (const chunk of reader) {
      text += chunk;
      onTranscript?.({ id: reader.info.id, speaker, text, final: false });
    }
    onTranscript?.({ id: reader.info.id, speaker, text, final: true });
  });

  return {
    room,
    identity: data.identity,
    roomName: data.room,
    stop: async () => {
      await room.disconnect();
    },
  };
}
