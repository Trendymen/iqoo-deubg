import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { parseReportArgs, printReportHelp } from './cli.js';
import { resolveLogDir, buildReportFiles } from './files.js';
import { createEventStore } from './event-store.js';
import { parseLogcatFile } from './logcat-parser.js';
import { parseAppFocusLog } from './app-focus-parser.js';
import { parsePingHostLog } from './ping-parser.js';
import { addDeviceIdleTransitions, addPowerTransitions } from './transition-parser.js';
import { addWifiTransitions, addAlarmTransitions, addJobsTransitions, addConnectivityTransitions } from './dumpsys-event-parser.js';
import { buildContexts } from './context-extractor.js';
import {
  buildTimeline,
  buildIntervals,
  buildEventCount,
  pickTopPeriodicEvents,
  buildAlignment,
  buildAppFocusAnalysis,
  buildPingAppAnalysis,
  buildBidirectionalPingAnalysis
} from './analyzer.js';
import {
  detectStreamingPhases,
  buildStreamWindowRows,
  buildEffectiveWindows,
  buildEffectiveWindowRows,
  isTsInWindows
} from './stream-phase-detector.js';
import { buildMarkdownReport } from './report-builder.js';
import { readJsonIfExists, fileExists, writeJson } from '../shared/io.js';
import { formatTs, parseIsoDateSafe } from '../shared/time.js';
import { toCsv } from '../shared/csv.js';

function quantileSorted(sorted, q) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower];
  const weight = pos - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function summarizeNumeric(values) {
  const valid = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!valid.length) {
    return {
      count: 0,
      min: null,
      p50: null,
      p95: null,
      max: null,
      avg: null
    };
  }
  const sum = valid.reduce((acc, v) => acc + v, 0);
  return {
    count: valid.length,
    min: valid[0],
    p50: quantileSorted(valid, 0.5),
    p95: quantileSorted(valid, 0.95),
    max: valid[valid.length - 1],
    avg: sum / valid.length
  };
}

function summarizeInternalStats(samples) {
  const metricFieldPairs = [
    ['fps_total', 'fpsTotal'],
    ['fps_rx', 'fpsRx'],
    ['fps_rd', 'fpsRd'],
    ['loss_frames', 'lossFrames'],
    ['loss_total', 'lossTotal'],
    ['loss_pct', 'lossPct'],
    ['loss_events', 'lossEvents'],
    ['rtt_ms', 'rttMs'],
    ['rtt_var_ms', 'rttVarMs'],
    ['decode_ms', 'decodeMs'],
    ['render_ms', 'renderMs'],
    ['total_ms', 'totalMs'],
    ['host_latency_min_ms', 'hostLatencyMinMs'],
    ['host_latency_max_ms', 'hostLatencyMaxMs'],
    ['host_latency_avg_ms', 'hostLatencyAvgMs']
  ];
  const metrics = {};
  for (const [metricName, fieldName] of metricFieldPairs) {
    metrics[metricName] = summarizeNumeric(samples.map((x) => x[fieldName]));
  }
  return metrics;
}

function buildEventsByType(events) {
  const map = new Map();
  for (const e of (events || [])) {
    if (!map.has(e.type)) map.set(e.type, []);
    map.get(e.type).push(e.ts);
  }
  for (const [k, arr] of map.entries()) {
    arr.sort((a, b) => a.getTime() - b.getTime());
    map.set(k, arr);
  }
  return map;
}

function filterEventsByWindows(events, windows) {
  if (!windows || !windows.length) return [];
  return (events || []).filter((e) => isTsInWindows(e.ts, windows));
}

function filterWakelockMinuteHitsByWindows(map, windows) {
  if (!map || !windows || !windows.length) return new Map();
  const out = new Map();
  for (const [minuteKey, count] of map.entries()) {
    const ts = new Date(`${minuteKey.replace(' ', 'T')}:00`);
    if (!Number.isFinite(ts.getTime())) continue;
    if (isTsInWindows(ts, windows)) out.set(minuteKey, count);
  }
  return out;
}

function filterAppFocusBySession(appFocus) {
  const metricSamples = (appFocus.metricSamples || []).filter((x) => x.inSession);
  const internalStatsSamples = (appFocus.internalStatsSamples || []).filter((x) => x.inSession);
  const anomalyEvents = (appFocus.anomalyEvents || []).filter((x) => x.inSession);
  return {
    ...appFocus,
    metricSamples,
    internalStatsSamples,
    anomalyEvents
  };
}

function buildSessionPingFocus(pingFocus) {
  const sessionSamples = pingFocus.sessionSamples || [];
  return {
    ...pingFocus,
    summary: {
      transmitted: null,
      received: null,
      packetLossPct: null,
      reportedRtt: null
    },
    sampleCount: sessionSamples.length,
    successCount: pingFocus.sessionSuccessCount || 0,
    failureCount: pingFocus.sessionFailureCount || 0,
    firstTs: sessionSamples.length ? sessionSamples[0].ts : null,
    lastTs: sessionSamples.length ? sessionSamples[sessionSamples.length - 1].ts : null,
    samples: sessionSamples,
    highLatencyEvents: pingFocus.sessionHighLatencyEvents || [],
    highLatencyBursts: pingFocus.sessionHighLatencyBursts || [],
    jitterEvents: pingFocus.sessionJitterEvents || []
  };
}

function buildEmptyAppAnalysis() {
  return {
    windowSec: 60,
    allowedPhases: [],
    selectedAnomalyCount: 0,
    selectedMetricSampleCount: 0,
    metricSummary: {},
    anomalyTransitionPrePost: {},
    appAnomalyBySystemEvent: {},
    metricTransitionWindow: {}
  };
}

function buildEmptyPingAnalysis() {
  return {
    windowSec: 1,
    allowedPhases: [],
    degraded: true,
    selectedAnomalyCount: 0,
    selectedMetricSampleCount: 0,
    latencySummary: {
      count: 0,
      min: null,
      p50: null,
      p95: null,
      max: null,
      avg: null,
      successCount: 0,
      failureCount: 0,
      transmitted: 0,
      received: 0,
      lossRatePct: 0,
      highLatencyThresholdMs: null,
      highLatencyBurstCount: 0,
      highLatencyEventCount: 0
    },
    jitterSummary: {
      count: 0,
      p50DeltaMs: null,
      p95DeltaMs: null,
      maxDeltaMs: null
    },
    metricSummary: {},
    appAnomalyAroundJitter: {},
    appAnomalyAroundHighLatency: {},
    systemAroundJitter: {},
    appMetricAroundJitter: {},
    findings: [],
    causeRanking: [],
    highLatencyBursts: [],
    jitterAlignmentRows: []
  };
}

function subtractEventCount(allCount, sessionCount) {
  const keys = new Set([...Object.keys(allCount || {}), ...Object.keys(sessionCount || {})]);
  const out = {};
  for (const k of keys) {
    out[k] = Math.max(0, (allCount[k] || 0) - (sessionCount[k] || 0));
  }
  return out;
}

export async function runReportFromCli(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseReportArgs(argv);
  } catch (err) {
    if (err instanceof ZodError) {
      console.error('[report] 参数错误:', err.issues.map((x) => x.message).join('; '));
      printReportHelp();
      process.exit(1);
      return;
    }
    throw err;
  }

  let logDir;
  try {
    logDir = resolveLogDir(args, path.resolve('./logs'));
  } catch (err) {
    console.error('[report]', err.message);
    process.exit(1);
    return;
  }

  const files = buildReportFiles(logDir);
  if (!fileExists(files.logcat)) {
    console.error(`[report] 缺少必需文件: ${files.logcat}`);
    process.exit(1);
    return;
  }

  const captureMeta = readJsonIfExists(files.captureMeta);
  const captureStartTs = parseIsoDateSafe(captureMeta && captureMeta.startedAtIso);
  const pingIntervalSec = Number((captureMeta && captureMeta.hostPing && captureMeta.hostPing.intervalSec) || 0.2);
  const hostSidePingIntervalSec = Number((captureMeta && captureMeta.hostSidePing && captureMeta.hostSidePing.intervalSec) || 0.2);
  const streamDetection = await detectStreamingPhases(files.logcat, new Date().getFullYear(), {
    mode: args.streamWindowMode
  });

  const store = createEventStore();
  const logcatStats = await parseLogcatFile(files.logcat, store, new Date().getFullYear());

  const startTs = parseIsoDateSafe(captureMeta && captureMeta.startedAtIso) || logcatStats.firstTs;
  const endTs = parseIsoDateSafe(captureMeta && captureMeta.endedAtIso) || logcatStats.lastTs || startTs;
  if (!startTs || !endTs) {
    console.error('[report] 无法确定时间范围，日志可能为空。');
    process.exit(1);
    return;
  }

  streamDetection.effectiveWindows = buildEffectiveWindows(streamDetection.validWindows || [], {
    preBufferSec: args.sessionPreBufferSec,
    postBufferSec: args.sessionPostBufferSec,
    clockSkewToleranceSec: args.clockSkewToleranceSec,
    minTs: startTs,
    maxTs: endTs
  });

  const appFocus = await parseAppFocusLog(files.logcat, new Date().getFullYear(), {
    streamDetection,
    noisePolicy: args.noisePolicy
  });
  const pingFocus = await parsePingHostLog(files.pingHost, {
    captureStartTs,
    intervalSec: pingIntervalSec,
    streamDetection
  });
  const hostSidePingFocus = await parsePingHostLog(files.pingHostSide, {
    captureStartTs,
    intervalSec: hostSidePingIntervalSec,
    streamDetection
  });

  await addDeviceIdleTransitions(files.deviceidle, store);
  await addPowerTransitions(files.power, store);
  await addConnectivityTransitions(files.conn, store);
  await addWifiTransitions(files.wifi, store);
  await addAlarmTransitions(files.alarm, store);
  await addJobsTransitions(files.jobs, store);
  store.sortAll();

  const missingOptional = [];
  ['wifi', 'conn', 'deviceidle', 'power', 'alarm', 'jobs'].forEach((k) => {
    if (!fs.existsSync(files[k])) missingOptional.push(path.basename(files[k]));
  });

  const eventsAll = store.events.slice();
  const eventsSession = filterEventsByWindows(eventsAll, streamDetection.effectiveWindows);
  const eventsByTypeAll = store.eventsByType;
  const eventsByTypeSession = buildEventsByType(eventsSession);

  const wakelockMinuteHitsSession = filterWakelockMinuteHitsByWindows(logcatStats.wakelockMinuteHits, streamDetection.effectiveWindows);
  const timelineAll = buildTimeline({
    startTs,
    endTs,
    events: eventsAll,
    wakelockMinuteHits: logcatStats.wakelockMinuteHits
  });
  fs.writeFileSync(files.timelineCsv, timelineAll.csv);

  const timelineSession = buildTimeline({
    startTs,
    endTs,
    events: eventsSession,
    wakelockMinuteHits: wakelockMinuteHitsSession
  });
  fs.writeFileSync(files.timelineSessionCsv, timelineSession.csv);

  const intervalsAll = buildIntervals(eventsByTypeAll);
  fs.writeFileSync(files.intervalsCsv, intervalsAll.csv);
  const intervalsSession = buildIntervals(eventsByTypeSession);
  fs.writeFileSync(files.intervalsSessionCsv, intervalsSession.csv);

  const appLogContent = appFocus.extractedLines.length ? `${appFocus.extractedLines.join('\n')}\n` : '';
  fs.writeFileSync(files.appFocusLog, appLogContent);

  const appMetricsRows = appFocus.metricSamples.map((x) => ({
    ts: formatTs(x.ts),
    metric: x.type,
    value: x.value,
    unit: x.unit || '',
    line: (x.line || '').slice(0, 320),
    phase: x.phase || '',
    in_session: x.inSession ? 'true' : 'false',
    metric_source: x.metricSource || 'legacy_pattern',
    confidence: x.confidence == null ? '' : x.confidence.toFixed(2)
  }));
  fs.writeFileSync(files.appMetricsCsv, toCsv(appMetricsRows, ['ts', 'metric', 'value', 'unit', 'line', 'phase', 'in_session', 'metric_source', 'confidence']));

  const internalStatsRows = appFocus.internalStatsSamples.map((x) => ({
    ts: formatTs(x.ts),
    decoder: x.decoder || '',
    hdr: x.hdr || '',
    fps_total: x.fpsTotal == null ? '' : x.fpsTotal,
    fps_rx: x.fpsRx == null ? '' : x.fpsRx,
    fps_rd: x.fpsRd == null ? '' : x.fpsRd,
    loss_frames: x.lossFrames == null ? '' : x.lossFrames,
    loss_total: x.lossTotal == null ? '' : x.lossTotal,
    loss_pct: x.lossPct == null ? '' : x.lossPct,
    loss_events: x.lossEvents == null ? '' : x.lossEvents,
    rtt_ms: x.rttMs == null ? '' : x.rttMs,
    rtt_var_ms: x.rttVarMs == null ? '' : x.rttVarMs,
    decode_ms: x.decodeMs == null ? '' : x.decodeMs,
    render_ms: x.renderMs == null ? '' : x.renderMs,
    total_ms: x.totalMs == null ? '' : x.totalMs,
    host_latency_min_ms: x.hostLatencyMinMs == null ? '' : x.hostLatencyMinMs,
    host_latency_max_ms: x.hostLatencyMaxMs == null ? '' : x.hostLatencyMaxMs,
    host_latency_avg_ms: x.hostLatencyAvgMs == null ? '' : x.hostLatencyAvgMs,
    phase: x.phase || '',
    in_session: x.inSession ? 'true' : 'false',
    confidence: x.confidence == null ? '' : x.confidence.toFixed(2),
    line: (x.line || '').slice(0, 320)
  }));
  fs.writeFileSync(files.internalStatsCsv, toCsv(internalStatsRows, [
    'ts', 'decoder', 'hdr', 'fps_total', 'fps_rx', 'fps_rd', 'loss_frames', 'loss_total', 'loss_pct', 'loss_events',
    'rtt_ms', 'rtt_var_ms', 'decode_ms', 'render_ms', 'total_ms',
    'host_latency_min_ms', 'host_latency_max_ms', 'host_latency_avg_ms',
    'phase', 'in_session', 'confidence', 'line'
  ]));

  const streamWindowRows = buildStreamWindowRows(streamDetection);
  fs.writeFileSync(files.streamWindowsCsv, toCsv(streamWindowRows, [
    'id', 'start_ts', 'end_ts', 'duration_ms', 'valid', 'confidence', 'score',
    'has_strong_start', 'has_start_marker', 'has_end_marker',
    'start_marker_count', 'end_marker_count', 'activity_count'
  ]));
  const effectiveWindowRows = buildEffectiveWindowRows(streamDetection.effectiveWindows);
  fs.writeFileSync(files.streamWindowsEffectiveCsv, toCsv(effectiveWindowRows, [
    'id', 'start_ts', 'end_ts', 'duration_ms'
  ]));

  const pingSamplesRows = pingFocus.samples.map((x) => ({
    ts: formatTs(x.ts),
    seq: x.seq == null ? '' : x.seq,
    status: x.status,
    latency_ms: x.latencyMs == null ? '' : x.latencyMs,
    phase: x.phase || '',
    in_session: x.inSession ? 'true' : 'false',
    ts_source: x.tsSource || '',
    line: (x.line || '').slice(0, 320)
  }));
  fs.writeFileSync(files.pingLatencyCsv, toCsv(pingSamplesRows, ['ts', 'seq', 'status', 'latency_ms', 'phase', 'in_session', 'ts_source', 'line']));
  const pingSessionRows = (pingFocus.sessionSamples || []).map((x) => ({
    ts: formatTs(x.ts),
    seq: x.seq == null ? '' : x.seq,
    status: x.status,
    latency_ms: x.latencyMs == null ? '' : x.latencyMs,
    phase: x.phase || '',
    in_session: x.inSession ? 'true' : 'false',
    ts_source: x.tsSource || '',
    line: (x.line || '').slice(0, 320)
  }));
  fs.writeFileSync(files.pingLatencySessionCsv, toCsv(pingSessionRows, ['ts', 'seq', 'status', 'latency_ms', 'phase', 'in_session', 'ts_source', 'line']));
  const hostSidePingRows = hostSidePingFocus.samples.map((x) => ({
    ts: formatTs(x.ts),
    seq: x.seq == null ? '' : x.seq,
    status: x.status,
    latency_ms: x.latencyMs == null ? '' : x.latencyMs,
    phase: x.phase || '',
    in_session: x.inSession ? 'true' : 'false',
    ts_source: x.tsSource || '',
    line: (x.line || '').slice(0, 320)
  }));
  fs.writeFileSync(files.pingLatencyHostSideCsv, toCsv(hostSidePingRows, ['ts', 'seq', 'status', 'latency_ms', 'phase', 'in_session', 'ts_source', 'line']));
  const hostSidePingSessionRows = (hostSidePingFocus.sessionSamples || []).map((x) => ({
    ts: formatTs(x.ts),
    seq: x.seq == null ? '' : x.seq,
    status: x.status,
    latency_ms: x.latencyMs == null ? '' : x.latencyMs,
    phase: x.phase || '',
    in_session: x.inSession ? 'true' : 'false',
    ts_source: x.tsSource || '',
    line: (x.line || '').slice(0, 320)
  }));
  fs.writeFileSync(files.pingLatencyHostSideSessionCsv, toCsv(hostSidePingSessionRows, ['ts', 'seq', 'status', 'latency_ms', 'phase', 'in_session', 'ts_source', 'line']));

  const noValidSessionReason = streamDetection.detected
    ? (streamDetection.effectiveWindows.length ? null : 'no_effective_windows')
    : (streamDetection.reason || 'no_valid_window');
  const mainAnalysisAvailable = streamDetection.detected && streamDetection.effectiveWindows.length > 0;
  const useDegradedFallback = !mainAnalysisAvailable && args.noValidSessionPolicy === 'degraded';

  const appFocusSession = filterAppFocusBySession(appFocus);
  const pingFocusSession = buildSessionPingFocus(pingFocus);
  const hostSidePingFocusSession = buildSessionPingFocus(hostSidePingFocus);
  const allPhases = ['stream', 'preconnect', 'post', 'unknown'];
  const legacyAnalysisPhases = args.streamWindowMode === 'all'
    ? allPhases
    : (streamDetection.detected ? ['stream'] : (args.streamWindowMode === 'strict' ? ['stream'] : ['preconnect']));

  const eventsMain = mainAnalysisAvailable ? eventsSession : (useDegradedFallback ? eventsAll : []);
  const eventsByTypeMain = mainAnalysisAvailable ? eventsByTypeSession : (useDegradedFallback ? eventsByTypeAll : buildEventsByType([]));
  const appFocusMain = mainAnalysisAvailable ? appFocusSession : (useDegradedFallback ? appFocus : {
    ...appFocus,
    metricSamples: [],
    internalStatsSamples: [],
    anomalyEvents: []
  });
  const pingFocusMain = mainAnalysisAvailable ? pingFocusSession : (useDegradedFallback ? pingFocus : {
    ...pingFocus,
    sampleCount: 0,
    successCount: 0,
    failureCount: 0,
    samples: [],
    highLatencyEvents: [],
    highLatencyBursts: [],
    jitterEvents: []
  });
  const hostSidePingFocusMain = mainAnalysisAvailable ? hostSidePingFocusSession : (useDegradedFallback ? hostSidePingFocus : {
    ...hostSidePingFocus,
    sampleCount: 0,
    successCount: 0,
    failureCount: 0,
    samples: [],
    highLatencyEvents: [],
    highLatencyBursts: [],
    jitterEvents: []
  });
  const analysisPhasesMain = mainAnalysisAvailable ? allPhases : (useDegradedFallback ? legacyAnalysisPhases : []);
  const degradedAnalysis = useDegradedFallback;

  const appAnalysis = (mainAnalysisAvailable || useDegradedFallback)
    ? buildAppFocusAnalysis(appFocusMain, eventsByTypeMain, {
      windowSec: 60,
      allowedPhases: analysisPhasesMain
    })
    : buildEmptyAppAnalysis();
  const sampleAlignWindowMs = Math.max(120, Math.round(Math.max(pingIntervalSec, hostSidePingIntervalSec) * 1000 * 1.5));
  const pingAnalysis = (mainAnalysisAvailable || useDegradedFallback)
    ? buildPingAppAnalysis(pingFocusMain, appFocusMain, eventsByTypeMain, {
      windowSec: 1,
      allowedPhases: analysisPhasesMain,
      degraded: degradedAnalysis
    })
    : buildEmptyPingAnalysis();
  const bidirectionalPingAnalysis = (mainAnalysisAvailable || useDegradedFallback)
    ? buildBidirectionalPingAnalysis(pingFocusMain, hostSidePingFocusMain, {
      windowSec: 1,
      sampleAlignWindowMs
    })
    : buildBidirectionalPingAnalysis({
      sampleCount: 0,
      successCount: 0,
      failureCount: 0,
      samples: [],
      highLatencyBursts: [],
      jitterEvents: []
    }, {
      sampleCount: 0,
      successCount: 0,
      failureCount: 0,
      samples: [],
      highLatencyBursts: [],
      jitterEvents: []
    }, {
      windowSec: 1,
      sampleAlignWindowMs
    });

  const top3 = (mainAnalysisAvailable || useDegradedFallback)
    ? pickTopPeriodicEvents(eventsByTypeMain, mainAnalysisAvailable ? intervalsSession.periodicityByType : intervalsAll.periodicityByType)
    : [];
  const alignment = buildAlignment(eventsMain, eventsByTypeMain);
  const eventCountAll = buildEventCount(eventsAll);
  const eventCountSession = buildEventCount(eventsSession);
  const eventCountOutside = subtractEventCount(eventCountAll, eventCountSession);
  const eventCountMain = buildEventCount(eventsMain);
  const topTypeSet = new Set(top3.map((x) => x.type));
  const topEventsForContext = eventsMain.filter((e) => topTypeSet.has(e.type));
  const contexts = topEventsForContext.length
    ? await buildContexts(files.logcat, topEventsForContext, new Date().getFullYear())
    : [];

  const reportMarkdown = buildMarkdownReport({
    logDir,
    startTs,
    endTs,
    logcatLineCount: logcatStats.lineCount,
    events: eventsMain,
    eventCount: eventCountMain,
    eventCountAll,
    eventCountSession,
    eventCountOutside,
    top3,
    intervalStats: mainAnalysisAvailable ? intervalsSession.intervalStats : intervalsAll.intervalStats,
    intervalStatsAll: intervalsAll.intervalStats,
    intervalStatsSession: intervalsSession.intervalStats,
    alignment,
    topEventsForContext,
    contexts,
    clues: logcatStats.clues,
    filterStats: {
      filteredLineCount: logcatStats.filteredLineCount,
      filteredByReason: logcatStats.filteredByReason
    },
    appFocus: appFocusMain,
    appFocusAll: appFocus,
    appAnalysis,
    streamDetection,
    analysisPhases: analysisPhasesMain,
    degradedAnalysis,
    pingFocus: pingFocusMain,
    pingFocusAll: pingFocus,
    hostSidePingFocus: hostSidePingFocusMain,
    hostSidePingFocusAll: hostSidePingFocus,
    pingAnalysis,
    bidirectionalPingAnalysis,
    mainAnalysisAvailable,
    noValidSessionReason,
    noValidSessionPolicy: args.noValidSessionPolicy,
    noiseReduction: {
      appMatchedLineCount: appFocus.matchedLineCount,
      appKeptLineCount: appFocus.keptLineCount,
      appDroppedLineCount: appFocus.droppedLineCount,
      appDroppedByReason: appFocus.droppedByReason,
      logcatFilteredByReason: logcatStats.filteredByReason
    },
    outputFiles: {
      appFocusLog: files.appFocusLog,
      appMetricsCsv: files.appMetricsCsv,
      internalStatsCsv: files.internalStatsCsv,
      streamWindowsCsv: files.streamWindowsCsv,
      streamWindowsEffectiveCsv: files.streamWindowsEffectiveCsv,
      pingHostLog: files.pingHost,
      pingLatencyCsv: files.pingLatencyCsv,
      pingLatencySessionCsv: files.pingLatencySessionCsv,
      pingHostSideLog: files.pingHostSide,
      pingLatencyHostSideCsv: files.pingLatencyHostSideCsv,
      pingLatencyHostSideSessionCsv: files.pingLatencyHostSideSessionCsv,
      timelineCsv: files.timelineCsv,
      timelineSessionCsv: files.timelineSessionCsv,
      intervalsCsv: files.intervalsCsv,
      intervalsSessionCsv: files.intervalsSessionCsv
    },
    missingOptional,
    wakelockStats: {
      all: timelineAll.wakelockStats,
      session: timelineSession.wakelockStats
    },
    captureMeta
  });
  fs.writeFileSync(files.reportMd, reportMarkdown);

  const analysisMeta = {
    version: 8,
    logDir,
    generatedAtIso: new Date().toISOString(),
    counts: {
      eventsTotal: eventsMain.length,
      eventsTotalAll: eventsAll.length,
      eventsTotalSession: eventsSession.length,
      logcatLineCount: logcatStats.lineCount,
      filteredLogcatLineCount: logcatStats.filteredLineCount,
      eventCount: eventCountMain,
      eventCountAll,
      eventCountSession,
      eventCountOutside,
      appMatchedLineCount: appFocus.matchedLineCount,
      appKeptLineCount: appFocus.keptLineCount,
      appDroppedLineCount: appFocus.droppedLineCount,
      appAnomalyCount: appFocusMain.anomalyEvents.length,
      appMetricSampleCount: appFocusMain.metricSamples.length,
      appInternalStatsSampleCount: appFocusMain.internalStatsSamples.length,
      appSessionMetricCount: appFocusSession.metricSamples.length,
      pingSampleCount: pingFocusMain.sampleCount,
      pingSuccessCount: pingFocusMain.successCount,
      pingFailureCount: pingFocusMain.failureCount,
      pingSessionSampleCount: pingFocusSession.sampleCount,
      hostSidePingSampleCount: hostSidePingFocusMain.sampleCount,
      hostSidePingSuccessCount: hostSidePingFocusMain.successCount,
      hostSidePingFailureCount: hostSidePingFocusMain.failureCount,
      hostSidePingSessionSampleCount: hostSidePingFocusSession.sampleCount,
      bidirectionalPairedSampleCount: (bidirectionalPingAnalysis.sampleAlignment && bidirectionalPingAnalysis.sampleAlignment.pairedCount) || 0,
      bidirectionalSampleAlignWindowMs: bidirectionalPingAnalysis.sampleAlignWindowMs || 0,
      bidirectionalDevicePairCoverage: (bidirectionalPingAnalysis.sampleAlignment && bidirectionalPingAnalysis.sampleAlignment.deviceCoverage) || 0,
      bidirectionalHostPairCoverage: (bidirectionalPingAnalysis.sampleAlignment && bidirectionalPingAnalysis.sampleAlignment.hostSideCoverage) || 0
    },
    session: {
      policy: args.noValidSessionPolicy,
      mainAnalysisAvailable,
      noValidReason: noValidSessionReason,
      bufferSec: {
        pre: args.sessionPreBufferSec,
        post: args.sessionPostBufferSec,
        clockSkewTolerance: args.clockSkewToleranceSec
      },
      effectiveWindowCount: streamDetection.effectiveWindows.length,
      effectiveWindows: streamDetection.effectiveWindows.map((w) => ({
        id: w.id,
        startTs: w.startTs.toISOString(),
        endTs: w.endTs.toISOString(),
        durationMs: Math.max(0, w.endTs.getTime() - w.startTs.getTime())
      }))
    },
    filterStats: {
      filteredByReason: logcatStats.filteredByReason
    },
    intervalStats: mainAnalysisAvailable ? intervalsSession.intervalStats : intervalsAll.intervalStats,
    intervalStatsAll: intervalsAll.intervalStats,
    intervalStatsSession: intervalsSession.intervalStats,
    top3,
    alignment,
    streaming: {
      mode: args.streamWindowMode,
      detected: streamDetection.detected,
      degraded: degradedAnalysis,
      reason: streamDetection.reason,
      analysisPhases: analysisPhasesMain,
      markerCounts: streamDetection.markerCounts,
      windows: streamDetection.windows.map((w) => ({
        id: w.id,
        startTs: w.startTs.toISOString(),
        endTs: w.endTs.toISOString(),
        durationMs: Math.max(0, w.endTs.getTime() - w.startTs.getTime()),
        valid: w.valid,
        confidence: w.confidence,
        score: w.score
      })),
      effectiveWindows: streamDetection.effectiveWindows.map((w) => ({
        id: w.id,
        startTs: w.startTs.toISOString(),
        endTs: w.endTs.toISOString(),
        durationMs: Math.max(0, w.endTs.getTime() - w.startTs.getTime())
      }))
    },
    appFocus: {
      firstTs: appFocus.firstTs ? appFocus.firstTs.toISOString() : null,
      lastTs: appFocus.lastTs ? appFocus.lastTs.toISOString() : null,
      keptLineCount: appFocus.keptLineCount,
      droppedLineCount: appFocus.droppedLineCount,
      droppedByReason: appFocus.droppedByReason,
      phaseCounts: appFocus.phaseCounts,
      priorityCounts: appFocus.priorityCounts,
      tagCounts: appFocus.tagCounts,
      keywordCounts: appFocus.keywordCounts,
      metricSourceCounts: appFocus.metricSourceCounts
    },
    internalStats: {
      sampleCount: appFocusMain.internalStatsSamples.length,
      firstTs: appFocusMain.internalStatsSamples.length ? appFocusMain.internalStatsSamples[0].ts.toISOString() : null,
      lastTs: appFocusMain.internalStatsSamples.length ? appFocusMain.internalStatsSamples[appFocusMain.internalStatsSamples.length - 1].ts.toISOString() : null,
      metricSummary: summarizeInternalStats(appFocusMain.internalStatsSamples)
    },
    noiseReduction: {
      noisePolicy: args.noisePolicy,
      appLineCountBefore: appFocus.matchedLineCount,
      appLineCountAfter: appFocus.keptLineCount,
      appDroppedLineCount: appFocus.droppedLineCount,
      appDroppedByReason: appFocus.droppedByReason,
      logcatFilteredByReason: logcatStats.filteredByReason
    },
    appAnalysis,
    pingFocus: {
      exists: pingFocus.exists,
      firstTs: pingFocus.firstTs ? pingFocus.firstTs.toISOString() : null,
      lastTs: pingFocus.lastTs ? pingFocus.lastTs.toISOString() : null,
      tsSourceCounts: pingFocus.tsSourceCounts,
      phaseCounts: pingFocus.phaseCounts,
      summary: pingFocus.summary,
      highLatencyThresholdMs: pingFocus.highLatencyThresholdMs
    },
    hostSidePingFocus: {
      exists: hostSidePingFocus.exists,
      firstTs: hostSidePingFocus.firstTs ? hostSidePingFocus.firstTs.toISOString() : null,
      lastTs: hostSidePingFocus.lastTs ? hostSidePingFocus.lastTs.toISOString() : null,
      tsSourceCounts: hostSidePingFocus.tsSourceCounts,
      phaseCounts: hostSidePingFocus.phaseCounts,
      summary: hostSidePingFocus.summary,
      highLatencyThresholdMs: hostSidePingFocus.highLatencyThresholdMs
    },
    pingAnalysis,
    bidirectionalPingAnalysis,
    causeRanking: pingAnalysis.causeRanking || [],
    outputFiles: {
      appFocusLog: files.appFocusLog,
      appMetricsCsv: files.appMetricsCsv,
      internalStatsCsv: files.internalStatsCsv,
      streamWindowsCsv: files.streamWindowsCsv,
      streamWindowsEffectiveCsv: files.streamWindowsEffectiveCsv,
      pingHostLog: files.pingHost,
      pingLatencyCsv: files.pingLatencyCsv,
      pingLatencySessionCsv: files.pingLatencySessionCsv,
      pingHostSideLog: files.pingHostSide,
      pingLatencyHostSideCsv: files.pingLatencyHostSideCsv,
      pingLatencyHostSideSessionCsv: files.pingLatencyHostSideSessionCsv,
      timelineCsv: files.timelineCsv,
      timelineSessionCsv: files.timelineSessionCsv,
      intervalsCsv: files.intervalsCsv,
      intervalsSessionCsv: files.intervalsSessionCsv
    },
    missingOptional
  };
  writeJson(files.analysisMeta, analysisMeta);

  console.log('[report] 生成完成:');
  console.log(`  - ${files.timelineCsv}`);
  console.log(`  - ${files.timelineSessionCsv}`);
  console.log(`  - ${files.intervalsCsv}`);
  console.log(`  - ${files.intervalsSessionCsv}`);
  console.log(`  - ${files.appFocusLog}`);
  console.log(`  - ${files.appMetricsCsv}`);
  console.log(`  - ${files.internalStatsCsv}`);
  console.log(`  - ${files.streamWindowsCsv}`);
  console.log(`  - ${files.streamWindowsEffectiveCsv}`);
  console.log(`  - ${files.pingLatencyCsv}`);
  console.log(`  - ${files.pingLatencySessionCsv}`);
  console.log(`  - ${files.pingLatencyHostSideCsv}`);
  console.log(`  - ${files.pingLatencyHostSideSessionCsv}`);
  console.log(`  - ${files.reportMd}`);
  console.log(`  - ${files.analysisMeta}`);
}
