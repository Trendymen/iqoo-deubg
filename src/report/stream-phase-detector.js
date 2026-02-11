import fs from 'node:fs';
import readline from 'node:readline';
import { parseThreadtimeDate } from '../shared/time.js';

const APP_LINE_REGEX = /(com\.limelight|limelight\.qiin|moonlight-common-c)/i;
const THREADTIME_DETAIL_REGEX = /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}\s+\d+\s+\d+\s+[VDIWEAF]\s+([^:]+):\s?(.*)$/;

const STRONG_START_REGEX = /\[INTERNAL_STATS\]/i;
const MID_START_REGEX_LIST = [
  /Configuring with format/i,
  /Using codec/i,
  /Average end-to-end client latency/i,
  /Average hardware decoder latency/i
];
const WEAK_START_REGEX_LIST = [
  /Launched new game session/i,
  /Resumed existing game session/i
];
const END_REGEX_LIST = [
  /Connection terminated/i,
  /stage .* failed/i
];
const STREAM_ACTIVITY_REGEX_LIST = [
  /\[INTERNAL_STATS\]/i,
  /Rx\s+\d+(?:\.\d+)?\s*\/\s*Rd\s+\d+(?:\.\d+)?/i,
  /Average end-to-end client latency/i,
  /Average hardware decoder latency/i,
  /Configuring with format/i,
  /Using codec/i
];

const MERGE_GAP_MS = 10000;

function hasAnyRegex(text, regexList) {
  for (const re of regexList) {
    if (re.test(text)) return true;
  }
  return false;
}

function appendWindow(list, window) {
  if (!window || !window.startTs || !window.endTs) return;
  if (window.endTs < window.startTs) window.endTs = window.startTs;
  list.push(window);
}

function mergeWindowPair(prev, next) {
  return {
    startTs: prev.startTs < next.startTs ? prev.startTs : next.startTs,
    endTs: prev.endTs > next.endTs ? prev.endTs : next.endTs,
    hasStrongStart: prev.hasStrongStart || next.hasStrongStart,
    hasStartMarker: prev.hasStartMarker || next.hasStartMarker,
    hasEndMarker: prev.hasEndMarker || next.hasEndMarker,
    startMarkerCount: prev.startMarkerCount + next.startMarkerCount,
    endMarkerCount: prev.endMarkerCount + next.endMarkerCount,
    activityCount: prev.activityCount + next.activityCount,
    markerExamples: [...prev.markerExamples, ...next.markerExamples].slice(0, 8)
  };
}

function scoreWindow(window, mode) {
  const startScore = window.hasStartMarker ? 0.3 : 0;
  const strongScore = window.hasStrongStart ? 0.5 : 0;
  const endScore = window.hasEndMarker ? 0.2 : 0;
  const score = Math.min(1, startScore + strongScore + endScore);
  const valid = mode === 'strict'
    ? (window.hasStrongStart && score >= 0.5)
    : (score >= 0.5);
  return { score, valid };
}

export async function detectStreamingPhases(logcatPath, yearHint = new Date().getFullYear(), {
  mode = 'auto'
} = {}) {
  const out = {
    mode,
    windows: [],
    validWindows: [],
    detected: false,
    degraded: false,
    reason: null,
    markerCounts: {
      strongStart: 0,
      midStart: 0,
      weakStart: 0,
      end: 0,
      activity: 0
    }
  };

  if (!fs.existsSync(logcatPath)) {
    out.degraded = mode !== 'all';
    out.reason = 'missing_logcat';
    return out;
  }

  const parsedWindows = [];
  let current = null;

  const input = fs.createReadStream(logcatPath);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!APP_LINE_REGEX.test(line)) continue;
    const ts = parseThreadtimeDate(line, yearHint);
    if (!ts) continue;

    const detail = line.match(THREADTIME_DETAIL_REGEX);
    const tag = detail ? detail[1] : '';
    const message = detail ? detail[2] : line;
    const payload = `${tag} ${message}`;

    const strongStart = STRONG_START_REGEX.test(payload);
    const midStart = hasAnyRegex(payload, MID_START_REGEX_LIST);
    const weakStart = hasAnyRegex(payload, WEAK_START_REGEX_LIST);
    const endMarker = hasAnyRegex(payload, END_REGEX_LIST);
    const isStreamActivity = hasAnyRegex(payload, STREAM_ACTIVITY_REGEX_LIST);
    const hasStart = strongStart || midStart || weakStart;

    if (strongStart) out.markerCounts.strongStart += 1;
    if (midStart) out.markerCounts.midStart += 1;
    if (weakStart) out.markerCounts.weakStart += 1;
    if (endMarker) out.markerCounts.end += 1;
    if (isStreamActivity) out.markerCounts.activity += 1;

    if (hasStart) {
      if (!current) {
        current = {
          startTs: ts,
          endTs: ts,
          hasStrongStart: false,
          hasStartMarker: false,
          hasEndMarker: false,
          startMarkerCount: 0,
          endMarkerCount: 0,
          activityCount: 0,
          markerExamples: []
        };
      } else if ((ts.getTime() - current.endTs.getTime()) > MERGE_GAP_MS) {
        appendWindow(parsedWindows, current);
        current = {
          startTs: ts,
          endTs: ts,
          hasStrongStart: false,
          hasStartMarker: false,
          hasEndMarker: false,
          startMarkerCount: 0,
          endMarkerCount: 0,
          activityCount: 0,
          markerExamples: []
        };
      }
      current.hasStartMarker = true;
      current.hasStrongStart = current.hasStrongStart || strongStart;
      current.startMarkerCount += 1;
      current.endTs = ts;
      current.markerExamples.push(`[start] ${line.slice(0, 220)}`);
    }

    if (current && isStreamActivity) {
      current.activityCount += 1;
      current.endTs = ts;
    }

    if (current && endMarker) {
      current.hasEndMarker = true;
      current.endMarkerCount += 1;
      current.endTs = ts;
      current.markerExamples.push(`[end] ${line.slice(0, 220)}`);
      appendWindow(parsedWindows, current);
      current = null;
    }
  }
  if (current) appendWindow(parsedWindows, current);

  if (parsedWindows.length === 0) {
    out.degraded = mode !== 'all';
    out.reason = 'no_markers';
    return out;
  }

  parsedWindows.sort((a, b) => a.startTs.getTime() - b.startTs.getTime());
  const merged = [];
  for (const w of parsedWindows) {
    if (!merged.length) {
      merged.push(w);
      continue;
    }
    const last = merged[merged.length - 1];
    if ((w.startTs.getTime() - last.endTs.getTime()) < MERGE_GAP_MS) {
      merged[merged.length - 1] = mergeWindowPair(last, w);
    } else {
      merged.push(w);
    }
  }

  out.windows = merged.map((w, idx) => {
    const scored = scoreWindow(w, mode);
    return {
      id: idx + 1,
      ...w,
      score: scored.score,
      confidence: scored.score,
      valid: scored.valid
    };
  });
  out.validWindows = out.windows.filter((w) => w.valid);
  out.detected = out.validWindows.length > 0;
  out.degraded = mode !== 'all' && !out.detected;
  out.reason = out.detected ? null : 'no_valid_window';
  return out;
}

export function resolveStreamPhase(ts, detection) {
  if (!ts) return 'unknown';
  const validWindows = (detection && detection.validWindows) || [];
  if (validWindows.length === 0) return 'preconnect';

  const ms = ts.getTime();
  for (const w of validWindows) {
    if (ms >= w.startTs.getTime() && ms <= w.endTs.getTime()) return 'stream';
  }
  const first = validWindows[0];
  const last = validWindows[validWindows.length - 1];
  if (ms < first.startTs.getTime()) return 'preconnect';
  if (ms > last.endTs.getTime()) return 'post';
  return 'unknown';
}

export function getPhaseConfidence(phase, detection) {
  const detected = Boolean(detection && detection.detected);
  if (phase === 'stream') return detected ? 1 : 0.5;
  if (!detected) return 0.35;
  if (phase === 'preconnect' || phase === 'post') return 0.65;
  return 0.5;
}

export function buildStreamWindowRows(detection) {
  const rows = [];
  for (const w of (detection.windows || [])) {
    rows.push({
      id: w.id,
      start_ts: w.startTs.toISOString(),
      end_ts: w.endTs.toISOString(),
      duration_ms: Math.max(0, w.endTs.getTime() - w.startTs.getTime()),
      valid: w.valid ? 'true' : 'false',
      confidence: w.confidence.toFixed(2),
      score: w.score.toFixed(2),
      has_strong_start: w.hasStrongStart ? 'true' : 'false',
      has_start_marker: w.hasStartMarker ? 'true' : 'false',
      has_end_marker: w.hasEndMarker ? 'true' : 'false',
      start_marker_count: w.startMarkerCount,
      end_marker_count: w.endMarkerCount,
      activity_count: w.activityCount
    });
  }
  return rows;
}
