import path from 'node:path';
import { statSync } from 'node:fs';
import fg from 'fast-glob';
import fsExtra from 'fs-extra';

const { pathExistsSync } = fsExtra;

export function findLatestLogDir(rootDir) {
  if (!pathExistsSync(rootDir)) return null;
  const dirs = fg.sync('*', {
    cwd: rootDir,
    onlyDirectories: true,
    absolute: true,
    suppressErrors: true
  });
  if (!dirs.length) return null;
  dirs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return dirs[0];
}

export function resolveLogDir(args, logsRoot = path.resolve('./logs')) {
  const logDir = args.dir ? path.resolve(args.dir) : (args.latest ? findLatestLogDir(logsRoot) : null);
  if (!logDir) {
    throw new Error('未指定 --dir，且找不到最新日志目录。');
  }
  if (!pathExistsSync(logDir)) {
    throw new Error(`日志目录不存在: ${logDir}`);
  }
  return logDir;
}

export function buildReportFiles(logDir) {
  return {
    logcat: path.join(logDir, 'logcat_all.log'),
    wifi: path.join(logDir, 'dumpsys_wifi.log'),
    conn: path.join(logDir, 'dumpsys_conn.log'),
    deviceidle: path.join(logDir, 'dumpsys_deviceidle.log'),
    power: path.join(logDir, 'dumpsys_power.log'),
    alarm: path.join(logDir, 'dumpsys_alarm.log'),
    jobs: path.join(logDir, 'dumpsys_jobs.log'),
    pingHost: path.join(logDir, 'ping_host.log'),
    captureMeta: path.join(logDir, 'capture_meta.json'),
    timelineCsv: path.join(logDir, 'timeline.csv'),
    timelineSessionCsv: path.join(logDir, 'timeline_session.csv'),
    intervalsCsv: path.join(logDir, 'intervals.csv'),
    intervalsSessionCsv: path.join(logDir, 'intervals_session.csv'),
    appFocusLog: path.join(logDir, 'app_focus.log'),
    appMetricsCsv: path.join(logDir, 'app_metrics.csv'),
    internalStatsCsv: path.join(logDir, 'internal_stats.csv'),
    streamWindowsCsv: path.join(logDir, 'stream_windows.csv'),
    streamWindowsEffectiveCsv: path.join(logDir, 'stream_windows_effective.csv'),
    pingLatencyCsv: path.join(logDir, 'ping_latency.csv'),
    pingLatencySessionCsv: path.join(logDir, 'ping_latency_session.csv'),
    reportMd: path.join(logDir, 'report.md'),
    analysisMeta: path.join(logDir, 'analysis_meta.json')
  };
}
