/** One-time "goal complete" celebration. Shown once per day (flag stored per day). */
import { wholeMinutes } from '../core/format.js';
import { el } from '../shared/stateClient.js';

const $ = (id) => document.getElementById(id);

export function showCelebration({ goalSeconds, streak, onClose }) {
  $('celebrateTitle').textContent = `${wholeMinutes(goalSeconds)} minutes complete`;
  $('celebrateStreak').textContent = `Day ${streak} streak`;
  const sparks = $('sparks');
  sparks.replaceChildren(...Array.from({ length: 16 }, (_, i) => {
    const angle = (i / 16) * Math.PI * 2 + Math.random() * 0.3;
    const dist = 60 + Math.random() * 50;
    return el('i', {
      class: 'spark',
      style: {
        '--x': `${Math.cos(angle) * dist}px`,
        '--y': `${Math.sin(angle) * dist - 20}px`,
        '--d': `${0.25 + Math.random() * 0.25}s`,
        background: i % 3 === 0 ? '#ff8a1f' : i % 3 === 1 ? '#ffc23d' : '#f2451d',
      },
    });
  }));
  const overlay = $('celebrate');
  overlay.hidden = false;
  const close = () => { overlay.hidden = true; onClose?.(); };
  $('celebrateClose').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  $('celebrateClose').focus();
}
