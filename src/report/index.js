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
import { addWifiTransitions, addAlarmTransitions, addJobsTransitions } from './dumpsys-event-parser.js';
import { buildContexts } from './context-extractor.js';
import { buildTimeline, buildIntervals, buildEventCount, pickTopPeriodicEvents, buildAlignment, buildAppFocusAnalysis, buildPingAppAnalysis } from './analyzer.js';
import { detectStreamingPhases, buildStreamWindowRows } from './stream-phase-detector.js';
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
  const streamDetection = await detectStreamingPhases(files.logcat, new Date().getFullYear(), {
    mode: args.streamWindowMode
  });

  const store = createEventStore();
  const logcatStats = await parseLogcatFile(files.logcat, store, new Date().getFullYear());
  const appFocus = await parseAppFocusLog(files.logcat, new Date().getFullYear(), {
    streamDetection,
    noisePolicy: args.noisePolicy
  });
  const pingFocus = await parsePingHostLog(files.pingHost, {
    captureStartTs,
    intervalSec: pingIntervalSec
  });

  await addDeviceIdleTransitions(files.deviceidle, store);
  await addPowerTransitions(files.power, store);
  await addWifiTransitions(files.wifi, store);
  await addAlarmTransitions(files.alarm, store);
  await addJobsTransitions(files.jobs, store);
  store.sortAll();

  const startTs = parseIsoDateSafe(captureMeta && captureMeta.startedAtIso) || logcatStats.firstTs;
  const endTs = parseIsoDateSafe(captureMeta && captureMeta.endedAtIso) || logcatStats.lastTs || startTs;
  if (!startTs || !endTs) {
    console.error('[report] 无法确定时间范围，日志可能为空。');
    process.exit(1);
    return;
  }

  const missingOptional = [];
  ['wifi', 'conn', 'deviceidle', 'power', 'alarm', 'jobs'].forEach((k) => {
    if (!fs.existsSync(files[k])) missingOptional.push(path.basename(files[k]));
  });

  const timeline = buildTimeline({
    startTs,
    endTs,
    events: store.events,
    wakelockMinuteHits: logcatStats.wakelockMinuteHits
  });
  fs.writeFileSync(files.timelineCsv, timeline.csv);

  const intervals = buildIntervals(store.eventsByType);
  fs.writeFileSync(files.intervalsCsv, intervals.csv);

  const appLogContent = appFocus.extractedLines.length ? `${appFocus.extractedLines.join('\n')}\n` : '';
  fs.writeFileSync(files.appFocusLog, appLogContent);

  const allPhases = ['stream', 'preconnect', 'post', 'unknown'];
  const analysisPhases = args.streamWindowMode === 'all'
    ? allPhases
    : (streamDetection.detected ? ['stream'] : (args.streamWindowMode === 'strict' ? ['stream'] : ['preconnect']));
  const degradedAnalysis = args.streamWindowMode !== 'all' && !streamDetection.detected;

  const appMetricsRows = appFocus.metricSamples.map((x) => ({
    ts: formatTs(x.ts),
    metric: x.type,
    value: x.value,
    unit: x.unit || '',
    line: (x.line || '').slice(0, 320),
    phase: x.phase || '',
    metric_source: x.metricSource || 'legacy_pattern',
    confidence: x.confidence == null ? '' : x.confidence.toFixed(2)
  }));
  fs.writeFileSync(files.appMetricsCsv, toCsv(appMetricsRows, ['ts', 'metric', 'value', 'unit', 'line', 'phase', 'metric_source', 'confidence']));

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
    confidence: x.confidence == null ? '' : x.confidence.toFixed(2),
    line: (x.line || '').slice(0, 320)
  }));
  fs.writeFileSync(files.internalStatsCsv, toCsv(internalStatsRows, [
    'ts', 'decoder', 'hdr', 'fps_total', 'fps_rx', 'fps_rd', 'loss_frames', 'loss_total', 'loss_pct', 'loss_events',
    'rtt_ms', 'rtt_var_ms', 'decode_ms', 'render_ms', 'total_ms',
    'host_latency_min_ms', 'host_latency_max_ms', 'host_latency_avg_ms',
    'phase', 'confidence', 'line'
  ]));

  const streamWindowRows = buildStreamWindowRows(streamDetection);
  fs.writeFileSync(files.streamWindowsCsv, toCsv(streamWindowRows, [
    'id', 'start_ts', 'end_ts', 'duration_ms', 'valid', 'confidence', 'score',
    'has_strong_start', 'has_start_marker', 'has_end_marker',
    'start_marker_count', 'end_marker_count', 'activity_count'
  ]));

  const appAnalysis = buildAppFocusAnalysis(appFocus, store.eventsByType, {
    windowSec: 60,
    allowedPhases: analysisPhases
  });
  const pingSamplesRows = pingFocus.samples.map((x) => ({
    ts: formatTs(x.ts),
    seq: x.seq == null ? '' : x.seq,
    status: x.status,
    latency_ms: x.latencyMs == null ? '' : x.latencyMs,
    ts_source: x.tsSource || '',
    line: (x.line || '').slice(0, 320)
  }));
  fs.writeFileSync(files.pingLatencyCsv, toCsv(pingSamplesRows, ['ts', 'seq', 'status', 'latency_ms', 'ts_source', 'line']));
  const pingAnalysis = buildPingAppAnalysis(pingFocus, appFocus, store.eventsByType, {
    windowSec: 1,
    allowedPhases: analysisPhases,
    degraded: degradedAnalysis
  });

  const top3 = pickTopPeriodicEvents(store.eventsByType, intervals.periodicityByType);
  const alignment = buildAlignment(store.events, store.eventsByType);
  const eventCount = buildEventCount(store.events);
  const topTypeSet = new Set(top3.map((x) => x.type));
  const topEventsForContext = store.events.filter((e) => topTypeSet.has(e.type));
  const contexts = await buildContexts(files.logcat, topEventsForContext, new Date().getFullYear());

  const reportMarkdown = buildMarkdownReport({
    logDir,
    startTs,
    endTs,
    logcatLineCount: logcatStats.lineCount,
    events: store.events,
    eventCount,
    top3,
    intervalStats: intervals.intervalStats,
    alignment,
    topEventsForContext,
    contexts,
    clues: logcatStats.clues,
    filterStats: {
      filteredLineCount: logcatStats.filteredLineCount,
      filteredByReason: logcatStats.filteredByReason
    },
    appFocus,
    appAnalysis,
    streamDetection,
    analysisPhases,
    degradedAnalysis,
    pingFocus,
    pingAnalysis,
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
      pingHostLog: files.pingHost,
      pingLatencyCsv: files.pingLatencyCsv
    },
    missingOptional,
    wakelockStats: timeline.wakelockStats,
    captureMeta
  });
  fs.writeFileSync(files.reportMd, reportMarkdown);

  const analysisMeta = {
    version: 5,
    logDir,
    generatedAtIso: new Date().toISOString(),
    counts: {
      eventsTotal: store.events.length,
      logcatLineCount: logcatStats.lineCount,
      filteredLogcatLineCount: logcatStats.filteredLineCount,
      eventCount,
      appMatchedLineCount: appFocus.matchedLineCount,
      appKeptLineCount: appFocus.keptLineCount,
      appDroppedLineCount: appFocus.droppedLineCount,
      appAnomalyCount: appFocus.anomalyEvents.length,
      appMetricSampleCount: appFocus.metricSamples.length,
      appInternalStatsSampleCount: appFocus.internalStatsSamples.length,
      pingSampleCount: pingFocus.sampleCount,
      pingSuccessCount: pingFocus.successCount,
      pingFailureCount: pingFocus.failureCount
    },
    filterStats: {
      filteredByReason: logcatStats.filteredByReason
    },
    intervalStats: intervals.intervalStats,
    top3,
    alignment,
    streaming: {
      mode: args.streamWindowMode,
      detected: streamDetection.detected,
      degraded: degradedAnalysis,
      reason: streamDetection.reason,
      analysisPhases,
      markerCounts: streamDetection.markerCounts,
      windows: streamDetection.windows.map((w) => ({
        id: w.id,
        startTs: w.startTs.toISOString(),
        endTs: w.endTs.toISOString(),
        durationMs: Math.max(0, w.endTs.getTime() - w.startTs.getTime()),
        valid: w.valid,
        confidence: w.confidence,
        score: w.score
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
      sampleCount: appFocus.internalStatsSamples.length,
      firstTs: appFocus.internalStatsSamples.length ? appFocus.internalStatsSamples[0].ts.toISOString() : null,
      lastTs: appFocus.internalStatsSamples.length ? appFocus.internalStatsSamples[appFocus.internalStatsSamples.length - 1].ts.toISOString() : null,
      metricSummary: summarizeInternalStats(appFocus.internalStatsSamples)
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
      summary: pingFocus.summary,
      highLatencyThresholdMs: pingFocus.highLatencyThresholdMs
    },
    pingAnalysis,
    causeRanking: pingAnalysis.causeRanking || [],
    outputFiles: {
      appFocusLog: files.appFocusLog,
      appMetricsCsv: files.appMetricsCsv,
      internalStatsCsv: files.internalStatsCsv,
      streamWindowsCsv: files.streamWindowsCsv,
      pingHostLog: files.pingHost,
      pingLatencyCsv: files.pingLatencyCsv
    },
    missingOptional
  };
  writeJson(files.analysisMeta, analysisMeta);

  console.log('[report] 生成完成:');
  console.log(`  - ${files.timelineCsv}`);
  console.log(`  - ${files.intervalsCsv}`);
  console.log(`  - ${files.appFocusLog}`);
  console.log(`  - ${files.appMetricsCsv}`);
  console.log(`  - ${files.internalStatsCsv}`);
  console.log(`  - ${files.streamWindowsCsv}`);
  console.log(`  - ${files.pingLatencyCsv}`);
  console.log(`  - ${files.reportMd}`);
  console.log(`  - ${files.analysisMeta}`);
}
