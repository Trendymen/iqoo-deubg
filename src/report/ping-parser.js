import fs from 'node:fs';
import readline from 'node:readline';
import { median } from '../shared/stats.js';
import { resolveStreamPhaseEx } from './stream-phase-detector.js';

const LOG_PREFIX_REGEX = /^\[ts_local=([^\]]+)\]\[epoch_ms=(\d+)\](?:\[source=([^\]]+)\])?\s*(.*)$/;
const BRACKET_TS_REGEX = /^\[(\d+(?:\.\d+)?)\]\s+/;
const SUCCESS_WITH_SEQ_REGEX = /(?:icmp_?seq|seq)\s*[=: ]\s*(\d+).*?\btime[=<]?\s*(\d+(?:\.\d+)?)\s*ms/i;
const SUCCESS_NO_SEQ_REGEX = /\btime[=<]?\s*(\d+(?:\.\d+)?)\s*ms/i;
const SEQ_ONLY_REGEX = /(?:icmp_?seq|seq)\s*[=: ]\s*(\d+)/i;
const NPING_SENT_REGEX = /^SENT\s+\(([\d.]+)s\)\s+ICMP\s+\[[^\]]+\bseq=(\d+)\]/i;
const NPING_RCVD_REGEX = /^RCVD\s+\(([\d.]+)s\)\s+ICMP\s+\[[^\]]+\bseq=(\d+)\]/i;
const HOST_SIDE_MAX_LATENCY_MS = 60000;

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

function parsePrefixedEpochMs(line) {
  const m = line.match(LOG_PREFIX_REGEX);
  if (!m) return null;
  const epochMs = toNumber(m[2]);
  if (!Number.isFinite(epochMs)) return null;
  return {
    epochMs,
    source: m[3] || '',
    payload: String(m[4] || '').trim()
  };
}

function parseElapsedMs(text) {
  const n = toNumber(text);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000);
}

function computeHostSideDeltaMs(sentRecord, rcvdElapsedMs, rcvdEpochMs) {
  if (sentRecord && Number.isFinite(sentRecord.elapsedMs) && Number.isFinite(rcvdElapsedMs)) {
    return rcvdElapsedMs - sentRecord.elapsedMs;
  }
  if (sentRecord && Number.isFinite(sentRecord.epochMs) && Number.isFinite(rcvdEpochMs)) {
    return rcvdEpochMs - sentRecord.epochMs;
  }
  return null;
}

function pickHostSideSentMatch({
  seq,
  rcvdElapsedMs,
  rcvdEpochMs,
  sentBySeq,
  sentRecords,
  maxGapMs
}) {
  let bestDirect = null;
  let bestByTime = null;

  if (Number.isFinite(seq) && sentBySeq.has(seq)) {
    const direct = sentBySeq.get(seq);
    if (direct && !direct.matched) {
      const deltaMs = computeHostSideDeltaMs(direct, rcvdElapsedMs, rcvdEpochMs);
      if (Number.isFinite(deltaMs) && deltaMs >= 0 && deltaMs <= maxGapMs) {
        bestDirect = { sent: direct, deltaMs };
      }
    }
  }

  for (let i = sentRecords.length - 1; i >= 0; i -= 1) {
    const sent = sentRecords[i];
    if (!sent || sent.matched) continue;
    const deltaMs = computeHostSideDeltaMs(sent, rcvdElapsedMs, rcvdEpochMs);
    if (!Number.isFinite(deltaMs)) continue;
    if (deltaMs < 0) continue;
    if (deltaMs > maxGapMs) break;
    bestByTime = { sent, deltaMs };
    break;
  }

  let best = null;
  if (bestDirect && bestByTime) {
    best = bestByTime.deltaMs <= bestDirect.deltaMs ? bestByTime : bestDirect;
  } else if (bestDirect) {
    best = bestDirect;
  } else if (bestByTime) {
    best = bestByTime;
  }

  if (!best) return null;
  best.sent.matched = true;
  if (Number.isFinite(best.sent.seq) && sentBySeq.get(best.sent.seq) === best.sent) {
    sentBySeq.delete(best.sent.seq);
  }
  return best;
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

  const windowsTxRx = line.match(/packets:\s*sent\s*=\s*(\d+),\s*received\s*=\s*(\d+),\s*lost\s*=\s*(\d+)\s*\((\d+(?:\.\d+)?)%/i);
  if (windowsTxRx) {
    summary.transmitted = toNumber(windowsTxRx[1]);
    summary.received = toNumber(windowsTxRx[2]);
    summary.packetLossPct = toNumber(windowsTxRx[4]);
  }

  const windowsRtt = line.match(/minimum\s*=\s*([\d.]+)ms,\s*maximum\s*=\s*([\d.]+)ms,\s*average\s*=\s*([\d.]+)ms/i);
  if (windowsRtt) {
    summary.reportedRtt = {
      min: toNumber(windowsRtt[1]),
      avg: toNumber(windowsRtt[3]),
      max: toNumber(windowsRtt[2]),
      mdev: null
    };
  }

  const npingTxRx = line.match(/Raw packets sent:\s*(\d+).*?\|\s*Rcvd:\s*(\d+).*?\|\s*Lost:\s*(\d+)\s*\((\d+(?:\.\d+)?)%/i);
  if (npingTxRx) {
    summary.transmitted = toNumber(npingTxRx[1]);
    summary.received = toNumber(npingTxRx[2]);
    summary.packetLossPct = toNumber(npingTxRx[4]);
  }

  const npingRtt = line.match(/Max rtt:\s*([\d.]+)ms\s*\|\s*Min rtt:\s*([\d.]+)ms\s*\|\s*Avg rtt:\s*([\d.]+)ms/i);
  if (npingRtt) {
    summary.reportedRtt = {
      min: toNumber(npingRtt[2]),
      avg: toNumber(npingRtt[3]),
      max: toNumber(npingRtt[1]),
      mdev: null
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
  intervalSec = 0.2,
  streamDetection = null
} = {}) {
  const hostSideMatchWindowMs = Math.max(1000, Math.round(Number(intervalSec || 0.2) * 1000 * 8));
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
    phaseCounts: {},
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
    jitterEvents: [],
    sessionSamples: [],
    sessionSuccessCount: 0,
    sessionFailureCount: 0,
    sessionHighLatencyEvents: [],
    sessionHighLatencyBursts: [],
    sessionJitterEvents: []
  };
  if (!result.exists) return result;

  const input = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let derivedSeq = 0;
  const hostSideSentBySeq = new Map();
  const hostSideSentRecords = [];
  let hostSideSentCount = 0;
  let hostSideReplyCount = 0;
  let hasHostSideSamples = false;

  function pushSample({
    ts,
    seq = null,
    success = false,
    latencyMs = null,
    status = 'no_reply',
    tsSource = 'unknown',
    line = ''
  }) {
    if (!ts || !Number.isFinite(ts.getTime())) {
      result.skippedNoTsCount += 1;
      return;
    }

    if (success) result.successCount += 1;
    else result.failureCount += 1;

    incrementCounter(result.tsSourceCounts, tsSource);
    const phaseInfo = resolveStreamPhaseEx(ts, streamDetection);
    incrementCounter(result.phaseCounts, phaseInfo.phase || 'unknown');
    if (!result.firstTs || ts < result.firstTs) result.firstTs = ts;
    if (!result.lastTs || ts > result.lastTs) result.lastTs = ts;

    result.samples.push({
      ts,
      seq: Number.isFinite(seq) ? seq : null,
      success,
      latencyMs: success && Number.isFinite(latencyMs) ? latencyMs : null,
      status,
      tsSource,
      phase: phaseInfo.phase,
      inSession: phaseInfo.inSession,
      line
    });
  }

  for await (const rawLine of rl) {
    const raw = String(rawLine || '').trim();
    if (!raw) continue;
    result.lineCount += 1;

    const prefixed = parsePrefixedEpochMs(raw);
    const payload = prefixed ? prefixed.payload : raw;
    const target = payload || raw;
    parsePingSummary(target, result.summary);
    const source = String((prefixed && prefixed.source) || '');

    if (source === 'host_side_ping') {
      hasHostSideSamples = true;
      const sentMatch = target.match(NPING_SENT_REGEX);
      if (sentMatch) {
        hostSideSentCount += 1;
        const sentElapsedMs = parseElapsedMs(sentMatch[1]);
        const sentSeq = toNumber(sentMatch[2]);
        let sentTs = null;
        let sentTsSource = 'unknown';
        if (prefixed && Number.isFinite(prefixed.epochMs)) {
          sentTs = new Date(prefixed.epochMs);
          sentTsSource = 'log_prefix_epoch';
        } else if (captureStartTs && Number.isFinite(sentSeq)) {
          const estimatedTsMs = captureStartTs.getTime() + Math.round((sentSeq - 1) * intervalSec * 1000);
          sentTs = new Date(estimatedTsMs);
          sentTsSource = 'seq_estimated';
        }
        const sentRecord = {
          seq: Number.isFinite(sentSeq) ? sentSeq : null,
          epochMs: (prefixed && Number.isFinite(prefixed.epochMs)) ? prefixed.epochMs : null,
          elapsedMs: Number.isFinite(sentElapsedMs) ? sentElapsedMs : null,
          ts: sentTs,
          tsSource: sentTsSource,
          line: target,
          matched: false
        };
        hostSideSentRecords.push(sentRecord);
        if (Number.isFinite(sentRecord.seq)) hostSideSentBySeq.set(sentRecord.seq, sentRecord);
        continue;
      }

      const rcvdMatch = target.match(NPING_RCVD_REGEX);
      if (rcvdMatch) {
        hostSideReplyCount += 1;
        const rcvdElapsedMs = parseElapsedMs(rcvdMatch[1]);
        const rcvdSeq = toNumber(rcvdMatch[2]);
        let ts = null;
        let tsSource = 'unknown';
        if (prefixed && Number.isFinite(prefixed.epochMs)) {
          ts = new Date(prefixed.epochMs);
          tsSource = 'log_prefix_epoch';
        }
        if (!ts && captureStartTs && Number.isFinite(rcvdSeq)) {
          const estimatedTsMs = captureStartTs.getTime() + Math.round((rcvdSeq - 1) * intervalSec * 1000);
          ts = new Date(estimatedTsMs);
          tsSource = 'seq_estimated';
        }

        let latencyMs = null;
        const matched = pickHostSideSentMatch({
          seq: rcvdSeq,
          rcvdElapsedMs,
          rcvdEpochMs: (prefixed && Number.isFinite(prefixed.epochMs)) ? prefixed.epochMs : null,
          sentBySeq: hostSideSentBySeq,
          sentRecords: hostSideSentRecords,
          maxGapMs: hostSideMatchWindowMs
        });
        if (matched && Number.isFinite(matched.deltaMs) && matched.deltaMs <= HOST_SIDE_MAX_LATENCY_MS) {
          latencyMs = matched.deltaMs;
        }

        const seq = matched && Number.isFinite(matched.sent.seq)
          ? matched.sent.seq
          : (Number.isFinite(rcvdSeq) ? rcvdSeq : null);
        pushSample({
          ts,
          seq,
          success: true,
          latencyMs,
          status: 'reply',
          tsSource,
          line: target
        });
        continue;
      }

      continue;
    }

    const successWithSeqMatch = target.match(SUCCESS_WITH_SEQ_REGEX);
    const successNoSeqMatch = successWithSeqMatch ? null : target.match(SUCCESS_NO_SEQ_REGEX);
    const seqMatch = successWithSeqMatch || target.match(SEQ_ONLY_REGEX);
    if (!seqMatch && !successNoSeqMatch) continue;

    let seq = seqMatch ? toNumber(seqMatch[1]) : null;
    const latencyMs = successWithSeqMatch
      ? toNumber(successWithSeqMatch[2])
      : (successNoSeqMatch ? toNumber(successNoSeqMatch[1]) : null);
    if (!Number.isFinite(seq) && Number.isFinite(latencyMs)) {
      derivedSeq += 1;
      seq = derivedSeq;
    } else if (Number.isFinite(seq)) {
      derivedSeq = Math.max(derivedSeq, seq);
    }

    const success = Number.isFinite(latencyMs);

    let ts = null;
    let tsSource = 'unknown';
    if (prefixed && Number.isFinite(prefixed.epochMs)) {
      ts = new Date(prefixed.epochMs);
      tsSource = 'log_prefix_epoch';
    } else {
      const bracketTsMs = parseBracketTimestampMs(target);
      if (bracketTsMs != null) {
        ts = new Date(bracketTsMs);
        tsSource = 'ping_D';
      }
    }
    if (!ts && captureStartTs && Number.isFinite(seq)) {
      const estimatedTsMs = captureStartTs.getTime() + Math.round((seq - 1) * intervalSec * 1000);
      ts = new Date(estimatedTsMs);
      tsSource = 'seq_estimated';
    }

    pushSample({
      ts,
      seq: Number.isFinite(seq) ? seq : null,
      success,
      latencyMs,
      status: success ? 'reply' : 'no_reply',
      tsSource,
      line: target
    });
  }

  if (hasHostSideSamples) {
    for (const sent of hostSideSentRecords) {
      if (!sent || sent.matched) continue;
      pushSample({
        ts: sent.ts,
        seq: sent.seq,
        success: false,
        latencyMs: null,
        status: 'no_reply',
        tsSource: sent.tsSource || 'unknown',
        line: sent.line || ''
      });
    }
    if (!Number.isFinite(result.summary.transmitted)) {
      result.summary.transmitted = hostSideSentCount;
    }
    if (!Number.isFinite(result.summary.received)) {
      result.summary.received = hostSideReplyCount;
    }
    if (!Number.isFinite(result.summary.packetLossPct) && hostSideSentCount > 0) {
      const lost = Math.max(0, hostSideSentCount - hostSideReplyCount);
      result.summary.packetLossPct = (lost * 100) / hostSideSentCount;
    }
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
      phase: x.phase,
      inSession: x.inSession,
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
        phase: cur.phase,
        inSession: cur.inSession,
        line: cur.line
      });
    }
  }

  result.sessionSamples = result.samples.filter((x) => x.inSession);
  result.sessionSuccessCount = result.sessionSamples.filter((x) => x.success).length;
  result.sessionFailureCount = result.sessionSamples.filter((x) => !x.success).length;
  result.sessionHighLatencyEvents = result.highLatencyEvents.filter((x) => x.inSession);
  result.sessionHighLatencyBursts = result.highLatencyBursts.filter((b) => resolveStreamPhaseEx(b.startTs, streamDetection).inSession);
  result.sessionJitterEvents = result.jitterEvents.filter((x) => x.inSession);

  return result;
}
