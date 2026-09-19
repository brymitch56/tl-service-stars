'use strict';
/**
 * In-process schedules. The nightly sync only READS Trail Life Connect; the
 * push is never scheduled here — it runs when an admin presses "Push now",
 * so the first person to find out a save went wrong is a human who is
 * already looking at the screen.
 *
 * Jitter keeps a troop's Pi from hitting the portal at the same second as
 * every other troop's.
 */
const sync = require('./sync');
const env = require('./env');

const HOUR = 3600e3;

function msUntil(hour, minute, jitterMinutes = 30) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return (next - now) + Math.floor(Math.random() * jitterMinutes * 60e3);
}

function start({ log = console.log } = {}) {
  if (env.DISABLE_SCHEDULER) { log('[scheduler] disabled'); return { stop() {} }; }
  if (env.SCHEDULE_SYNC !== 'nightly') { log(`[scheduler] sync schedule: ${env.SCHEDULE_SYNC}`); return { stop() {} }; }

  let timer = null;
  const arm = () => {
    const wait = msUntil(2, 40);
    log(`[scheduler] next sync in ${(wait / HOUR).toFixed(1)} h`);
    timer = setTimeout(async () => {
      try {
        const r = await sync.runSync({ trigger: 'schedule' });
        log(`[scheduler] sync ${r.ok ? 'ok' : 'failed'}: ${JSON.stringify(r.summary)}`);
        if (r.error) log(`[scheduler] ${r.error}`);
      } catch (e) {
        log(`[scheduler] sync threw: ${e.message}`);
      }
      arm();
    }, wait);
    if (timer.unref) timer.unref();
  };
  arm();
  return { stop() { if (timer) clearTimeout(timer); } };
}

module.exports = { start, msUntil };
