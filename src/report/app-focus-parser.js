import fs from 'node:fs';
import readline from 'node:readline';
import { parseThreadtimeDate } from '../shared/time.js';
import { resolveStreamPhaseEx, getPhaseConfidence } from './stream-phase-detector.js';

const APP_LINE_HINT_REGEX = /(com\.limelight|limelight\.qiin|moonlight-common-c|LimeLog|NvConnection|MediaCodecDecoderRenderer|\[STREAM_SESSION\])/i;
const APP_TAG_HINT_REGEX = /(LimeLog|moonlight-common-c|NvConnection|MediaCodecDecoderRenderer|com\.limelight)/i;
const STREAM_MARKER_HINT_REGEX = /(\[INTERNAL_STATS\]|\[STREAM_SESSION\]|Launched new game session|Resumed existing game session|Connection terminated|stage .* failed|Average end-to-end client latency|Average hardware decoder latency|Configuring with format|Using codec)/i;
const THREADTIME_DETAIL_REGEX = /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}\s+\d+\s+\d+\s+([VDIWEAF])\s+([^:]+):\s?(.*)$/;
const APP_NOISE_REGEX = /(failed to load disk cached box art|cache\/applist\/.*enoent)/i;
const LIMELOG_TAG_REGEX = /com\.limelight\.LimeLog/i;
const SESSION_MARKER_REGEX = /(Launched new game session|Resumed existing game session|Connection terminated|stage .* failed|Configuring with format|Using codec|Average end-to-end client latency|Average hardware decoder latency|\[STREAM_SESSION\])/i;
const POLL_NOISE_REGEX = /(Starting parallel poll|Starting poll thread|Polling .*TimeoutConfig\{)/i;

const INTERNAL_STATS_REGEX = /\[INTERNAL_STATS\].*?fps\(total\/rx\/rd\)=(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\s+loss=(\d+)\/(\d+)\((-?\d+(?:\.\d+)?)%\)\s+lossEvents=(\d+)\s+rtt=(\d+)ms\s+rttVar=(\d+)ms\s+decode=(-?\d+(?:\.\d+)?)ms\s+render=(-?\d+(?:\.\d+)?)ms\s+total=(-?\d+(?:\.\d+)?)ms\s+host\[min\/max\/avg\]=(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)ms/i;
const INTERNAL_DECODER_REGEX = /\[INTERNAL_STATS\].*?decoder=([^\s]+)\s+hdr=(true|false)/i;

function incrementCounter(counter, key) {
  counter[key] = (counter[key] || 0) + 1;
}

function toNumber(text) {
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function shouldSuppressPollNoise(noisePolicy, phase, isPollNoise) {
  if (!isPollNoise) return false;
  if (noisePolicy === 'conservative') return false;
  if (noisePolicy === 'aggressive') return true;
  return phase !== 'stream';
}

function parseInternalStats(message) {
  const m = message.match(INTERNAL_STATS_REGEX);
  if (!m) return null;
  const dec = message.match(INTERNAL_DECODER_REGEX);
  return {
    decoder: dec ? dec[1] : '',
    hdr: dec ? dec[2] : '',
    fpsTotal: toNumber(m[1]),
    fpsRx: toNumber(m[2]),
    fpsRd: toNumber(m[3]),
    lossFrames: toNumber(m[4]),
    lossTotal: toNumber(m[5]),
    lossPct: toNumber(m[6]),
    lossEvents: toNumber(m[7]),
    rttMs: toNumber(m[8]),
    rttVarMs: toNumber(m[9]),
    decodeMs: toNumber(m[10]),
    renderMs: toNumber(m[11]),
    totalMs: toNumber(m[12]),
    hostLatencyMinMs: toNumber(m[13]),
    hostLatencyMaxMs: toNumber(m[14]),
    hostLatencyAvgMs: toNumber(m[15])
  };
}

function isLikelyAppStreamLine(line, tag, payload) {
  if (APP_LINE_HINT_REGEX.test(line)) return true;
  if (tag && APP_TAG_HINT_REGEX.test(tag)) return true;
  if (STREAM_MARKER_HINT_REGEX.test(payload)) return true;
  return false;
}

export async function parseAppFocusLog(logcatPath, yearHint = new Date().getFullYear(), {
  streamDetection = null,
  noisePolicy = 'balanced'
} = {}) {
  const result = {
    matchedLineCount: 0,
    keptLineCount: 0,
    droppedLineCount: 0,
    droppedByReason: {},
    firstTs: null,
    lastTs: null,
    extractedLines: [],
    priorityCounts: {},
    tagCounts: {},
    phaseCounts: {},
    keywordCounts: {},
    metricSourceCounts: {},
    metricSamples: [],
    internalStatsSamples: [],
    anomalyEvents: []
  };

  const anomalyDedup = new Set();

  const addMetric = (ts, type, value, unit, line, phase, inSession, confidence, metricSource = 'legacy_pattern') => {
    if (!Number.isFinite(value)) return;
    result.metricSamples.push({ ts, type, value, unit, line, phase, inSession, confidence, metricSource });
    incrementCounter(result.metricSourceCounts, metricSource);
  };

  const addAnomaly = (ts, type, line, phase, inSession, confidence) => {
    const key = `${ts.getTime()}|${type}|${line}`;
    if (anomalyDedup.has(key)) return;
    anomalyDedup.add(key);
    result.anomalyEvents.push({ ts, type, line, phase, inSession, confidence });
  };

  const input = fs.createReadStream(logcatPath);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    const ts = parseThreadtimeDate(line, yearHint);
    if (!ts) continue;
    const detail = line.match(THREADTIME_DETAIL_REGEX);
    const priority = detail ? detail[1] : null;
    const tag = detail ? detail[2].trim() : null;
    const message = detail ? detail[3] : line;
    const payload = `${tag || ''} ${message || ''}`;
    if (!isLikelyAppStreamLine(line, tag, payload)) continue;

    const phaseInfo = resolveStreamPhaseEx(ts, streamDetection);
    const phase = phaseInfo.phase;
    const inSession = phaseInfo.inSession;
    const confidence = getPhaseConfidence(phase, streamDetection);
    result.matchedLineCount += 1;
    incrementCounter(result.phaseCounts, phase);
    if (!result.firstTs || ts < result.firstTs) result.firstTs = ts;
    if (!result.lastTs || ts > result.lastTs) result.lastTs = ts;

    if (priority) incrementCounter(result.priorityCounts, priority);
    if (tag) incrementCounter(result.tagCounts, tag);

    const pollNoise = POLL_NOISE_REGEX.test(message);
    const suppressPollNoise = shouldSuppressPollNoise(noisePolicy, phase, pollNoise);
    if (suppressPollNoise) {
      result.droppedLineCount += 1;
      incrementCounter(result.droppedByReason, 'preconnect_poll_noise');
      continue;
    }

    if (APP_NOISE_REGEX.test(message)) {
      result.droppedLineCount += 1;
      incrementCounter(result.droppedByReason, 'app_known_noise');
      continue;
    }

    let hasMetricFromLine = false;
    const internalStats = parseInternalStats(message);
    if (internalStats) {
      addMetric(ts, 'fps_total', internalStats.fpsTotal, 'fps', line, phase, inSession, confidence, 'internal_stats');
      addMetric(ts, 'fps_rx', internalStats.fpsRx, 'fps', line, phase, inSession, confidence, 'internal_stats');
      addMetric(ts, 'fps_rd', internalStats.fpsRd, 'fps', line, phase, inSession, confidence, 'internal_stats');
      addMetric(ts, 'loss_frames', internalStats.lossFrames, 'count', line, phase, inSession, confidence, 'internal_stats');
      addMetric(ts, 'loss_total', internalStats.lossTotal, 'count', line, phase, inSession, confidence, 'internal_stats');
      addMetric(ts, 'loss_pct', internalStats.lossPct, '%', line, phase, inSession, confidence, 'internal_stats');
      addMetric(ts, 'loss_events', internalStats.lossEvents, 'count', line, phase, inSession, confidence, 'internal_stats');
      addMetric(ts, 'rtt_ms', internalStats.rttMs, 'ms', line, phase, inSession, confidence, 'internal_stats');
      addMetric(ts, 'rtt_var_ms', internalStats.rttVarMs, 'ms', line, phase, inSession, confidence, 'internal_stats');
      addMetric(ts, 'decode_ms', internalStats.decodeMs, 'ms', line, phase, inSession, confidence, 'internal_stats');
      addMetric(ts, 'render_ms', internalStats.renderMs, 'ms', line, phase, inSession, confidence, 'internal_stats');
      addMetric(ts, 'total_ms', internalStats.totalMs, 'ms', line, phase, inSession, confidence, 'internal_stats');
      addMetric(ts, 'host_latency_min_ms', internalStats.hostLatencyMinMs, 'ms', line, phase, inSession, confidence, 'internal_stats');
      addMetric(ts, 'host_latency_max_ms', internalStats.hostLatencyMaxMs, 'ms', line, phase, inSession, confidence, 'internal_stats');
      addMetric(ts, 'host_latency_avg_ms', internalStats.hostLatencyAvgMs, 'ms', line, phase, inSession, confidence, 'internal_stats');
      result.internalStatsSamples.push({ ts, ...internalStats, phase, inSession, confidence, line });
      hasMetricFromLine = true;
    }

    const fpsPair = message.match(/Rx\s+(\d+(?:\.\d+)?)\s*\/\s*Rd\s+(\d+(?:\.\d+)?)\s*FPS/i);
    if (fpsPair) {
      addMetric(ts, 'fps_rx', toNumber(fpsPair[1]), 'fps', line, phase, inSession, confidence, 'legacy_pattern');
      addMetric(ts, 'fps_rd', toNumber(fpsPair[2]), 'fps', line, phase, inSession, confidence, 'legacy_pattern');
      hasMetricFromLine = true;
    }

    const rttJitter = message.match(/(\d+(?:\.\d+)?)\s*±\s*(\d+(?:\.\d+)?)\s*ms/i);
    if (rttJitter) {
      addMetric(ts, 'rtt_ms', toNumber(rttJitter[1]), 'ms', line, phase, inSession, confidence, 'legacy_pattern');
      addMetric(ts, 'jitter_ms', toNumber(rttJitter[2]), 'ms', line, phase, inSession, confidence, 'legacy_pattern');
      hasMetricFromLine = true;
    }

    const lossRate = message.match(/(?:丢帧率|跳帧率|loss\s*rate)\s*[:：]?\s*(-?\d+(?:\.\d+)?)\s*%/i);
    if (lossRate) {
      addMetric(ts, 'lost_frame_pct', toNumber(lossRate[1]), '%', line, phase, inSession, confidence, 'legacy_pattern');
      hasMetricFromLine = true;
    }

    const preciseSync = message.match(/精确同步:\s*(\d+)帧,\s*跳帧:\s*(\d+),\s*平均误差:\s*(-?\d+(?:\.\d+)?)ms/);
    if (preciseSync) {
      addMetric(ts, 'precise_sync_frames', toNumber(preciseSync[1]), 'count', line, phase, inSession, confidence, 'legacy_pattern');
      addMetric(ts, 'precise_sync_skipped_frames', toNumber(preciseSync[2]), 'count', line, phase, inSession, confidence, 'legacy_pattern');
      addMetric(ts, 'precise_sync_avg_error_ms', toNumber(preciseSync[3]), 'ms', line, phase, inSession, confidence, 'legacy_pattern');
      hasMetricFromLine = true;
    }

    const preciseSyncRate = message.match(/\[精确同步:\s*(\d+)渲染\/(\d+)接收,\s*跳帧率:\s*(-?\d+(?:\.\d+)?)%\]/);
    if (preciseSyncRate) {
      addMetric(ts, 'precise_sync_rendered_frames', toNumber(preciseSyncRate[1]), 'count', line, phase, inSession, confidence, 'legacy_pattern');
      addMetric(ts, 'precise_sync_received_frames', toNumber(preciseSyncRate[2]), 'count', line, phase, inSession, confidence, 'legacy_pattern');
      addMetric(ts, 'precise_sync_skip_rate_pct', toNumber(preciseSyncRate[3]), '%', line, phase, inSession, confidence, 'legacy_pattern');
      hasMetricFromLine = true;
    }

    const pendingAudio = message.match(/Too much pending audio data:\s*(-?\d+(?:\.\d+)?)\s*ms/i);
    if (pendingAudio) {
      addMetric(ts, 'pending_audio_ms', toNumber(pendingAudio[1]), 'ms', line, phase, inSession, confidence, 'legacy_pattern');
      hasMetricFromLine = true;
    }

    const timeoutConfig = message.match(/TimeoutConfig\{connect=(\d+)ms,\s*read=(\d+)ms,\s*stun=(\d+)ms\}/i);
    if (timeoutConfig) {
      addMetric(ts, 'timeout_connect_ms', toNumber(timeoutConfig[1]), 'ms', line, phase, inSession, confidence, 'legacy_pattern');
      addMetric(ts, 'timeout_read_ms', toNumber(timeoutConfig[2]), 'ms', line, phase, inSession, confidence, 'legacy_pattern');
      addMetric(ts, 'timeout_stun_ms', toNumber(timeoutConfig[3]), 'ms', line, phase, inSession, confidence, 'legacy_pattern');
      hasMetricFromLine = true;
    }

    const connStats = message.match(/Stats\{success=(\d+),\s*failure=(\d+),\s*rate=([\d.]+)%.*avg_response=(\d+)ms\}/i);
    if (connStats) {
      addMetric(ts, 'conn_success_count', toNumber(connStats[1]), 'count', line, phase, inSession, confidence, 'legacy_pattern');
      addMetric(ts, 'conn_failure_count', toNumber(connStats[2]), 'count', line, phase, inSession, confidence, 'legacy_pattern');
      addMetric(ts, 'conn_success_rate_pct', toNumber(connStats[3]), '%', line, phase, inSession, confidence, 'legacy_pattern');
      addMetric(ts, 'conn_avg_response_ms', toNumber(connStats[4]), 'ms', line, phase, inSession, confidence, 'legacy_pattern');
      hasMetricFromLine = true;
    }

    const e2eLatency = message.match(/Average end-to-end client latency:\s*(\d+)\s*ms/i);
    if (e2eLatency) {
      addMetric(ts, 'e2e_latency_ms', toNumber(e2eLatency[1]), 'ms', line, phase, inSession, confidence, 'legacy_pattern');
      hasMetricFromLine = true;
    }

    const decoderLatency = message.match(/Average hardware decoder latency:\s*(\d+)\s*ms/i);
    if (decoderLatency) {
      addMetric(ts, 'decoder_latency_ms', toNumber(decoderLatency[1]), 'ms', line, phase, inSession, confidence, 'legacy_pattern');
      hasMetricFromLine = true;
    }

    const displayRefresh = message.match(/Display refresh rate:\s*(-?\d+(?:\.\d+)?)\s*Hz/i);
    if (displayRefresh) {
      addMetric(ts, 'display_refresh_hz', toNumber(displayRefresh[1]), 'hz', line, phase, inSession, confidence, 'legacy_pattern');
      hasMetricFromLine = true;
    }

    const limeLogTag = tag && LIMELOG_TAG_REGEX.test(tag);
    const sessionMarker = SESSION_MARKER_REGEX.test(message);
    const anomalyPatterns = [
      { key: 'network_unstable', re: /Network is unstable|Network marked as unstable/i, type: 'network_unstable' },
      { key: 'connection_failure', re: /Connection failure for/i, type: 'connection_failure' },
      { key: 'poll_failed_quickly', re: /Poll failed quickly/i, type: 'poll_failed_quickly' },
      { key: 'offline', re: /\boffline\b/i, type: 'offline' },
      { key: 'pending_audio_backlog', re: /Too much pending audio data/i, type: 'pending_audio_backlog' },
      { key: 'stream_failed_or_terminated', re: /stage .* failed|Connection terminated/i, type: 'stream_failed_or_terminated' },
      { key: 'frame_pacing_or_skip', re: /时间漂移过大|跳帧率|loss=\d+\/\d+\(/i, type: 'frame_pacing_or_skip' }
    ];

    let hitAnomalyPattern = false;
    for (const p of anomalyPatterns) {
      if (!p.re.test(message)) continue;
      hitAnomalyPattern = true;
      incrementCounter(result.keywordCounts, p.key);
      addAnomaly(ts, p.type, line, phase, inSession, confidence);
    }

    if (priority && /[WEFA]/.test(priority) && (limeLogTag || hitAnomalyPattern || sessionMarker)) {
      addAnomaly(ts, 'warn_or_error', line, phase, inSession, confidence);
    }

    const highValue = Boolean(
      internalStats ||
      hasMetricFromLine ||
      hitAnomalyPattern ||
      sessionMarker ||
      (priority && /[WEFA]/.test(priority) && limeLogTag)
    );

    if (highValue) {
      result.keptLineCount += 1;
      result.extractedLines.push(line);
    } else {
      result.droppedLineCount += 1;
      incrementCounter(result.droppedByReason, 'non_high_value');
    }
  }

  result.metricSamples.sort((a, b) => a.ts.getTime() - b.ts.getTime());
  result.internalStatsSamples.sort((a, b) => a.ts.getTime() - b.ts.getTime());
  result.anomalyEvents.sort((a, b) => a.ts.getTime() - b.ts.getTime());
  return result;
}
