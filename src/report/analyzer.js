import { toCsv } from '../shared/csv.js';
import { buildMinuteRange, formatMinuteKey } from '../shared/time.js';
import { quantile, median, secondsDiffs, buildTopBins, computePeriodicity, countInRange, lowerBound } from '../shared/stats.js';
import { TIMELINE_COLUMNS, INTERVAL_EVENT_TYPES, PERIOD_TARGETS_SEC, TOP_CANDIDATES, NETWORK_EVENT_TYPES, TRANSITION_TYPES } from './constants.js';

export function buildTimeline({ startTs, endTs, events, wakelockMinuteHits }) {
  const minuteList = buildMinuteRange(startTs, endTs);
  const minuteCounters = new Map();
  for (const m of minuteList) {
    const key = formatMinuteKey(m);
    const row = {};
    TIMELINE_COLUMNS.forEach((c) => { row[c] = 0; });
    minuteCounters.set(key, row);
  }

  for (const e of events) {
    if (!TIMELINE_COLUMNS.includes(e.type)) continue;
    const key = formatMinuteKey(e.ts);
    if (!minuteCounters.has(key)) {
      const row = {};
      TIMELINE_COLUMNS.forEach((c) => { row[c] = 0; });
      minuteCounters.set(key, row);
    }
    minuteCounters.get(key)[e.type] += 1;
  }

  const wakelockSeries = minuteList.map((m) => wakelockMinuteHits.get(formatMinuteKey(m)) || 0).sort((a, b) => a - b);
  const wlMedian = median(wakelockSeries) || 0;
  const wlP25 = quantile(wakelockSeries, 0.25) || 0;
  const wlP75 = quantile(wakelockSeries, 0.75) || 0;
  const wlIqr = wlP75 - wlP25;
  const wlThreshold = wlMedian + 1.5 * wlIqr;

  for (const m of minuteList) {
    const key = formatMinuteKey(m);
    const wl = wakelockMinuteHits.get(key) || 0;
    minuteCounters.get(key).WAKELOCK_SPIKE = (wl > wlThreshold && wl > 0) ? 1 : 0;
  }

  const records = minuteList.map((m) => {
    const key = formatMinuteKey(m);
    return { minute: key, ...minuteCounters.get(key) };
  });

  return {
    minuteList,
    minuteCounters,
    csv: toCsv(records, ['minute', ...TIMELINE_COLUMNS]),
    wakelockStats: { wlMedian, wlP25, wlP75, wlIqr, wlThreshold }
  };
}

export function buildIntervals(eventsByType) {
  const intervalStats = {};
  const periodicityByType = {};
  const records = [];

  for (const type of INTERVAL_EVENT_TYPES) {
    const tsList = (eventsByType.get(type) || []).slice().sort((a, b) => a.getTime() - b.getTime());
    const diffs = secondsDiffs(tsList).sort((a, b) => a - b);
    const med = median(diffs);
    const p25 = quantile(diffs, 0.25);
    const p75 = quantile(diffs, 0.75);
    const bins = buildTopBins(diffs, 30, 3);
    const periodicity = computePeriodicity(diffs, PERIOD_TARGETS_SEC, 0.2);
    periodicityByType[type] = periodicity;
    intervalStats[type] = {
      intervalsCount: diffs.length,
      median: med,
      p25,
      p75,
      bins,
      periodicity,
      eventsCount: tsList.length
    };
    records.push({
      event_type: type,
      count: diffs.length,
      median_sec: med == null ? '' : med.toFixed(2),
      p25_sec: p25 == null ? '' : p25.toFixed(2),
      p75_sec: p75 == null ? '' : p75.toFixed(2),
      top_bins: bins.join(';')
    });
  }

  return {
    csv: toCsv(records, ['event_type', 'count', 'median_sec', 'p25_sec', 'p75_sec', 'top_bins']),
    intervalStats,
    periodicityByType
  };
}

export function buildEventCount(events) {
  const eventCount = {};
  TIMELINE_COLUMNS.forEach((t) => { eventCount[t] = 0; });
  for (const e of events) {
    if (eventCount[e.type] == null) eventCount[e.type] = 0;
    eventCount[e.type] += 1;
  }
  return eventCount;
}

export function pickTopPeriodicEvents(eventsByType, periodicityByType) {
  function getPeriodicity(type) {
    if (periodicityByType[type]) return periodicityByType[type];
    const tsList = (eventsByType.get(type) || []).slice().sort((a, b) => a.getTime() - b.getTime());
    const diffs = secondsDiffs(tsList).sort((a, b) => a - b);
    const p = computePeriodicity(diffs, PERIOD_TARGETS_SEC, 0.2);
    periodicityByType[type] = p;
    return p;
  }

  const scored = TOP_CANDIDATES.map((type) => {
    const count = (eventsByType.get(type) || []).length;
    const p = getPeriodicity(type);
    const score = (p.bestRatio || 0) * Math.log(count + 1);
    return { type, count, periodicity: p, score };
  }).sort((a, b) => (b.score - a.score) || (b.count - a.count));

  return scored.filter((x) => x.count > 0).slice(0, 3);
}

export function buildAlignment(events, eventsByType) {
  const networkEventTimes = events
    .filter((e) => NETWORK_EVENT_TYPES.includes(e.type))
    .map((e) => e.ts.getTime())
    .sort((a, b) => a - b);

  let overallPre = 0;
  let overallPost = 0;
  let overallN = 0;
  const byType = {};

  for (const t of TRANSITION_TYPES) {
    const arr = (eventsByType.get(t) || []).map((d) => d.getTime()).sort((a, b) => a - b);
    let pre = 0;
    let post = 0;
    for (const x of arr) {
      pre += countInRange(networkEventTimes, x - 60000, x - 1);
      post += countInRange(networkEventTimes, x + 1, x + 60000);
    }
    const n = arr.length;
    overallPre += pre;
    overallPost += post;
    overallN += n;
    byType[t] = {
      points: n,
      totalPre: pre,
      totalPost: post,
      avgPre: n ? pre / n : 0,
      avgPost: n ? post / n : 0,
      ratio: pre > 0 ? post / pre : (post > 0 ? Infinity : 1),
      increased: n > 0 && post >= pre * 1.5 && (post - pre) >= 2
    };
  }

  return {
    overall: {
      points: overallN,
      totalPre: overallPre,
      totalPost: overallPost,
      avgPre: overallN ? overallPre / overallN : 0,
      avgPost: overallN ? overallPost / overallN : 0,
      ratio: overallPre > 0 ? overallPost / overallPre : (overallPost > 0 ? Infinity : 1),
      increased: overallN > 0 && overallPost >= overallPre * 1.5 && (overallPost - overallPre) >= 2
    },
    byType
  };
}

function summarizeValues(values) {
  if (!values.length) {
    return {
      count: 0,
      min: null,
      p50: null,
      p95: null,
      max: null,
      avg: null
    };
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const sum = sorted.reduce((acc, x) => acc + x, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    avg: sum / sorted.length
  };
}

function analyzeMetricWindow(samples, pointTimes, windowMs) {
  if (!samples.length || !pointTimes.length) {
    return {
      points: pointTimes.length,
      preCount: 0,
      postCount: 0,
      preAvg: null,
      postAvg: null,
      delta: null
    };
  }

  const times = samples.map((x) => x.ts.getTime());
  let preCount = 0;
  let postCount = 0;
  let preSum = 0;
  let postSum = 0;

  for (const pointMs of pointTimes) {
    const preStart = pointMs - windowMs;
    const preEndExclusive = pointMs;
    const postStart = pointMs + 1;
    const postEndExclusive = pointMs + windowMs + 1;

    const preL = lowerBound(times, preStart);
    const preR = lowerBound(times, preEndExclusive);
    for (let i = preL; i < preR; i += 1) {
      preCount += 1;
      preSum += samples[i].value;
    }

    const postL = lowerBound(times, postStart);
    const postR = lowerBound(times, postEndExclusive);
    for (let i = postL; i < postR; i += 1) {
      postCount += 1;
      postSum += samples[i].value;
    }
  }

  const preAvg = preCount > 0 ? (preSum / preCount) : null;
  const postAvg = postCount > 0 ? (postSum / postCount) : null;
  return {
    points: pointTimes.length,
    preCount,
    postCount,
    preAvg,
    postAvg,
    delta: (preAvg == null || postAvg == null) ? null : (postAvg - preAvg)
  };
}

function filterByPhase(items, allowedPhaseSet) {
  return (items || []).filter((x) => allowedPhaseSet.has(x.phase || 'unknown'));
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function normalize(value, min, max) {
  if (!Number.isFinite(value)) return 0;
  if (max <= min) return 0;
  return clamp01((value - min) / (max - min));
}

function average(numbers) {
  const values = numbers.filter((x) => Number.isFinite(x));
  if (!values.length) return 0;
  return values.reduce((acc, x) => acc + x, 0) / values.length;
}

function computeScore(overlap, leadLag, intensity) {
  return clamp01(0.5 * overlap + 0.3 * leadLag + 0.2 * intensity);
}

function scoreToLevel(score) {
  if (score >= 0.7) return 'high';
  if (score >= 0.45) return 'medium';
  return 'low';
}

function pickMetricEvidence(metricType, metricSamplesByType, jitterEvents, windowMs, limit = 5) {
  const samples = (metricSamplesByType.get(metricType) || []).slice().sort((a, b) => a.ts.getTime() - b.ts.getTime());
  if (!samples.length || !jitterEvents.length) return [];
  const times = samples.map((x) => x.ts.getTime());
  const hits = [];
  for (const j of jitterEvents) {
    const jMs = j.ts.getTime();
    const l = lowerBound(times, jMs - windowMs);
    const r = lowerBound(times, jMs + windowMs + 1);
    for (let i = l; i < r; i += 1) {
      hits.push({
        ts: samples[i].ts,
        metric: metricType,
        value: samples[i].value,
        detail: `${metricType}=${samples[i].value}${samples[i].unit || ''}, jitterΔ=${j.deltaMs.toFixed(2)}ms`
      });
    }
  }
  return hits
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

function pickSystemEvidence(systemEventTimes, jitterPointTimes, windowMs, types, limit = 5) {
  const rows = [];
  for (const t of types) {
    const events = systemEventTimes[t] || [];
    for (const ms of events) {
      const hits = countInRange(jitterPointTimes, ms - windowMs, ms + windowMs);
      if (hits <= 0) continue;
      rows.push({
        ts: new Date(ms),
        metric: t,
        value: hits,
        detail: `${t} 附近抖动点数量=${hits}`
      });
    }
  }
  return rows
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

function appendEvidenceRow(target, seen, row) {
  if (!row || !(row.ts instanceof Date) || !Number.isFinite(row.value) || !row.metric || !row.detail) return;
  const key = `${row.ts.getTime()}|${row.metric}|${row.detail}`;
  if (seen.has(key)) return;
  seen.add(key);
  target.push(row);
}

function ensureEvidenceRows(primaryRows, fallbackRows, minCount = 3, maxCount = 5) {
  const out = [];
  const seen = new Set();
  for (const row of (primaryRows || [])) {
    if (out.length >= maxCount) break;
    appendEvidenceRow(out, seen, row);
  }
  if (out.length < minCount) {
    for (const row of (fallbackRows || [])) {
      if (out.length >= maxCount) break;
      appendEvidenceRow(out, seen, row);
    }
  }
  return out.slice(0, maxCount);
}

function buildScoreBreakdownEvidence(referenceTs, cause, overlap, leadLag, intensity) {
  if (!(referenceTs instanceof Date)) return [];
  return [
    {
      ts: referenceTs,
      metric: `${cause}_overlap`,
      value: overlap,
      detail: `${cause} overlap=${overlap.toFixed(2)}`
    },
    {
      ts: referenceTs,
      metric: `${cause}_lead_lag`,
      value: leadLag,
      detail: `${cause} lead_lag=${leadLag.toFixed(2)}`
    },
    {
      ts: referenceTs,
      metric: `${cause}_intensity`,
      value: intensity,
      detail: `${cause} intensity=${intensity.toFixed(2)}`
    }
  ];
}

function buildCauseRanking({
  degraded,
  windowMs,
  latencySummary,
  jitterSummary,
  appAnomalyAroundJitter,
  appAnomalyAroundHighLatency,
  appMetricAroundJitter,
  metricSummary,
  metricSamplesByType,
  jitterEvents,
  highLatencyBursts,
  systemAroundJitter,
  systemEventTimes,
  jitterPointTimes,
  referenceTs
}) {
  const ranking = [];

  const networkOverlap = clamp01((appAnomalyAroundJitter.hitRatio || 0) * 1.2);
  const networkLeadLag = clamp01((appAnomalyAroundHighLatency.hitRatio || 0) * 1.2);
  const networkIntensity = average([
    normalize(latencySummary.lossRatePct, 0, 2),
    normalize(latencySummary.p95, 12, 40),
    normalize(jitterSummary.p95DeltaMs, 8, 60)
  ]);
  const networkScore = computeScore(networkOverlap, networkLeadLag, networkIntensity);
  const networkEvidencePrimary = (highLatencyBursts || []).slice()
    .sort((a, b) => b.maxLatencyMs - a.maxLatencyMs)
    .slice(0, 5)
    .map((x) => ({
      ts: x.startTs,
      metric: 'ping_high_latency',
      value: x.maxLatencyMs,
      detail: `seq=${x.startSeq}~${x.endSeq}, max=${x.maxLatencyMs.toFixed(2)}ms, avg=${x.avgLatencyMs.toFixed(2)}ms`
    }));
  const networkEvidenceFallback = [
    ...(jitterEvents || []).slice(0, 4).map((x) => ({
      ts: x.ts,
      metric: 'ping_jitter_delta',
      value: x.deltaMs,
      detail: `seq=${x.seq == null ? 'N/A' : x.seq}, latency=${Number.isFinite(x.latencyMs) ? x.latencyMs.toFixed(2) : 'N/A'}ms, delta=${x.deltaMs.toFixed(2)}ms`
    })),
    ...(Number.isFinite(latencySummary.p95) && referenceTs ? [{
      ts: referenceTs,
      metric: 'ping_p95_ms',
      value: latencySummary.p95,
      detail: `loss=${latencySummary.lossRatePct.toFixed(2)}%, p95=${latencySummary.p95.toFixed(2)}ms`
    }] : []),
    ...buildScoreBreakdownEvidence(referenceTs, 'network_path_jitter', networkOverlap, networkLeadLag, networkIntensity)
  ];
  const networkEvidence = ensureEvidenceRows(networkEvidencePrimary, networkEvidenceFallback, 3, 5);
  const networkAdjustedScore = degraded ? networkScore * 0.7 : networkScore;
  ranking.push({
    cause: 'network_path_jitter',
    score: networkAdjustedScore,
    overlap: networkOverlap,
    leadLag: networkLeadLag,
    intensity: networkIntensity,
    level: scoreToLevel(networkAdjustedScore),
    confidence: degraded ? 'low' : scoreToLevel(networkScore),
    evidence: networkEvidence
  });

  const rttVarSummary = metricSummary.rtt_var_ms || {};
  const rttVarNear = appMetricAroundJitter.rtt_var_ms || {};
  const rttOverlap = clamp01((rttVarNear.count || 0) / Math.max(1, (jitterEvents || []).length));
  const rttLeadLag = clamp01((rttVarNear.avg || 0) / Math.max(1, (latencySummary.p95 || 20)));
  const rttIntensity = normalize(rttVarSummary.p95, 5, 40);
  const rttScore = computeScore(rttOverlap, rttLeadLag, rttIntensity);
  const rttEvidence = ensureEvidenceRows(
    pickMetricEvidence('rtt_var_ms', metricSamplesByType, jitterEvents || [], windowMs, 5),
    [
      ...pickMetricEvidence('rtt_ms', metricSamplesByType, jitterEvents || [], windowMs, 3),
      ...(Number.isFinite(rttVarSummary.p95) && referenceTs ? [{
        ts: referenceTs,
        metric: 'rtt_var_ms_p95',
        value: rttVarSummary.p95,
        detail: `rttVar p95=${rttVarSummary.p95.toFixed(2)}ms`
      }] : []),
      ...buildScoreBreakdownEvidence(referenceTs, 'rtt_variance_burst', rttOverlap, rttLeadLag, rttIntensity)
    ],
    3,
    5
  );
  const rttAdjustedScore = degraded ? rttScore * 0.7 : rttScore;
  ranking.push({
    cause: 'rtt_variance_burst',
    score: rttAdjustedScore,
    overlap: rttOverlap,
    leadLag: rttLeadLag,
    intensity: rttIntensity,
    level: scoreToLevel(rttAdjustedScore),
    confidence: degraded ? 'low' : scoreToLevel(rttScore),
    evidence: rttEvidence
  });

  const decodeSummary = metricSummary.decode_ms || {};
  const renderSummary = metricSummary.render_ms || {};
  const totalSummary = metricSummary.total_ms || {};
  const lossSummary = metricSummary.loss_pct || metricSummary.lost_frame_pct || {};
  const fpsSummary = metricSummary.fps_total || metricSummary.fps_rd || {};
  const decodeNearCount = (appMetricAroundJitter.decode_ms && appMetricAroundJitter.decode_ms.count) || 0;
  const renderNearCount = (appMetricAroundJitter.render_ms && appMetricAroundJitter.render_ms.count) || 0;
  const totalNearCount = (appMetricAroundJitter.total_ms && appMetricAroundJitter.total_ms.count) || 0;
  const lossNearCount = (appMetricAroundJitter.loss_pct && appMetricAroundJitter.loss_pct.count)
    || (appMetricAroundJitter.lost_frame_pct && appMetricAroundJitter.lost_frame_pct.count) || 0;
  const decodeOverlap = clamp01((decodeNearCount + renderNearCount + totalNearCount + lossNearCount) / Math.max(1, (jitterEvents || []).length * 1.2));
  const decodeLeadLag = clamp01(appAnomalyAroundHighLatency.hitRatio || 0);
  const decodeIntensity = average([
    normalize(Math.max(totalSummary.p95 || 0, decodeSummary.p95 || 0, renderSummary.p95 || 0), 12, 80),
    normalize(lossSummary.p95 || 0, 0.5, 10),
    fpsSummary.p50 == null ? 0 : clamp01((60 - fpsSummary.p50) / 60)
  ]);
  const decodeScore = computeScore(decodeOverlap, decodeLeadLag, decodeIntensity);
  const decodeEvidence = ensureEvidenceRows(
    [
      ...pickMetricEvidence('total_ms', metricSamplesByType, jitterEvents || [], windowMs, 3),
      ...pickMetricEvidence('loss_pct', metricSamplesByType, jitterEvents || [], windowMs, 2)
    ],
    [
      ...pickMetricEvidence('decode_ms', metricSamplesByType, jitterEvents || [], windowMs, 2),
      ...pickMetricEvidence('render_ms', metricSamplesByType, jitterEvents || [], windowMs, 2),
      ...(Number.isFinite(totalSummary.p95) && referenceTs ? [{
        ts: referenceTs,
        metric: 'total_ms_p95',
        value: totalSummary.p95,
        detail: `total_ms p95=${totalSummary.p95.toFixed(2)}ms, fps_p50=${fpsSummary.p50 == null ? 'N/A' : fpsSummary.p50.toFixed(2)}`
      }] : []),
      ...buildScoreBreakdownEvidence(referenceTs, 'decode_render_overload', decodeOverlap, decodeLeadLag, decodeIntensity)
    ],
    3,
    5
  );
  const decodeAdjustedScore = degraded ? decodeScore * 0.7 : decodeScore;
  ranking.push({
    cause: 'decode_render_overload',
    score: decodeAdjustedScore,
    overlap: decodeOverlap,
    leadLag: decodeLeadLag,
    intensity: decodeIntensity,
    level: scoreToLevel(decodeAdjustedScore),
    confidence: degraded ? 'low' : scoreToLevel(decodeScore),
    evidence: decodeEvidence
  });

  const keySystemTypes = ['DISCONNECT', 'DHCP', 'DOZE_ENTER', 'DOZE_EXIT', 'IDLE_ENTER', 'IDLE_EXIT', 'CONNECT'];
  const sysRows = keySystemTypes.map((t) => systemAroundJitter[t] || { hitRatio: 0, total: 0, avgPerPoint: 0 });
  const sysOverlap = Math.max(...sysRows.map((x) => x.hitRatio || 0), 0);
  const sysLeadLag = normalize(sysRows.reduce((acc, x) => acc + (x.avgPerPoint || 0), 0), 0.01, 0.2);
  const sysIntensity = normalize(sysRows.reduce((acc, x) => acc + (x.total || 0), 0), 2, 60);
  const sysScore = computeScore(sysOverlap, sysLeadLag, sysIntensity);
  const systemEvidence = ensureEvidenceRows(
    pickSystemEvidence(systemEventTimes, jitterPointTimes, windowMs, keySystemTypes, 5),
    [
      ...(referenceTs ? keySystemTypes
        .map((t) => ({ t, row: systemAroundJitter[t] || { total: 0, avgPerPoint: 0 } }))
        .filter(({ row }) => row.total > 0)
        .slice(0, 5)
        .map(({ t, row }) => ({
          ts: referenceTs,
          metric: t,
          value: row.total,
          detail: `${t} 在抖动窗口累计=${row.total}, avg=${row.avgPerPoint.toFixed(2)}`
        })) : []),
      ...buildScoreBreakdownEvidence(referenceTs, 'system_transition_interference', sysOverlap, sysLeadLag, sysIntensity)
    ],
    3,
    5
  );
  const systemAdjustedScore = degraded ? sysScore * 0.7 : sysScore;
  ranking.push({
    cause: 'system_transition_interference',
    score: systemAdjustedScore,
    overlap: sysOverlap,
    leadLag: sysLeadLag,
    intensity: sysIntensity,
    level: scoreToLevel(systemAdjustedScore),
    confidence: degraded ? 'low' : scoreToLevel(sysScore),
    evidence: systemEvidence
  });

  ranking.sort((a, b) => b.score - a.score);
  return ranking;
}

export function buildAppFocusAnalysis(appFocus, eventsByType, {
  windowSec = 60,
  allowedPhases = ['stream']
} = {}) {
  const allowedPhaseSet = new Set(allowedPhases || []);
  const filteredAnomalies = filterByPhase(appFocus.anomalyEvents, allowedPhaseSet);
  const filteredMetrics = filterByPhase(appFocus.metricSamples, allowedPhaseSet);
  const anomalyTimes = filteredAnomalies.map((e) => e.ts.getTime()).sort((a, b) => a - b);
  const windowMs = windowSec * 1000;

  const metricValuesByType = new Map();
  for (const sample of filteredMetrics) {
    if (!metricValuesByType.has(sample.type)) metricValuesByType.set(sample.type, []);
    metricValuesByType.get(sample.type).push(sample);
  }
  for (const [k, arr] of metricValuesByType.entries()) {
    arr.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    metricValuesByType.set(k, arr);
  }

  const metricSummary = {};
  for (const [type, arr] of metricValuesByType.entries()) {
    metricSummary[type] = {
      ...summarizeValues(arr.map((x) => x.value)),
      unit: arr[0] ? arr[0].unit : ''
    };
  }

  const anomalyTransitionPrePost = {};
  for (const transitionType of TRANSITION_TYPES) {
    const points = (eventsByType.get(transitionType) || []).map((d) => d.getTime()).sort((a, b) => a - b);
    let pre = 0;
    let post = 0;
    let windowsWithAny = 0;

    for (const x of points) {
      const preCount = countInRange(anomalyTimes, x - windowMs, x - 1);
      const postCount = countInRange(anomalyTimes, x + 1, x + windowMs);
      pre += preCount;
      post += postCount;
      if ((preCount + postCount) > 0) windowsWithAny += 1;
    }

    anomalyTransitionPrePost[transitionType] = {
      points: points.length,
      totalPre: pre,
      totalPost: post,
      ratio: pre > 0 ? (post / pre) : (post > 0 ? Infinity : 1),
      windowsWithAny,
      hitRatio: points.length > 0 ? (windowsWithAny / points.length) : 0
    };
  }

  const appAnomalyBySystemEvent = {};
  const systemEventTypes = [...new Set([...TRANSITION_TYPES, ...NETWORK_EVENT_TYPES])];
  for (const eventType of systemEventTypes) {
    const points = (eventsByType.get(eventType) || []).map((d) => d.getTime()).sort((a, b) => a - b);
    let totalAround = 0;
    let windowsWithAny = 0;
    for (const x of points) {
      const around = countInRange(anomalyTimes, x - windowMs, x + windowMs);
      totalAround += around;
      if (around > 0) windowsWithAny += 1;
    }
    appAnomalyBySystemEvent[eventType] = {
      points: points.length,
      totalAround,
      avgAround: points.length > 0 ? (totalAround / points.length) : 0,
      windowsWithAny,
      hitRatio: points.length > 0 ? (windowsWithAny / points.length) : 0
    };
  }

  const allTransitionPoints = TRANSITION_TYPES
    .flatMap((t) => (eventsByType.get(t) || []).map((d) => d.getTime()))
    .sort((a, b) => a - b);

  const metricTransitionWindow = {};
  for (const [metricType, samples] of metricValuesByType.entries()) {
    const byTransition = {};
    for (const transitionType of TRANSITION_TYPES) {
      const points = (eventsByType.get(transitionType) || []).map((d) => d.getTime()).sort((a, b) => a - b);
      byTransition[transitionType] = analyzeMetricWindow(samples, points, windowMs);
    }
    metricTransitionWindow[metricType] = {
      overall: analyzeMetricWindow(samples, allTransitionPoints, windowMs),
      byTransition
    };
  }

  return {
    windowSec,
    allowedPhases: [...allowedPhaseSet],
    selectedAnomalyCount: filteredAnomalies.length,
    selectedMetricSampleCount: filteredMetrics.length,
    metricSummary,
    anomalyTransitionPrePost,
    appAnomalyBySystemEvent,
    metricTransitionWindow
  };
}

function countItemsNearPoints(sortedTimes, pointTimes, windowMs) {
  if (!sortedTimes.length || !pointTimes.length) {
    return {
      points: pointTimes.length,
      total: 0,
      windowsWithAny: 0,
      hitRatio: 0,
      avgPerPoint: 0
    };
  }
  let total = 0;
  let windowsWithAny = 0;
  for (const pointMs of pointTimes) {
    const c = countInRange(sortedTimes, pointMs - windowMs, pointMs + windowMs);
    total += c;
    if (c > 0) windowsWithAny += 1;
  }
  return {
    points: pointTimes.length,
    total,
    windowsWithAny,
    hitRatio: pointTimes.length ? (windowsWithAny / pointTimes.length) : 0,
    avgPerPoint: pointTimes.length ? (total / pointTimes.length) : 0
  };
}

function extractSortedSystemEventTimes(eventsByType) {
  const out = {};
  const types = [...new Set([...NETWORK_EVENT_TYPES, ...TRANSITION_TYPES])];
  for (const t of types) {
    out[t] = (eventsByType.get(t) || []).map((d) => d.getTime()).sort((a, b) => a - b);
  }
  return out;
}

function inferPingFindings({
  latencySummary,
  jitterSummary,
  aroundJitter,
  aroundHighLatency
}) {
  const findings = [];

  if ((latencySummary.lossRatePct || 0) >= 1) {
    findings.push({
      type: 'ping_loss',
      level: 'high',
      detail: `Ping 丢包率 ${(latencySummary.lossRatePct || 0).toFixed(2)}%`
    });
  }
  if ((latencySummary.p95 || 0) >= 20 || (latencySummary.highLatencyBurstCount || 0) > 0) {
    findings.push({
      type: 'latency_spike',
      level: 'medium',
      detail: `Ping p95=${latencySummary.p95 == null ? 'N/A' : `${latencySummary.p95.toFixed(2)}ms`}，高延迟段=${latencySummary.highLatencyBurstCount || 0}`
    });
  }
  if ((jitterSummary.p95DeltaMs || 0) >= 8 || (jitterSummary.count || 0) >= 4) {
    findings.push({
      type: 'jitter_jump',
      level: 'medium',
      detail: `延迟跳变 p95Δ=${jitterSummary.p95DeltaMs == null ? 'N/A' : `${jitterSummary.p95DeltaMs.toFixed(2)}ms`}`
    });
  }
  if ((aroundJitter.hitRatio || 0) >= 0.4 && (aroundJitter.total || 0) >= 8) {
    findings.push({
      type: 'app_jitter_correlated',
      level: 'high',
      detail: `App 异常与 ping 抖动同窗命中率 ${(aroundJitter.hitRatio * 100).toFixed(1)}%`
    });
  }
  if ((aroundHighLatency.hitRatio || 0) >= 0.4 && (aroundHighLatency.total || 0) >= 8) {
    findings.push({
      type: 'app_high_latency_correlated',
      level: 'high',
      detail: `App 异常与 ping 高延迟段同窗命中率 ${(aroundHighLatency.hitRatio * 100).toFixed(1)}%`
    });
  }
  return findings;
}

export function buildPingAppAnalysis(pingFocus, appFocus, eventsByType, {
  windowSec = 1,
  allowedPhases = ['stream'],
  degraded = false
} = {}) {
  const allowedPhaseSet = new Set(allowedPhases || []);
  const selectedAnomalyEvents = filterByPhase(appFocus.anomalyEvents, allowedPhaseSet);
  const selectedMetricSamples = filterByPhase(appFocus.metricSamples, allowedPhaseSet);

  const successSamples = (pingFocus.samples || [])
    .filter((x) => x.success && Number.isFinite(x.latencyMs))
    .sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const latencyValues = successSamples.map((x) => x.latencyMs);
  const latencySummary = summarizeValues(latencyValues);
  const jitterDeltaValues = (pingFocus.jitterEvents || []).map((x) => x.deltaMs).sort((a, b) => a - b);

  const transmitted = pingFocus.summary && Number.isFinite(pingFocus.summary.transmitted)
    ? pingFocus.summary.transmitted
    : pingFocus.sampleCount;
  const received = pingFocus.summary && Number.isFinite(pingFocus.summary.received)
    ? pingFocus.summary.received
    : pingFocus.successCount;
  const lossRatePct = transmitted > 0 ? (Math.max(0, transmitted - received) * 100 / transmitted) : 0;

  const latencyWithDerived = {
    ...latencySummary,
    successCount: pingFocus.successCount || 0,
    failureCount: pingFocus.failureCount || 0,
    transmitted,
    received,
    lossRatePct,
    highLatencyThresholdMs: pingFocus.highLatencyThresholdMs,
    highLatencyBurstCount: (pingFocus.highLatencyBursts || []).length,
    highLatencyEventCount: (pingFocus.highLatencyEvents || []).length
  };

  const windowMs = Math.round(windowSec * 1000);
  const anomalyTimes = selectedAnomalyEvents.map((e) => e.ts.getTime()).sort((a, b) => a - b);
  const jitterPointTimes = (pingFocus.jitterEvents || []).map((x) => x.ts.getTime()).sort((a, b) => a - b);
  const highLatencyPointTimes = (pingFocus.highLatencyBursts || [])
    .map((x) => x.startTs.getTime())
    .sort((a, b) => a - b);

  const appAnomalyAroundJitter = countItemsNearPoints(anomalyTimes, jitterPointTimes, windowMs);
  const appAnomalyAroundHighLatency = countItemsNearPoints(anomalyTimes, highLatencyPointTimes, windowMs);

  const systemEventTimes = extractSortedSystemEventTimes(eventsByType);
  const systemAroundJitter = {};
  for (const [eventType, sortedTimes] of Object.entries(systemEventTimes)) {
    systemAroundJitter[eventType] = countItemsNearPoints(sortedTimes, jitterPointTimes, windowMs);
  }

  const appMetricAroundJitter = {};
  const appMetricSamplesByType = new Map();
  for (const sample of selectedMetricSamples) {
    if (!appMetricSamplesByType.has(sample.type)) appMetricSamplesByType.set(sample.type, []);
    appMetricSamplesByType.get(sample.type).push(sample);
  }
  const metricSummary = {};
  for (const [metricType, samples] of appMetricSamplesByType.entries()) {
    samples.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    metricSummary[metricType] = {
      ...summarizeValues(samples.map((x) => x.value)),
      unit: samples[0] ? samples[0].unit : ''
    };
    const times = samples.map((x) => x.ts.getTime());
    let count = 0;
    let sum = 0;
    for (const pointMs of jitterPointTimes) {
      const l = lowerBound(times, pointMs - windowMs);
      const r = lowerBound(times, pointMs + windowMs + 1);
      for (let i = l; i < r; i += 1) {
        count += 1;
        sum += samples[i].value;
      }
    }
    appMetricAroundJitter[metricType] = {
      count,
      avg: count > 0 ? (sum / count) : null,
      unit: samples[0] ? samples[0].unit : ''
    };
  }

  const jitterAlignmentRows = (pingFocus.jitterEvents || []).slice(0, 24).map((x) => ({
    ts: x.ts,
    seq: x.seq,
    latencyMs: x.latencyMs,
    deltaMs: x.deltaMs
  }));

  const findings = inferPingFindings({
    latencySummary: latencyWithDerived,
    jitterSummary: {
      count: jitterDeltaValues.length,
      p95DeltaMs: quantile(jitterDeltaValues, 0.95)
    },
    aroundJitter: appAnomalyAroundJitter,
    aroundHighLatency: appAnomalyAroundHighLatency
  });
  const normalizedFindings = degraded
    ? findings.map((x) => ({
      ...x,
      level: 'low',
      detail: `[降级分析] ${x.detail}`
    }))
    : findings;

  const referenceTs = pingFocus.firstTs
    || (successSamples[0] && successSamples[0].ts)
    || (selectedMetricSamples[0] && selectedMetricSamples[0].ts)
    || (selectedAnomalyEvents[0] && selectedAnomalyEvents[0].ts)
    || null;

  const causeRanking = buildCauseRanking({
    degraded,
    windowMs,
    latencySummary: latencyWithDerived,
    jitterSummary: {
      count: jitterDeltaValues.length,
      p50DeltaMs: quantile(jitterDeltaValues, 0.5),
      p95DeltaMs: quantile(jitterDeltaValues, 0.95),
      maxDeltaMs: jitterDeltaValues.length ? jitterDeltaValues[jitterDeltaValues.length - 1] : null
    },
    appAnomalyAroundJitter,
    appAnomalyAroundHighLatency,
    appMetricAroundJitter,
    metricSummary,
    metricSamplesByType: appMetricSamplesByType,
    jitterEvents: pingFocus.jitterEvents || [],
    highLatencyBursts: pingFocus.highLatencyBursts || [],
    systemAroundJitter,
    systemEventTimes,
    jitterPointTimes,
    referenceTs
  });

  return {
    windowSec,
    allowedPhases: [...allowedPhaseSet],
    degraded,
    selectedAnomalyCount: selectedAnomalyEvents.length,
    selectedMetricSampleCount: selectedMetricSamples.length,
    latencySummary: latencyWithDerived,
    jitterSummary: {
      count: jitterDeltaValues.length,
      p50DeltaMs: quantile(jitterDeltaValues, 0.5),
      p95DeltaMs: quantile(jitterDeltaValues, 0.95),
      maxDeltaMs: jitterDeltaValues.length ? jitterDeltaValues[jitterDeltaValues.length - 1] : null
    },
    metricSummary,
    appAnomalyAroundJitter,
    appAnomalyAroundHighLatency,
    systemAroundJitter,
    appMetricAroundJitter,
    findings: normalizedFindings,
    causeRanking,
    highLatencyBursts: (pingFocus.highLatencyBursts || []).slice(0, 24),
    jitterAlignmentRows
  };
}

function summarizePingFocus(pingFocus) {
  const successSamples = (pingFocus && pingFocus.samples ? pingFocus.samples : [])
    .filter((x) => x.success && Number.isFinite(x.latencyMs))
    .sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const latencySummary = summarizeValues(successSamples.map((x) => x.latencyMs));
  const burstCount = (pingFocus && pingFocus.highLatencyBursts ? pingFocus.highLatencyBursts.length : 0);
  const jitterCount = (pingFocus && pingFocus.jitterEvents ? pingFocus.jitterEvents.length : 0);
  return {
    sampleCount: pingFocus && Number.isFinite(pingFocus.sampleCount) ? pingFocus.sampleCount : 0,
    successCount: pingFocus && Number.isFinite(pingFocus.successCount) ? pingFocus.successCount : 0,
    failureCount: pingFocus && Number.isFinite(pingFocus.failureCount) ? pingFocus.failureCount : 0,
    highLatencyBurstCount: burstCount,
    jitterEventCount: jitterCount,
    p50Ms: latencySummary.p50,
    p95Ms: latencySummary.p95,
    maxMs: latencySummary.max,
    avgMs: latencySummary.avg
  };
}

function extractSampleEpochMs(pingFocus) {
  return (pingFocus && pingFocus.samples ? pingFocus.samples : [])
    .map((x) => (x && x.ts instanceof Date ? x.ts.getTime() : NaN))
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => a - b);
}

function computeSampleAlignmentStats(devicePingFocus, hostSidePingFocus, windowMs) {
  const deviceTimes = extractSampleEpochMs(devicePingFocus);
  const hostTimes = extractSampleEpochMs(hostSidePingFocus);
  if (!deviceTimes.length || !hostTimes.length) {
    return {
      windowMs,
      deviceSampleCount: deviceTimes.length,
      hostSideSampleCount: hostTimes.length,
      pairedCount: 0,
      deviceUnpairedCount: deviceTimes.length,
      hostSideUnpairedCount: hostTimes.length,
      deviceCoverage: 0,
      hostSideCoverage: 0,
      avgDeltaMs: null,
      p50AbsDeltaMs: null,
      p95AbsDeltaMs: null,
      maxAbsDeltaMs: null
    };
  }

  let i = 0;
  let j = 0;
  let pairedCount = 0;
  const deltas = [];
  const absDeltas = [];
  while (i < deviceTimes.length && j < hostTimes.length) {
    const deltaMs = hostTimes[j] - deviceTimes[i];
    const absDeltaMs = Math.abs(deltaMs);
    if (absDeltaMs <= windowMs) {
      pairedCount += 1;
      deltas.push(deltaMs);
      absDeltas.push(absDeltaMs);
      i += 1;
      j += 1;
      continue;
    }
    if (deviceTimes[i] < hostTimes[j]) i += 1;
    else j += 1;
  }

  const absSummary = summarizeValues(absDeltas);
  const avgDeltaMs = deltas.length
    ? (deltas.reduce((acc, v) => acc + v, 0) / deltas.length)
    : null;
  return {
    windowMs,
    deviceSampleCount: deviceTimes.length,
    hostSideSampleCount: hostTimes.length,
    pairedCount,
    deviceUnpairedCount: Math.max(0, deviceTimes.length - pairedCount),
    hostSideUnpairedCount: Math.max(0, hostTimes.length - pairedCount),
    deviceCoverage: deviceTimes.length ? (pairedCount / deviceTimes.length) : 0,
    hostSideCoverage: hostTimes.length ? (pairedCount / hostTimes.length) : 0,
    avgDeltaMs,
    p50AbsDeltaMs: absSummary.p50,
    p95AbsDeltaMs: absSummary.p95,
    maxAbsDeltaMs: absSummary.max
  };
}

function computeBurstOverlapStats(deviceBursts, hostSideBursts, windowMs) {
  const devicePoints = (deviceBursts || []).map((x) => x.startTs.getTime()).sort((a, b) => a - b);
  const hostPoints = (hostSideBursts || []).map((x) => x.startTs.getTime()).sort((a, b) => a - b);
  if (!devicePoints.length || !hostPoints.length) {
    return {
      overlapCount: 0,
      deviceHitRatio: 0,
      hostHitRatio: 0,
      overlapRatio: 0
    };
  }
  let overlapCount = 0;
  let deviceHit = 0;
  let hostHit = 0;

  for (const point of devicePoints) {
    const c = countInRange(hostPoints, point - windowMs, point + windowMs);
    if (c > 0) deviceHit += 1;
    overlapCount += c > 0 ? 1 : 0;
  }
  for (const point of hostPoints) {
    const c = countInRange(devicePoints, point - windowMs, point + windowMs);
    if (c > 0) hostHit += 1;
  }
  const deviceHitRatio = devicePoints.length ? (deviceHit / devicePoints.length) : 0;
  const hostHitRatio = hostPoints.length ? (hostHit / hostPoints.length) : 0;
  return {
    overlapCount,
    deviceHitRatio,
    hostHitRatio,
    overlapRatio: (deviceHitRatio + hostHitRatio) / 2
  };
}

function classifyBidirectionalDirection({
  deviceSummary,
  hostSummary,
  overlapRatio
}) {
  const deviceScore = (deviceSummary.p95Ms || 0) + (deviceSummary.maxMs || 0) * 0.4 + (deviceSummary.highLatencyBurstCount || 0) * 6;
  const hostScore = (hostSummary.p95Ms || 0) + (hostSummary.maxMs || 0) * 0.4 + (hostSummary.highLatencyBurstCount || 0) * 6;
  const strongerThreshold = 1.35;

  if ((deviceSummary.sampleCount || 0) === 0 && (hostSummary.sampleCount || 0) === 0) {
    return {
      direction: 'no_data',
      confidence: 'low',
      detail: '双端均无可用 ping 样本'
    };
  }

  if ((deviceSummary.highLatencyBurstCount || 0) > 0
    && (hostSummary.highLatencyBurstCount || 0) > 0
    && overlapRatio >= 0.4) {
    return {
      direction: 'bidirectional',
      confidence: overlapRatio >= 0.7 ? 'high' : 'medium',
      detail: `双端高延迟段同窗重叠率 ${(overlapRatio * 100).toFixed(1)}%`
    };
  }

  if (deviceScore > 0 && deviceScore >= hostScore * strongerThreshold) {
    return {
      direction: 'device_uplink_dominant',
      confidence: deviceScore >= hostScore * 1.7 ? 'high' : 'medium',
      detail: `设备侧抖动强度显著高于主机侧（score ${deviceScore.toFixed(2)} vs ${hostScore.toFixed(2)}）`
    };
  }

  if (hostScore > 0 && hostScore >= deviceScore * strongerThreshold) {
    return {
      direction: 'host_downlink_dominant',
      confidence: hostScore >= deviceScore * 1.7 ? 'high' : 'medium',
      detail: `主机侧抖动强度显著高于设备侧（score ${hostScore.toFixed(2)} vs ${deviceScore.toFixed(2)}）`
    };
  }

  if ((deviceSummary.highLatencyBurstCount || 0) > 0 || (hostSummary.highLatencyBurstCount || 0) > 0) {
    return {
      direction: 'mixed_or_path_specific',
      confidence: 'low',
      detail: '双端存在抖动，但同窗重叠不足以判定为双向同时抖动'
    };
  }

  return {
    direction: 'inconclusive',
    confidence: 'low',
    detail: '未出现显著高延迟段，无法形成方向性判定'
  };
}

export function buildBidirectionalPingAnalysis(devicePingFocus, hostSidePingFocus, {
  windowSec = 1,
  sampleAlignWindowMs = 250
} = {}) {
  const deviceBursts = (devicePingFocus && devicePingFocus.highLatencyBursts) || [];
  const hostBursts = (hostSidePingFocus && hostSidePingFocus.highLatencyBursts) || [];
  const overlapStats = computeBurstOverlapStats(deviceBursts, hostBursts, Math.round(windowSec * 1000));
  const deviceSummary = summarizePingFocus(devicePingFocus || {});
  const hostSummary = summarizePingFocus(hostSidePingFocus || {});
  const sampleAlignment = computeSampleAlignmentStats(devicePingFocus || {}, hostSidePingFocus || {}, Math.max(50, Math.round(sampleAlignWindowMs)));
  const classification = classifyBidirectionalDirection({
    deviceSummary,
    hostSummary,
    overlapRatio: overlapStats.overlapRatio
  });

  const findings = [];
  if ((deviceSummary.highLatencyBurstCount || 0) > 0 && (hostSummary.highLatencyBurstCount || 0) === 0) {
    findings.push({
      type: 'device_only_high_latency',
      level: 'medium',
      detail: '设备侧出现高延迟段，主机侧未出现对应高延迟段'
    });
  }
  if ((hostSummary.highLatencyBurstCount || 0) > 0 && (deviceSummary.highLatencyBurstCount || 0) === 0) {
    findings.push({
      type: 'host_only_high_latency',
      level: 'medium',
      detail: '主机侧出现高延迟段，设备侧未出现对应高延迟段'
    });
  }
  if (overlapStats.overlapRatio >= 0.4) {
    findings.push({
      type: 'bidirectional_overlap',
      level: overlapStats.overlapRatio >= 0.7 ? 'high' : 'medium',
      detail: `双端高延迟段重叠率 ${(overlapStats.overlapRatio * 100).toFixed(1)}%`
    });
  }
  if (
    sampleAlignment.pairedCount > 0
    && (sampleAlignment.deviceCoverage < 0.75 || sampleAlignment.hostSideCoverage < 0.75)
  ) {
    findings.push({
      type: 'sample_alignment_low_coverage',
      level: 'low',
      detail: `双端样本配对覆盖率偏低（device ${(sampleAlignment.deviceCoverage * 100).toFixed(1)}%, host ${(sampleAlignment.hostSideCoverage * 100).toFixed(1)}%）`
    });
  }

  return {
    windowSec,
    sampleAlignWindowMs: sampleAlignment.windowMs,
    device: deviceSummary,
    hostSide: hostSummary,
    sampleAlignment,
    overlap: overlapStats,
    classification,
    findings
  };
}
