import fs from 'node:fs';
import readline from 'node:readline';
import { median } from '../shared/stats.js';

const BRACKET_TS_REGEX = /^\[(\d+(?:\.\d+)?)\]\s+/;
const SUCCESS_REGEX = /icmp_seq=(\d+).*?\btime[=<]?\s*(\d+(?:\.\d+)?)\s*ms/i;
const SEQ_ONLY_REGEX = /icmp_seq=(\d+)/i;

function toNumber(text) {
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function incrementCounter(counter, key) {
  counter[key] = (counter[key] || 0) + 1;
}

function parseBracketTimestampMs(line) {
  const m = line.match(BRACKET_TS_REGEX);
  if (!m) return null;
  const sec = Number(m[1]);
  if (!Number.isFinite(sec)) return null;
  return Math.round(sec * 1000);
}

function parsePingSummary(line, summary) {
  const txRx = line.match(/(\d+)\s+packets transmitted,\s+(\d+)\s+(?:packets )?received,\s*(\d+(?:\.\d+)?)%\s*packet loss/i);
  if (txRx) {
    summary.transmitted = toNumber(txRx[1]);
    summary.received = toNumber(txRx[2]);
    summary.packetLossPct = toNumber(txRx[3]);
  }

  const rtt = line.match(/(?:rtt|round-trip)\s+min\/avg\/max\/(?:mdev|stddev)\s*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)\s*ms/i);
  if (rtt) {
    summary.reportedRtt = {
      min: toNumber(rtt[1]),
      avg: toNumber(rtt[2]),
      max: toNumber(rtt[3]),
      mdev: toNumber(rtt[4])
    };
  }
}

function buildHighLatencyBursts(highSamples, maxGapMs = 1200) {
  if (!highSamples.length) return [];

  const bursts = [];
  let cur = null;
  for (const sample of highSamples) {
    if (!cur) {
      cur = {
        startTs: sample.ts,
        endTs: sample.ts,
        count: 1,
        startSeq: sample.seq,
        endSeq: sample.seq,
        maxLatencyMs: sample.latencyMs,
        sumLatencyMs: sample.latencyMs
      };
      continue;
    }

    const gap = sample.ts.getTime() - cur.endTs.getTime();
    if (gap > maxGapMs) {
      bursts.push({
        startTs: cur.startTs,
        endTs: cur.endTs,
        durationMs: cur.endTs.getTime() - cur.startTs.getTime(),
        count: cur.count,
        startSeq: cur.startSeq,
        endSeq: cur.endSeq,
        maxLatencyMs: cur.maxLatencyMs,
        avgLatencyMs: cur.sumLatencyMs / cur.count
      });
      cur = {
        startTs: sample.ts,
        endTs: sample.ts,
        count: 1,
        startSeq: sample.seq,
        endSeq: sample.seq,
        maxLatencyMs: sample.latencyMs,
        sumLatencyMs: sample.latencyMs
      };
      continue;
    }

    cur.endTs = sample.ts;
    cur.count += 1;
    cur.endSeq = sample.seq;
    cur.maxLatencyMs = Math.max(cur.maxLatencyMs, sample.latencyMs);
    cur.sumLatencyMs += sample.latencyMs;
  }

  if (cur) {
    bursts.push({
      startTs: cur.startTs,
      endTs: cur.endTs,
      durationMs: cur.endTs.getTime() - cur.startTs.getTime(),
      count: cur.count,
      startSeq: cur.startSeq,
      endSeq: cur.endSeq,
      maxLatencyMs: cur.maxLatencyMs,
      avgLatencyMs: cur.sumLatencyMs / cur.count
    });
  }
  return bursts;
}

export async function parsePingHostLog(filePath, {
  captureStartTs = null,
  intervalSec = 0.2
} = {}) {
  const result = {
    exists: fs.existsSync(filePath),
    lineCount: 0,
    sampleCount: 0,
    successCount: 0,
    failureCount: 0,
    skippedNoTsCount: 0,
    firstTs: null,
    lastTs: null,
    tsSourceCounts: {},
    summary: {
      transmitted: null,
      received: null,
      packetLossPct: null,
      reportedRtt: null
    },
    samples: [],
    highLatencyThresholdMs: null,
    highLatencyEvents: [],
    highLatencyBursts: [],
    jitterEvents: []
  };
  if (!result.exists) return result;

  const input = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const rawLine of rl) {
    const line = String(rawLine || '').trim();
    if (!line) continue;
    result.lineCount += 1;
    parsePingSummary(line, result.summary);

    const successMatch = line.match(SUCCESS_REGEX);
    const seqMatch = successMatch || line.match(SEQ_ONLY_REGEX);
    if (!seqMatch) continue;

    const seq = toNumber(seqMatch[1]);
    const latencyMs = successMatch ? toNumber(successMatch[2]) : null;
    const success = Number.isFinite(latencyMs);
    if (success) result.successCount += 1;
    else result.failureCount += 1;

    let ts = null;
    let tsSource = 'unknown';
    const bracketTsMs = parseBracketTimestampMs(line);
    if (bracketTsMs != null) {
      ts = new Date(bracketTsMs);
      tsSource = 'ping_D';
    } else if (captureStartTs && Number.isFinite(seq)) {
      const estimatedTsMs = captureStartTs.getTime() + Math.round((seq - 1) * intervalSec * 1000);
      ts = new Date(estimatedTsMs);
      tsSource = 'seq_estimated';
    }

    if (!ts) {
      result.skippedNoTsCount += 1;
      continue;
    }

    incrementCounter(result.tsSourceCounts, tsSource);
    if (!result.firstTs || ts < result.firstTs) result.firstTs = ts;
    if (!result.lastTs || ts > result.lastTs) result.lastTs = ts;

    result.samples.push({
      ts,
      seq: Number.isFinite(seq) ? seq : null,
      success,
      latencyMs: success ? latencyMs : null,
      status: success ? 'reply' : 'no_reply',
      tsSource,
      line
    });
  }

  result.samples.sort((a, b) => a.ts.getTime() - b.ts.getTime());
  result.sampleCount = result.samples.length;

  const successSamples = result.samples.filter((x) => x.success && Number.isFinite(x.latencyMs));
  if (successSamples.length > 0) {
    const sortedLatency = successSamples.map((x) => x.latencyMs).sort((a, b) => a - b);
    const baseline = median(sortedLatency);
    const thresholdMs = Math.max(15, (baseline || 0) + 8);
    result.highLatencyThresholdMs = thresholdMs;

    const highSamples = successSamples.filter((x) => x.latencyMs >= thresholdMs);
    result.highLatencyEvents = highSamples.map((x) => ({
      ts: x.ts,
      seq: x.seq,
      latencyMs: x.latencyMs,
      line: x.line
    }));
    result.highLatencyBursts = buildHighLatencyBursts(highSamples);

    for (let i = 1; i < successSamples.length; i += 1) {
      const prev = successSamples[i - 1];
      const cur = successSamples[i];
      const deltaMs = Math.abs(cur.latencyMs - prev.latencyMs);
      if (deltaMs < 8) continue;
      result.jitterEvents.push({
        ts: cur.ts,
        seq: cur.seq,
        latencyMs: cur.latencyMs,
        prevLatencyMs: prev.latencyMs,
        deltaMs,
        line: cur.line
      });
    }
  }

  return result;
}
