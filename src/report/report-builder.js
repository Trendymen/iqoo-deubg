import { markdownTable } from 'markdown-table';
import { formatTs } from '../shared/time.js';

const INTERNAL_METRIC_KEYS = [
  'fps_total',
  'fps_rx',
  'fps_rd',
  'loss_pct',
  'rtt_ms',
  'rtt_var_ms',
  'decode_ms',
  'render_ms',
  'total_ms'
];

const CAUSE_LABELS = {
  network_path_jitter: '网络路径抖动',
  rtt_variance_burst: 'RTT 方差突发',
  decode_render_overload: '解码/渲染过载',
  system_transition_interference: '系统状态切换干扰'
};

function toFixedOrNA(value, digits = 2) {
  if (value == null || !Number.isFinite(value)) return 'N/A';
  return value.toFixed(digits);
}

function topCounterEntries(counter, limit = 12) {
  return Object.entries(counter || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function buildInternalMetricSummary(metricSummary) {
  return INTERNAL_METRIC_KEYS
    .map((metric) => ({ metric, ...(metricSummary[metric] || {}) }))
    .filter((row) => (row.count || 0) > 0);
}

function buildPeakRows(samples, phaseSet) {
  const filtered = (samples || []).filter((x) => phaseSet.has(x.phase || 'unknown'));
  const targetMetrics = [
    { key: 'rtt_var_ms', field: 'rttVarMs', direction: 'max', unit: 'ms' },
    { key: 'loss_pct', field: 'lossPct', direction: 'max', unit: '%' },
    { key: 'total_ms', field: 'totalMs', direction: 'max', unit: 'ms' },
    { key: 'decode_ms', field: 'decodeMs', direction: 'max', unit: 'ms' },
    { key: 'render_ms', field: 'renderMs', direction: 'max', unit: 'ms' }
  ];
  const out = [];
  for (const metric of targetMetrics) {
    const candidates = filtered.filter((x) => Number.isFinite(x[metric.field]));
    if (!candidates.length) continue;
    candidates.sort((a, b) => metric.direction === 'max'
      ? (b[metric.field] - a[metric.field])
      : (a[metric.field] - b[metric.field]));
    const best = candidates[0];
    out.push({
      metric: metric.key,
      ts: best.ts,
      value: best[metric.field],
      unit: metric.unit,
      phase: best.phase || ''
    });
  }
  return out.slice(0, 8);
}

function buildStreamWindowsTable(streamDetection) {
  const windows = (streamDetection && streamDetection.windows) || [];
  if (!windows.length) return null;
  const table = [['窗口', '开始', '结束', '时长(s)', 'valid', 'score', '置信度', '标记计数']];
  windows.forEach((w) => {
    const durationSec = Math.max(0, (w.endTs.getTime() - w.startTs.getTime()) / 1000);
    table.push([
      `#${w.id}`,
      formatTs(w.startTs),
      formatTs(w.endTs),
      durationSec.toFixed(2),
      w.valid ? 'yes' : 'no',
      toFixedOrNA(w.score),
      toFixedOrNA(w.confidence),
      `start=${w.startMarkerCount}, end=${w.endMarkerCount}, act=${w.activityCount}`
    ]);
  });
  return table;
}

function buildEffectiveWindowsTable(streamDetection) {
  const windows = (streamDetection && streamDetection.effectiveWindows) || [];
  if (!windows.length) return null;
  const table = [['窗口', '开始', '结束', '时长(s)']];
  windows.forEach((w) => {
    const durationSec = Math.max(0, (w.endTs.getTime() - w.startTs.getTime()) / 1000);
    table.push([
      `#${w.id}`,
      formatTs(w.startTs),
      formatTs(w.endTs),
      durationSec.toFixed(2)
    ]);
  });
  return table;
}

function buildCauseRankingTable(causeRanking) {
  if (!causeRanking.length) return null;
  const table = [['排名', '原因', '分数', '等级', '置信', 'overlap', 'lead_lag', 'intensity', '证据数']];
  causeRanking.forEach((row, idx) => {
    table.push([
      String(idx + 1),
      CAUSE_LABELS[row.cause] || row.cause,
      toFixedOrNA(row.score),
      row.level || 'low',
      row.confidence || 'low',
      toFixedOrNA(row.overlap),
      toFixedOrNA(row.leadLag),
      toFixedOrNA(row.intensity),
      String((row.evidence || []).length)
    ]);
  });
  return table;
}

function reasonToText(reason) {
  if (!reason) return 'N/A';
  if (reason === 'no_valid_window') return '未识别到有效串流窗口';
  if (reason === 'no_effective_windows') return '有效窗口裁剪后为空';
  if (reason === 'no_markers') return '日志未命中串流 marker';
  if (reason === 'missing_logcat') return '缺少 logcat';
  return reason;
}

function buildDumpsysCounterTable(eventCountAll, eventCountSession, eventCountOutside) {
  const rows = [
    ['事件类型', '全量', '会话内', '会话外'],
    ['CONN_DEFAULT_SWITCH', String((eventCountAll && eventCountAll.CONN_DEFAULT_SWITCH) || 0), String((eventCountSession && eventCountSession.CONN_DEFAULT_SWITCH) || 0), String((eventCountOutside && eventCountOutside.CONN_DEFAULT_SWITCH) || 0)],
    ['CONN_DEFAULT_TRANSPORT_CHANGE', String((eventCountAll && eventCountAll.CONN_DEFAULT_TRANSPORT_CHANGE) || 0), String((eventCountSession && eventCountSession.CONN_DEFAULT_TRANSPORT_CHANGE) || 0), String((eventCountOutside && eventCountOutside.CONN_DEFAULT_TRANSPORT_CHANGE) || 0)],
    ['WIFI_ON', String((eventCountAll && eventCountAll.WIFI_ON) || 0), String((eventCountSession && eventCountSession.WIFI_ON) || 0), String((eventCountOutside && eventCountOutside.WIFI_ON) || 0)],
    ['WIFI_OFF', String((eventCountAll && eventCountAll.WIFI_OFF) || 0), String((eventCountSession && eventCountSession.WIFI_OFF) || 0), String((eventCountOutside && eventCountOutside.WIFI_OFF) || 0)],
    ['WIFI_IFACE_UP', String((eventCountAll && eventCountAll.WIFI_IFACE_UP) || 0), String((eventCountSession && eventCountSession.WIFI_IFACE_UP) || 0), String((eventCountOutside && eventCountOutside.WIFI_IFACE_UP) || 0)],
    ['WIFI_IFACE_DOWN', String((eventCountAll && eventCountAll.WIFI_IFACE_DOWN) || 0), String((eventCountSession && eventCountSession.WIFI_IFACE_DOWN) || 0), String((eventCountOutside && eventCountOutside.WIFI_IFACE_DOWN) || 0)],
    ['ALARM_QUEUE_JUMP', String((eventCountAll && eventCountAll.ALARM_QUEUE_JUMP) || 0), String((eventCountSession && eventCountSession.ALARM_QUEUE_JUMP) || 0), String((eventCountOutside && eventCountOutside.ALARM_QUEUE_JUMP) || 0)],
    ['ALARM_WAKEUP_BURST', String((eventCountAll && eventCountAll.ALARM_WAKEUP_BURST) || 0), String((eventCountSession && eventCountSession.ALARM_WAKEUP_BURST) || 0), String((eventCountOutside && eventCountOutside.ALARM_WAKEUP_BURST) || 0)],
    ['ALARM_WAKEUP_SOON', String((eventCountAll && eventCountAll.ALARM_WAKEUP_SOON) || 0), String((eventCountSession && eventCountSession.ALARM_WAKEUP_SOON) || 0), String((eventCountOutside && eventCountOutside.ALARM_WAKEUP_SOON) || 0)],
    ['JOB_ACTIVE_SPIKE', String((eventCountAll && eventCountAll.JOB_ACTIVE_SPIKE) || 0), String((eventCountSession && eventCountSession.JOB_ACTIVE_SPIKE) || 0), String((eventCountOutside && eventCountOutside.JOB_ACTIVE_SPIKE) || 0)]
  ];
  return rows;
}

export function buildMarkdownReport({
  logDir,
  startTs,
  endTs,
  logcatLineCount,
  events,
  eventCount,
  eventCountAll,
  eventCountSession,
  eventCountOutside,
  appFocus,
  appFocusAll,
  appAnalysis,
  streamDetection,
  analysisPhases,
  degradedAnalysis,
  pingFocus,
  pingFocusAll,
  pingAnalysis,
  mainAnalysisAvailable,
  noValidSessionReason,
  noValidSessionPolicy,
  noiseReduction,
  outputFiles,
  missingOptional,
  filterStats,
  captureMeta
}) {
  const lines = [];
  const phaseSet = new Set(analysisPhases || []);
  const causeRanking = (pingAnalysis && pingAnalysis.causeRanking) || [];
  const streamWindowsTable = buildStreamWindowsTable(streamDetection);
  const effectiveWindowsTable = buildEffectiveWindowsTable(streamDetection);
  const internalMetricRows = buildInternalMetricSummary((appAnalysis && appAnalysis.metricSummary) || {});
  const internalPeaks = buildPeakRows(appFocus.internalStatsSamples || [], phaseSet);

  lines.push('# 串流网络抖动联合分析报告（会话内主分析）');
  lines.push('');
  lines.push(`- 日志目录: ${logDir}`);
  lines.push(`- 解析时间: ${new Date().toISOString()}`);
  lines.push(`- 采集区间: ${formatTs(startTs)} ~ ${formatTs(endTs)}`);
  lines.push(`- logcat 可解析行数: ${logcatLineCount}`);
  lines.push(`- 主分析事件数(会话内): ${events.length}`);
  lines.push(`- 全量事件数: ${Object.values(eventCountAll || {}).reduce((acc, x) => acc + (x || 0), 0)}`);
  lines.push('');

  lines.push('## 0) 主分析可用性');
  lines.push(`- 主分析可用: ${mainAnalysisAvailable ? '是' : '否'}`);
  lines.push(`- 无有效会话策略: ${noValidSessionPolicy}`);
  lines.push(`- 无有效会话原因: ${reasonToText(noValidSessionReason)}`);
  lines.push(`- 当前分析相位: ${(analysisPhases || []).join(', ') || 'N/A'}`);
  lines.push('');

  lines.push('## 1) 串流会话识别结果');
  lines.push(`- 检测模式: ${(streamDetection && streamDetection.mode) || 'auto'}`);
  lines.push(`- 是否检测到有效串流会话: ${(streamDetection && streamDetection.detected) ? '是' : '否'}`);
  lines.push(`- 是否降级分析: ${degradedAnalysis ? '是' : '否'}`);
  lines.push(`- 原始窗口 CSV: ${outputFiles.streamWindowsCsv}`);
  lines.push(`- 生效窗口 CSV: ${outputFiles.streamWindowsEffectiveCsv}`);
  if (streamWindowsTable) {
    lines.push('');
    lines.push('### 原始窗口');
    lines.push(markdownTable(streamWindowsTable, { align: ['r', 'l', 'l', 'r', 'c', 'r', 'r', 'l'] }));
  }
  if (effectiveWindowsTable) {
    lines.push('');
    lines.push('### 生效窗口（含缓冲）');
    lines.push(markdownTable(effectiveWindowsTable, { align: ['r', 'l', 'l', 'r'] }));
  }
  lines.push('');

  if (!mainAnalysisAvailable && noValidSessionPolicy === 'empty-main') {
    lines.push('## 2) 会话内主分析');
    lines.push('- 未检测到可用有效串流会话，主结论已按策略置空。');
    lines.push('- 建议重采:');
    lines.push('- 1) 采集时确保启动并持续串流 >= 2 分钟。');
    lines.push('- 2) 打开 `capture:ping` 并保证目标主机可达。');
    lines.push('- 3) 采集中避免切换到后台导致会话 marker 缺失。');
    lines.push('');
  } else {
    lines.push('## 2) 会话内主分析：内部统计');
    lines.push(`- 会话内 INTERNAL_STATS 样本数: ${(appFocus.internalStatsSamples || []).length}`);
    lines.push(`- 会话内 App 指标样本数: ${(appAnalysis && appAnalysis.selectedMetricSampleCount) || 0}`);
    lines.push(`- App 指标 CSV: ${outputFiles.appMetricsCsv}`);
    lines.push(`- INTERNAL_STATS CSV: ${outputFiles.internalStatsCsv}`);
    if (internalMetricRows.length > 0) {
      const table = [['指标', '样本数', 'min', 'p50', 'p95', 'max', 'avg', '单位']];
      internalMetricRows.forEach((row) => {
        table.push([
          row.metric,
          String(row.count || 0),
          toFixedOrNA(row.min),
          toFixedOrNA(row.p50),
          toFixedOrNA(row.p95),
          toFixedOrNA(row.max),
          toFixedOrNA(row.avg),
          row.unit || ''
        ]);
      });
      lines.push(markdownTable(table, { align: ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'l'] }));
    } else {
      lines.push('- 会话内未提取到 INTERNAL_STATS 指标。');
    }
    if (internalPeaks.length > 0) {
      const peakTable = [['指标', '峰值时间', '峰值', 'phase']];
      internalPeaks.forEach((row) => {
        peakTable.push([
          row.metric,
          formatTs(row.ts),
          `${toFixedOrNA(row.value)} ${row.unit}`.trim(),
          row.phase || ''
        ]);
      });
      lines.push('');
      lines.push(markdownTable(peakTable, { align: ['l', 'l', 'r', 'l'] }));
    }
    lines.push('');

    lines.push('## 3) 会话内主分析：Ping 与 App 同窗');
    lines.push(`- Ping 全量 CSV: ${outputFiles.pingLatencyCsv}`);
    lines.push(`- Ping 会话内 CSV: ${outputFiles.pingLatencySessionCsv}`);
    if (!pingFocus.exists || (pingFocus.sampleCount || 0) === 0) {
      lines.push('- 会话内无可用 ping 样本。');
    } else {
      const st = (pingAnalysis && pingAnalysis.latencySummary) || {};
      const table = [
        ['指标', '值'],
        ['sample_count', String(pingFocus.sampleCount || 0)],
        ['success_count', String(st.successCount || 0)],
        ['failure_count', String(st.failureCount || 0)],
        ['loss_rate_pct', toFixedOrNA(st.lossRatePct)],
        ['p50_ms', toFixedOrNA(st.p50)],
        ['p95_ms', toFixedOrNA(st.p95)],
        ['max_ms', toFixedOrNA(st.max)],
        ['high_latency_bursts', String(st.highLatencyBurstCount || 0)]
      ];
      lines.push(markdownTable(table, { align: ['l', 'r'] }));
      lines.push('');
      const jitterHit = (pingAnalysis && pingAnalysis.appAnomalyAroundJitter) || {};
      const highHit = (pingAnalysis && pingAnalysis.appAnomalyAroundHighLatency) || {};
      lines.push(`- 抖动点窗口命中率: ${toFixedOrNA((jitterHit.hitRatio || 0) * 100)}%`);
      lines.push(`- 高延迟段起点窗口命中率: ${toFixedOrNA((highHit.hitRatio || 0) * 100)}%`);
      const findings = (pingAnalysis && pingAnalysis.findings) || [];
      if (findings.length > 0) {
        lines.push('- 自动识别:');
        findings.forEach((x) => lines.push(`- [${x.level}] ${x.type}: ${x.detail}`));
      } else {
        lines.push('- 自动识别: 会话内未发现显著 ping 异常。');
      }
    }
    lines.push('');

    lines.push('## 4) 会话内主分析：可能原因排名');
    if (!causeRanking.length) {
      lines.push('- 会话内未形成可用原因排名。');
    } else {
      lines.push(markdownTable(buildCauseRankingTable(causeRanking), { align: ['r', 'l', 'r', 'c', 'c', 'r', 'r', 'r', 'r'] }));
      lines.push('');
      causeRanking.slice(0, 3).forEach((row, idx) => {
        lines.push(`### ${idx + 1}. ${CAUSE_LABELS[row.cause] || row.cause}`);
        lines.push(`- 分数=${toFixedOrNA(row.score)}, 等级=${row.level || 'low'}, 置信=${row.confidence || 'low'}`);
        const evidence = (row.evidence || []).slice(0, 3);
        if (!evidence.length) {
          lines.push('- 证据: 无可用时间对齐证据');
        } else {
          evidence.forEach((ev) => {
            lines.push(`- [${formatTs(ev.ts)}] ${ev.metric}=${toFixedOrNA(ev.value)} | ${ev.detail}`);
          });
        }
      });
    }
    lines.push('');
  }

  lines.push('## 5) 附录：全量 vs 会话内对照');
  lines.push(`- timeline 全量: ${outputFiles.timelineCsv}`);
  lines.push(`- timeline 会话内: ${outputFiles.timelineSessionCsv}`);
  lines.push(`- intervals 全量: ${outputFiles.intervalsCsv}`);
  lines.push(`- intervals 会话内: ${outputFiles.intervalsSessionCsv}`);
  lines.push(`- App 全量匹配行: ${(appFocusAll && appFocusAll.matchedLineCount) || 0}`);
  lines.push(`- App 会话内 metric 样本: ${(appFocus && appFocus.metricSamples && appFocus.metricSamples.length) || 0}`);
  lines.push(`- Ping 全量样本: ${(pingFocusAll && pingFocusAll.sampleCount) || 0}`);
  lines.push(`- Ping 会话内样本: ${(pingFocus && pingFocus.sampleCount) || 0}`);
  lines.push('');
  lines.push(markdownTable(buildDumpsysCounterTable(eventCountAll, eventCountSession, eventCountOutside), { align: ['l', 'r', 'r', 'r'] }));
  lines.push('');

  lines.push('## 6) 附录：降噪与完整性');
  lines.push(`- App 匹配总行数: ${noiseReduction.appMatchedLineCount || 0}`);
  lines.push(`- App 保留行数: ${noiseReduction.appKeptLineCount || 0}`);
  lines.push(`- App 丢弃行数: ${noiseReduction.appDroppedLineCount || 0}`);
  lines.push(`- App 焦点日志: ${outputFiles.appFocusLog}`);
  const appDroppedEntries = topCounterEntries(noiseReduction.appDroppedByReason, 16);
  if (appDroppedEntries.length > 0) {
    const table = [['App 丢弃原因', '行数']];
    appDroppedEntries.forEach(([reason, count]) => table.push([reason, String(count)]));
    lines.push(markdownTable(table, { align: ['l', 'r'] }));
    lines.push('');
  }
  const logcatDroppedEntries = topCounterEntries((noiseReduction && noiseReduction.logcatFilteredByReason) || {}, 16);
  if (logcatDroppedEntries.length > 0) {
    const table = [['logcat 过滤原因', '行数']];
    logcatDroppedEntries.forEach(([reason, count]) => table.push([reason, String(count)]));
    lines.push(markdownTable(table, { align: ['l', 'r'] }));
  } else {
    lines.push('- logcat 噪音过滤命中: 0');
  }
  lines.push('');
  lines.push(`- 缺失可选 dumpsys 文件: ${missingOptional.length ? missingOptional.join(', ') : '无'}`);
  if (filterStats && filterStats.filteredLineCount > 0) {
    lines.push(`- 全局 logcat 过滤行数: ${filterStats.filteredLineCount}`);
  } else {
    lines.push('- 全局 logcat 过滤行数: 0');
  }
  if (captureMeta && captureMeta.hostPing) {
    const hp = captureMeta.hostPing;
    lines.push(`- host ping 配置: enabled=${hp.enabled ? 'true' : 'false'}, hostIp=${hp.hostIp || 'N/A'}, intervalSec=${hp.intervalSec == null ? 'N/A' : hp.intervalSec}`);
  }
  lines.push('');

  return lines.join('\n');
}
