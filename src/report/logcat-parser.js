import fs from 'node:fs';
import readline from 'node:readline';
import { parseThreadtimeDate, formatMinuteKey } from '../shared/time.js';
import { classifyLogcatLine, getLineFilterReason } from './classifier.js';

const CLUE_REGEX = /(wakelock|alarm|jobscheduler|job\b|sync|uid[:= ]\d+|pid[:= ]\d+)/i;
const WAKELOCK_REGEX = /wakelock/i;

export async function parseLogcatFile(logcatPath, store, yearHint = new Date().getFullYear()) {
  const logcatStats = {
    lineCount: 0,
    firstTs: null,
    lastTs: null,
    clues: [],
    wakelockMinuteHits: new Map(),
    filteredLineCount: 0,
    filteredByReason: {}
  };

  const input = fs.createReadStream(logcatPath);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    logcatStats.lineCount += 1;
    const ts = parseThreadtimeDate(line, yearHint);
    if (!ts) continue;
    if (!logcatStats.firstTs || ts < logcatStats.firstTs) logcatStats.firstTs = ts;
    if (!logcatStats.lastTs || ts > logcatStats.lastTs) logcatStats.lastTs = ts;

    const filterReason = getLineFilterReason(line);
    if (filterReason) {
      logcatStats.filteredLineCount += 1;
      logcatStats.filteredByReason[filterReason] = (logcatStats.filteredByReason[filterReason] || 0) + 1;
      continue;
    }

    const types = classifyLogcatLine(line);
    for (const t of types) store.addEvent(t, ts, 'logcat', line);

    const minute = formatMinuteKey(ts);
    if (WAKELOCK_REGEX.test(line)) {
      logcatStats.wakelockMinuteHits.set(minute, (logcatStats.wakelockMinuteHits.get(minute) || 0) + 1);
    }
    if (CLUE_REGEX.test(line)) {
      logcatStats.clues.push({
        ts,
        line: line.slice(0, 320)
      });
    }
  }
  return logcatStats;
}
