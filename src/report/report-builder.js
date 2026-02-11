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

export function buildMarkdownReport({
  logDir,
  startTs,
  endTs,
  logcatLineCount,
  events,
  eventCount,
  filterStats,
  appFocus,
  appAnalysis,
  streamDetection,
  analysisPhases,
  degradedAnalysis,
  pingFocus,
  pingAnalysis,
  noiseReduction,
  outputFiles,
  missingOptional,
  captureMeta
}) {
  const lines = [];
  const phaseSet = new Set(analysisPhases || []);
  const causeRanking = (pingAnalysis && pingAnalysis.causeRanking) || [];
  const streamWindowsTable = buildStreamWindowsTable(streamDetection);
  const internalMetricRows = buildInternalMetricSummary((appAnalysis && appAnalysis.metricSummary) || {});
  const internalPeaks = buildPeakRows(appFocus.internalStatsSamples || [], phaseSet);

  lines.push('# 串流网络抖动分析报告（降噪版）');
  lines.push('');
  lines.push(`- 日志目录: ${logDir}`);
  lines.push(`- 解析时间: ${new Date().toISOString()}`);
  lines.push(`- 采集区间: ${formatTs(startTs)} ~ ${formatTs(endTs)}`);
  lines.push(`- 当前分析相位: ${(analysisPhases || []).join(', ') || 'N/A'}`);
  lines.push(`- logcat 可解析行数: ${logcatLineCount}`);
  lines.push(`- 总事件数: ${events.length}`);
  lines.push('');

  if (degradedAnalysis) {
    lines.push('> ⚠️ 本次未识别到有效串流会话，以下为预连接阶段推断，置信度较低。');
    lines.push('');
  }

  lines.push('## 1) 串流会话识别结果');
  lines.push(`- 检测模式: ${(streamDetection && streamDetection.mode) || 'auto'}`);
  lines.push(`- 是否检测到有效串流会话: ${(streamDetection && streamDetection.detected) ? '是' : '否'}`);
  lines.push(`- 是否降级分析: ${degradedAnalysis ? '是' : '否'}`);
  lines.push(`- 降级原因: ${(streamDetection && streamDetection.reason) || '无'}`);
  lines.push(`- 窗口 CSV: ${outputFiles.streamWindowsCsv}`);
  if (streamWindowsTable) {
    lines.push('');
    lines.push(markdownTable(streamWindowsTable, { align: ['r', 'l', 'l', 'r', 'c', 'r', 'r', 'l'] }));
  } else {
    lines.push('- 未识别到会话 marker，窗口列表为空。');
  }
  lines.push('');

  lines.push('## 2) 内部统计摘要（INTERNAL_STATS）');
  lines.push(`- 样本数: ${(appFocus.internalStatsSamples || []).length}`);
  lines.push(`- INTERNAL_STATS CSV: ${outputFiles.internalStatsCsv}`);
  lines.push(`- App 指标 CSV: ${outputFiles.appMetricsCsv}`);
  lines.push(`- 分析窗口内指标样本数: ${(appAnalysis && appAnalysis.selectedMetricSampleCount) || 0}`);
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
    lines.push('');
    lines.push(markdownTable(table, { align: ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'l'] }));
  } else {
    lines.push('- 未提取到 INTERNAL_STATS 指标（兼容旧日志时为正常情况）。');
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
    lines.push('### 峰值时刻');
    lines.push(markdownTable(peakTable, { align: ['l', 'l', 'r', 'l'] }));
  }
  lines.push('');

  lines.push('## 3) 网络抖动可能原因排名');
  if (!pingFocus.exists) {
    lines.push('- 未找到 ping_host.log，无法输出网络抖动原因排名。');
  } else if (!causeRanking.length) {
    lines.push('- 未形成可用的原因排名。');
  } else {
    if (degradedAnalysis) {
      lines.push('- 当前排名基于非串流窗口数据，所有结论已统一降置信。');
    }
    lines.push(markdownTable(buildCauseRankingTable(causeRanking), { align: ['r', 'l', 'r', 'c', 'c', 'r', 'r', 'r', 'r'] }));
    lines.push('');
    causeRanking.forEach((row, idx) => {
      lines.push(`### ${idx + 1}. ${CAUSE_LABELS[row.cause] || row.cause}`);
      lines.push(`- 分数=${toFixedOrNA(row.score)}, 等级=${row.level || 'low'}, 置信=${row.confidence || 'low'}`);
      const evidence = (row.evidence || []).slice(0, 5);
      if (!evidence.length) {
        lines.push('- 证据: 无可用时间对齐证据');
      } else {
        evidence.forEach((ev) => {
          lines.push(`- [${formatTs(ev.ts)}] ${ev.metric}=${toFixedOrNA(ev.value)} | ${ev.detail}`);
        });
      }
      lines.push('');
    });
  }
  lines.push('');

  lines.push('## 4) Ping 与 App 同窗关联（聚焦分析窗口）');
  lines.push(`- Ping 原始日志: ${outputFiles.pingHostLog}`);
  lines.push(`- Ping 指标 CSV: ${outputFiles.pingLatencyCsv}`);
  if (!pingFocus.exists) {
    lines.push('- 未启用或未采集到 ping_host.log。');
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
      lines.push('- 自动识别: 未发现显著 ping 侧异常。');
    }
  }
  lines.push('');

  lines.push('## 5) Dumpsys 事件摘要（wifi/alarm/jobs）');
  const dumpsysRows = [
    ['事件类型', '计数'],
    ['WIFI_ON', String((eventCount && eventCount.WIFI_ON) || 0)],
    ['WIFI_OFF', String((eventCount && eventCount.WIFI_OFF) || 0)],
    ['WIFI_IFACE_UP', String((eventCount && eventCount.WIFI_IFACE_UP) || 0)],
    ['WIFI_IFACE_DOWN', String((eventCount && eventCount.WIFI_IFACE_DOWN) || 0)],
    ['ALARM_QUEUE_JUMP', String((eventCount && eventCount.ALARM_QUEUE_JUMP) || 0)],
    ['ALARM_WAKEUP_BURST', String((eventCount && eventCount.ALARM_WAKEUP_BURST) || 0)],
    ['ALARM_WAKEUP_SOON', String((eventCount && eventCount.ALARM_WAKEUP_SOON) || 0)],
    ['JOB_ACTIVE_SPIKE', String((eventCount && eventCount.JOB_ACTIVE_SPIKE) || 0)]
  ];
  lines.push('- 来源: dumpsys 快照跨样本转移（不是 logcat 关键字匹配）。');
  lines.push(markdownTable(dumpsysRows, { align: ['l', 'r'] }));
  lines.push('');

  lines.push('## 6) 降噪统计');
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

  lines.push('## 7) 数据完整性');
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
