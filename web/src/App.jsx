import { useCallback, useEffect, useRef, useState } from 'react';
import { startVoiceSession } from './voice.js';

const USER_ID = 'demo-user';
// Empty in dev (Vite proxies /api); set VITE_API_URL when the API is hosted elsewhere.
const API = import.meta.env.VITE_API_URL?.replace(/\/$/, '') ?? '';
const MEAL_ORDER = ['breakfast', 'lunch', 'snack', 'dinner'];

const time = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const portion = (e) =>
  e.unit === 'gram' ? `${e.quantity} g` : `${e.quantity} × ${e.unit} (${e.grams} g)`;

export default function App() {
  const [day, setDay] = useState({ date: '', entries: [], totals: null });
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [captions, setCaptions] = useState([]);
  const sessionRef = useRef(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`${API}/api/meals?userId=${USER_ID}`);
    if (res.ok) setDay(await res.json());
  }, []);

  // Load once, then refetch whenever the server says the log changed. The page
  // never patches its own state from an event payload — it always re-reads, so
  // what is on screen is always what is in the database.
  useEffect(() => {
    refresh();
    const events = new EventSource(`${API}/api/stream`);
    // `ready` fires on every (re)connect, so writes made while the stream was
    // down still show up.
    events.addEventListener('ready', refresh);
    events.addEventListener('meals', refresh);
    return () => events.close();
  }, [refresh]);

  const connect = async () => {
    setError('');
    setStatus('connecting');
    try {
      sessionRef.current = await startVoiceSession({
        userId: USER_ID,
        onState: setStatus,
        onTranscript: (line) =>
          setCaptions((prev) => {
            const rest = prev.filter((c) => c.id !== line.id);
            return [...rest, line].slice(-6);
          }),
      });
    } catch (err) {
      setStatus('idle');
      setError(err.message);
    }
  };

  const disconnect = async () => {
    await sessionRef.current?.stop();
    sessionRef.current = null;
    setStatus('idle');
    setCaptions([]);
  };

  const live = status !== 'idle' && status !== 'connecting';
  const grouped = MEAL_ORDER.map((meal) => ({
    meal,
    entries: day.entries.filter((e) => e.mealType === meal),
  })).filter((g) => g.entries.length);

  return (
    <main>
      <header>
        <div>
          <h1>Today's meals</h1>
          <p className="muted">{day.date || '—'} · {day.entries.length} item{day.entries.length === 1 ? '' : 's'}</p>
        </div>
        <button className={live ? 'stop' : 'talk'} onClick={live || status === 'connecting' ? disconnect : connect}>
          {status === 'idle' ? 'Talk to Beet' : status === 'connecting' ? 'Connecting…' : 'End call'}
        </button>
      </header>

      {error && <p className="error">{error}</p>}

      {day.totals && (
        <section className="totals">
          <Total label="Calories" value={day.totals.calories} unit="kcal" />
          <Total label="Protein" value={day.totals.protein} unit="g" />
          <Total label="Carbs" value={day.totals.carbs} unit="g" />
          <Total label="Fat" value={day.totals.fat} unit="g" />
        </section>
      )}

      {live && (
        <section className="captions">
          <p className="muted">Mic is live — say what you ate.</p>
          {captions.map((c) => (
            <p key={c.id} className={c.speaker}>
              <b>{c.speaker === 'you' ? 'You' : 'Beet'}:</b> {c.text}
            </p>
          ))}
        </section>
      )}

      {!day.entries.length && <p className="empty">Nothing logged yet today.</p>}

      {grouped.map(({ meal, entries }) => (
        <section key={meal}>
          <h2>{meal}</h2>
          <table>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="when">{time(e.loggedAt)}</td>
                  <td>
                    <strong>{e.foodName}</strong>
                    <div className="muted">{portion(e)}</div>
                    {e.spokenAs && <div className="said">“{e.spokenAs}”</div>}
                  </td>
                  <td className="macros">
                    <strong>{e.macros.calories} kcal</strong>
                    <div className="muted">
                      P {e.macros.protein} · C {e.macros.carbs} · F {e.macros.fat}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </main>
  );
}

function Total({ label, value, unit }) {
  return (
    <div>
      <span className="muted">{label}</span>
      <strong>
        {value}
        <small> {unit}</small>
      </strong>
    </div>
  );
}
