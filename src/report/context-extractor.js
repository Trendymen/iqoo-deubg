import fs from 'node:fs';
import readline from 'node:readline';
import { parseThreadtimeDate } from '../shared/time.js';

export async function buildContexts(logcatPath, targetEvents, yearHint = new Date().getFullYear()) {
  const contexts = new Map();
  if (targetEvents.length === 0) return contexts;

  const sortedTargets = targetEvents
    .map((e, idx) => ({
      id: idx,
      ts: e.ts,
      startMs: e.ts.getTime() - 5000,
      endMs: e.ts.getTime() + 5000,
      lines: []
    }))
    .sort((a, b) => a.ts.getTime() - b.ts.getTime());

  const input = fs.createReadStream(logcatPath);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const history = [];
  const active = [];
  let nextIdx = 0;

  for await (const line of rl) {
    const ts = parseThreadtimeDate(line, yearHint);
    if (!ts) continue;
    const ms = ts.getTime();

    while (history.length && history[0].ms < ms - 5000) history.shift();

    while (nextIdx < sortedTargets.length && sortedTargets[nextIdx].startMs <= ms) {
      const t = sortedTargets[nextIdx];
      t.lines = history.filter((h) => h.ms >= t.startMs).map((h) => h.line);
      active.push(t);
      nextIdx += 1;
    }

    for (const a of active) {
      if (ms >= a.startMs && ms <= a.endMs) a.lines.push(line);
    }

    for (let i = active.length - 1; i >= 0; i -= 1) {
      if (ms > active[i].endMs) {
        contexts.set(active[i].id, active[i].lines.slice());
        active.splice(i, 1);
      }
    }

    history.push({ ms, line });
  }

  for (const a of active) contexts.set(a.id, a.lines.slice());
  for (; nextIdx < sortedTargets.length; nextIdx += 1) {
    contexts.set(sortedTargets[nextIdx].id, []);
  }
  return contexts;
}
