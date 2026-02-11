import path from 'node:path';
import PQueue from 'p-queue';
import { execa } from 'execa';
import open from 'open';
import { runAdb, adbArgsForSerial } from '../shared/adb.js';
import { appendSnapshot, closeStreams, writeJson } from '../shared/io.js';
import { sleep } from '../shared/time.js';
import { TASKS, TASK_START_OFFSETS_MS } from './constants.js';
import { buildCapturePaths, createCaptureStreams } from './files.js';
import { createCaptureMeta } from './meta.js';
import { runParseReport } from './report-runner.js';

const TZ_OFFSET_REGEX = /^[+-](\d{2}):(\d{2})$/;
const PREFXED_LOG_LINE_REGEX = /^\[ts_local=[^\]]+\]\[epoch_ms=\d+\](?:\[source=[^\]]+\])?\s/;

async function runDumpsysTask({ task, stat, serial, streams }) {
  const started = Date.now();
  let status = 'OK';
  let detail = '';
  let payload = '';

  try {
    const result = await runAdb(adbArgsForSerial(serial, ['shell', 'dumpsys', task.service]), {
      timeout: 20000,
      maxBuffer: 64 * 1024 * 1024
    });
    payload = (result.stdout || '').split(/\r?\n/).slice(0, task.lineLimit).join('\n');
    if (result.stderr && result.stderr.trim()) detail = `stderr=${result.stderr.trim()}`;
    stat.ok += 1;
  } catch (err) {
    const out = [];
    if (err.stdout) out.push(err.stdout);
    if (err.stderr) out.push(`[stderr]\n${err.stderr}`);
    payload = out.join('\n');
    if (err.timedOut || /timed out/i.test(String(err.message || ''))) {
      status = 'TIMEOUT';
      stat.timeout += 1;
    } else {
      status = 'ERROR';
      stat.error += 1;
    }
    detail = String(err.message || err);
  } finally {
    const durationMs = Date.now() - started;
    stat.lastDurationMs = durationMs;
    appendSnapshot(streams[task.name], { taskName: task.name, status, durationMs, detail, payload });
  }
}

function normalizePingIntervalSec(intervalSec) {
  const value = Number(intervalSec);
  if (!Number.isFinite(value) || value <= 0) return '0.2';
  return value.toFixed(3).replace(/\.?0+$/, '');
}

function buildDevicePingArgs({ hostIp, intervalSec }) {
  const normalizedInterval = normalizePingIntervalSec(intervalSec);
  return ['ping', '-i', normalizedInterval, hostIp];
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

function parseTzOffsetToMinutes(rawOffset) {
  const text = String(rawOffset || '+08:00').trim();
  const m = text.match(TZ_OFFSET_REGEX);
  if (!m) return 8 * 60;
  const sign = text.startsWith('-') ? -1 : 1;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  return sign * (hours * 60 + minutes);
}

function formatTsWithOffset(epochMs, offsetMinutes) {
  const shifted = new Date(epochMs + offsetMinutes * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = pad2(shifted.getUTCMonth() + 1);
  const day = pad2(shifted.getUTCDate());
  const hour = pad2(shifted.getUTCHours());
  const minute = pad2(shifted.getUTCMinutes());
  const second = pad2(shifted.getUTCSeconds());
  const ms = pad3(shifted.getUTCMilliseconds());
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const tzH = pad2(Math.floor(abs / 60));
  const tzM = pad2(abs % 60);
  return `${year}-${month}-${day} ${hour}:${minute}:${second}.${ms} ${sign}${tzH}:${tzM}`;
}

function writePrefixedLogLine(stream, rawLine, { source, tzOffsetMinutes }) {
  const line = String(rawLine || '');
  if (!line) return;
  if (PREFXED_LOG_LINE_REGEX.test(line)) {
    stream.write(line.endsWith('\n') ? line : `${line}\n`);
    return;
  }
  const epochMs = Date.now();
  const tsLocal = formatTsWithOffset(epochMs, tzOffsetMinutes);
  stream.write(`[ts_local=${tsLocal}][epoch_ms=${epochMs}][source=${source}] ${line}\n`);
}

function bindProcessOutputWithPrefix(proc, stream, { source, tzOffsetMinutes }) {
  let stdoutBuffer = '';
  let stderrBuffer = '';

  const flushLines = (buffer, chunk, writer) => {
    const text = buffer + String(chunk || '');
    const lines = text.split(/\r?\n/);
    const remain = lines.pop() || '';
    lines.forEach((line) => writer(line));
    return remain;
  };

  if (proc.stdout) {
    proc.stdout.on('data', (chunk) => {
      stdoutBuffer = flushLines(stdoutBuffer, chunk, (line) => {
        writePrefixedLogLine(stream, line, { source, tzOffsetMinutes });
      });
    });
    proc.stdout.on('end', () => {
      if (stdoutBuffer) {
        writePrefixedLogLine(stream, stdoutBuffer, { source, tzOffsetMinutes });
        stdoutBuffer = '';
      }
    });
  }
  if (proc.stderr) {
    proc.stderr.on('data', (chunk) => {
      stderrBuffer = flushLines(stderrBuffer, chunk, (line) => {
        writePrefixedLogLine(stream, line, { source, tzOffsetMinutes });
      });
    });
    proc.stderr.on('end', () => {
      if (stderrBuffer) {
        writePrefixedLogLine(stream, stderrBuffer, { source, tzOffsetMinutes });
        stderrBuffer = '';
      }
    });
  }
}

function buildSshArgs(hostSidePing, remoteArgs) {
  const target = `${hostSidePing.sshUser}@${hostSidePing.sshHost}`;
  return [
    '-p', String(hostSidePing.sshPort),
    '-i', hostSidePing.sshKeyPath,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    target,
    ...remoteArgs
  ];
}

function buildRemoteScriptPath(hostSidePing, scriptName) {
  const dir = String(hostSidePing.remoteScriptDir || 'C:\\iqoo-ping').replace(/[\\/]+$/, '');
  return `${dir}\\${scriptName}`;
}

function startDeviceHostPingProcess({ serial, hostPing, streams, meta, pingLogTzOffset }) {
  if (!hostPing || !hostPing.enabled || !hostPing.hostIp) return null;

  const pingArgs = buildDevicePingArgs(hostPing);
  console.log(`[capture] 启动 host ping: ip=${hostPing.hostIp}, interval=${normalizePingIntervalSec(hostPing.intervalSec)}s`);
  const pingProc = execa('adb', adbArgsForSerial(serial, ['shell', ...pingArgs]), {
    stdout: 'pipe',
    stderr: 'pipe',
    buffer: false,
    reject: false,
    windowsHide: true
  });

  bindProcessOutputWithPrefix(pingProc, streams.pingHost, {
    source: 'device_side_ping',
    tzOffsetMinutes: parseTzOffsetToMinutes(pingLogTzOffset)
  });

  meta.hostPing.startedAtIso = new Date().toISOString();
  return {
    proc: pingProc,
    exitPromise: pingProc.catch(() => null)
  };
}

async function verifyHostSidePingReady(hostSidePing) {
  if (!hostSidePing || !hostSidePing.enabled) return;

  const startScriptPath = buildRemoteScriptPath(hostSidePing, 'start_host_ping.ps1');
  const stopScriptPath = buildRemoteScriptPath(hostSidePing, 'stop_host_ping.ps1');
  const statusScriptPath = buildRemoteScriptPath(hostSidePing, 'status_host_ping.ps1');
  console.log(`[capture] 检查 host-side SSH 连通: ${hostSidePing.sshUser}@${hostSidePing.sshHost}:${hostSidePing.sshPort}`);

  const psProbeArgs = buildSshArgs(hostSidePing, [
    'powershell',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    '$PSVersionTable.PSVersion.ToString()'
  ]);
  const psProbe = await execa('ssh', psProbeArgs, {
    timeout: 20000,
    reject: false,
    windowsHide: true
  });
  if (psProbe.exitCode !== 0) {
    throw new Error(`host-side SSH PowerShell 检查失败: ${String(psProbe.stderr || psProbe.stdout || 'unknown error').trim()}`);
  }

  const npingCheckArgs = buildSshArgs(hostSidePing, [
    'powershell',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    'nping --version'
  ]);
  const npingCheck = await execa('ssh', npingCheckArgs, {
    timeout: 20000,
    reject: false,
    windowsHide: true
  });
  if (npingCheck.exitCode !== 0) {
    throw new Error(`host-side nping 检查失败，请确认 Windows 主机已安装 Nmap/nping: ${String(npingCheck.stderr || npingCheck.stdout || 'unknown error').trim()}`);
  }

  const statusCheckArgs = buildSshArgs(hostSidePing, [
    'powershell',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    statusScriptPath
  ]);
  const statusCheck = await execa('ssh', statusCheckArgs, {
    timeout: 20000,
    reject: false,
    windowsHide: true
  });
  if (statusCheck.exitCode !== 0) {
    throw new Error(`host-side status 脚本检查失败，请确认脚本已部署: ${statusScriptPath}`);
  }

  const startProbeArgs = buildSshArgs(hostSidePing, [
    'powershell',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `if (!(Test-Path '${startScriptPath}')) { exit 3 }; if (!(Test-Path '${stopScriptPath}')) { exit 4 }`
  ]);
  const startProbe = await execa('ssh', startProbeArgs, {
    timeout: 20000,
    reject: false,
    windowsHide: true
  });
  if (startProbe.exitCode !== 0) {
    throw new Error(`host-side start/stop 脚本不存在，请检查 ${hostSidePing.remoteScriptDir}`);
  }
}

function startHostSidePingProcess({ hostSidePing, streams, meta, pingLogTzOffset }) {
  if (!hostSidePing || !hostSidePing.enabled) return null;

  const startScriptPath = buildRemoteScriptPath(hostSidePing, 'start_host_ping.ps1');
  const remoteLogPath = buildRemoteScriptPath(hostSidePing, 'host_side_ping.log');
  const remotePidPath = buildRemoteScriptPath(hostSidePing, 'host_side_ping.pid');
  const intervalMs = Math.max(1, Math.round(Number(hostSidePing.intervalSec || 0.2) * 1000));
  console.log(`[capture] 启动 host-side ping: ssh=${hostSidePing.sshUser}@${hostSidePing.sshHost}:${hostSidePing.sshPort}, target=${hostSidePing.hostIp}, interval=${normalizePingIntervalSec(hostSidePing.intervalSec)}s`);

  const sshArgs = buildSshArgs(hostSidePing, [
    'powershell',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    startScriptPath,
    '-TargetIp',
    hostSidePing.hostIp,
    '-IntervalMs',
    String(intervalMs),
    '-LogFile',
    remoteLogPath,
    '-PidFile',
    remotePidPath,
    '-TzOffset',
    pingLogTzOffset
  ]);
  const hostSideProc = execa('ssh', sshArgs, {
    stdout: 'pipe',
    stderr: 'pipe',
    buffer: false,
    reject: false,
    windowsHide: true
  });

  bindProcessOutputWithPrefix(hostSideProc, streams.pingHostSide, {
    source: 'host_side_ping',
    tzOffsetMinutes: parseTzOffsetToMinutes(pingLogTzOffset)
  });

  meta.hostSidePing.startedAtIso = new Date().toISOString();
  return {
    proc: hostSideProc,
    exitPromise: hostSideProc.catch(() => null),
    remotePidPath
  };
}

async function stopHostSidePingRemote(hostSidePing, remotePidPath) {
  if (!hostSidePing || !hostSidePing.enabled) return;
  const stopScriptPath = buildRemoteScriptPath(hostSidePing, 'stop_host_ping.ps1');
  const sshArgs = buildSshArgs(hostSidePing, [
    'powershell',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    stopScriptPath,
    '-PidFile',
    remotePidPath || buildRemoteScriptPath(hostSidePing, 'host_side_ping.pid')
  ]);
  const result = await execa('ssh', sshArgs, {
    timeout: 20000,
    reject: false,
    windowsHide: true
  });
  if (result.exitCode !== 0) {
    console.warn('[capture] host-side stop 脚本返回非零:', String(result.stderr || result.stdout || '').trim());
  }
}

async function terminateSubprocess(proc, exitPromise) {
  if (!proc || proc.exitCode != null) return;

  try {
    proc.kill('SIGINT');
  } catch {
    // ignore
  }

  await Promise.race([exitPromise, sleep(3500)]);
  if (proc.exitCode != null) return;

  if (process.platform === 'win32' && proc.pid) {
    await execa('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
      reject: false,
      windowsHide: true
    });
    await Promise.race([exitPromise, sleep(1500)]);
    return;
  }

  try {
    proc.kill('SIGKILL');
  } catch {
    // ignore
  }
  await Promise.race([exitPromise, sleep(1500)]);
}

export async function runCaptureFlow({ minutes, out, serial, devices, hostPing, hostSidePing, pingLogTzOffset }) {
  const pingTzOffset = pingLogTzOffset || '+08:00';
  await verifyHostSidePingReady(hostSidePing);

  const startedAt = new Date();
  const filePaths = buildCapturePaths(out, startedAt);
  const streams = createCaptureStreams(filePaths, {
    enablePingHost: Boolean(hostPing && hostPing.enabled),
    enablePingHostSide: Boolean(hostSidePing && hostSidePing.enabled)
  });
  const meta = createCaptureMeta({
    startedAtIso: startedAt.toISOString(),
    outDir: filePaths.outDir,
    minutes,
    serial,
    devices,
    hostPing,
    hostSidePing,
    pingLogTzOffset: pingTzOffset
  });
  writeJson(filePaths.meta, meta);

  console.log(`[capture] 输出目录: ${filePaths.outDir}`);
  console.log('[capture] 清空 logcat 缓冲...');
  try {
    await runAdb(adbArgsForSerial(serial, ['logcat', '-c']));
  } catch (err) {
    console.warn('[capture] logcat -c 失败，继续执行:', String(err.message || err));
  }

  console.log('[capture] 启动全量 logcat 采集...');
  const logcatProc = execa('adb', adbArgsForSerial(serial, ['logcat', '-v', 'threadtime']), {
    stdout: 'pipe',
    stderr: 'pipe',
    buffer: false,
    reject: false,
    windowsHide: true
  });
  if (logcatProc.stdout) logcatProc.stdout.pipe(streams.logcatAll, { end: false });
  if (logcatProc.stderr) logcatProc.stderr.pipe(streams.logcatErr, { end: false });
  const logcatExitPromise = logcatProc.catch(() => null);
  const pingRuntime = startDeviceHostPingProcess({ serial, hostPing, streams, meta, pingLogTzOffset: pingTzOffset });
  const hostSidePingRuntime = startHostSidePingProcess({
    hostSidePing,
    streams,
    meta,
    pingLogTzOffset: pingTzOffset
  });

  const queue = new PQueue({ concurrency: 1 });
  const state = {
    stopping: false,
    intervalHandles: [],
    timeoutHandles: [],
    autoStopHandle: null
  };

  let finalizeResolve;
  const finalizePromise = new Promise((resolve) => {
    finalizeResolve = resolve;
  });

  function scheduleTask(task) {
    const stat = meta.stats[task.name];
    stat.runs += 1;

    if (state.stopping) {
      stat.skipped += 1;
      appendSnapshot(streams[task.name], { taskName: task.name, status: 'SKIPPED', durationMs: 0, detail: 'reason=stopping' });
      return;
    }

    if (queue.pending + queue.size > 0) {
      stat.skipped += 1;
      appendSnapshot(streams[task.name], { taskName: task.name, status: 'SKIPPED', durationMs: 0, detail: 'reason=busy' });
      return;
    }

    void queue.add(() => runDumpsysTask({ task, stat, serial, streams }));
  }

  async function stop(reason, exitCode = 0) {
    if (state.stopping) return;
    state.stopping = true;
    meta.stopReason = reason;
    meta.stoppedAtIso = new Date().toISOString();
    console.log(`[capture] 停止采集，原因: ${reason}`);

    state.intervalHandles.forEach((h) => clearInterval(h));
    state.timeoutHandles.forEach((h) => clearTimeout(h));
    if (state.autoStopHandle) clearTimeout(state.autoStopHandle);

    await Promise.race([queue.onIdle(), sleep(25000)]);

    try {
      await terminateSubprocess(logcatProc, logcatExitPromise);
    } catch (err) {
      console.warn('[capture] 结束 logcat 子进程时出现异常:', String(err.message || err));
    }
    if (pingRuntime) {
      try {
        await terminateSubprocess(pingRuntime.proc, pingRuntime.exitPromise);
      } catch (err) {
        console.warn('[capture] 结束 ping 子进程时出现异常:', String(err.message || err));
      }
      const pingResult = await Promise.race([pingRuntime.exitPromise, sleep(800)]);
      if (pingResult && typeof pingResult.exitCode === 'number') {
        meta.hostPing.exitCode = pingResult.exitCode;
      } else if (pingRuntime.proc && typeof pingRuntime.proc.exitCode === 'number') {
        meta.hostPing.exitCode = pingRuntime.proc.exitCode;
      }
      meta.hostPing.stoppedAtIso = new Date().toISOString();
    }
    if (hostSidePingRuntime) {
      try {
        await terminateSubprocess(hostSidePingRuntime.proc, hostSidePingRuntime.exitPromise);
      } catch (err) {
        console.warn('[capture] 结束 host-side SSH 子进程时出现异常:', String(err.message || err));
      }
      try {
        await stopHostSidePingRemote(hostSidePing, hostSidePingRuntime.remotePidPath);
      } catch (err) {
        console.warn('[capture] 调用 host-side stop 脚本时出现异常:', String(err.message || err));
      }
      const hostSideResult = await Promise.race([hostSidePingRuntime.exitPromise, sleep(800)]);
      if (hostSideResult && typeof hostSideResult.exitCode === 'number') {
        meta.hostSidePing.exitCode = hostSideResult.exitCode;
      } else if (hostSidePingRuntime.proc && typeof hostSidePingRuntime.proc.exitCode === 'number') {
        meta.hostSidePing.exitCode = hostSidePingRuntime.proc.exitCode;
      }
      meta.hostSidePing.stoppedAtIso = new Date().toISOString();
    }

    meta.endedAtIso = new Date().toISOString();
    meta.durationSec = Math.round((new Date(meta.endedAtIso).getTime() - new Date(meta.startedAtIso).getTime()) / 1000);

    await closeStreams(streams);
    writeJson(filePaths.meta, meta);

    console.log('[capture] 采集完成，开始解析报告...');
    const parseExitCode = await runParseReport(filePaths.outDir);
    meta.parseExitCode = parseExitCode;
    writeJson(filePaths.meta, meta);

    if (parseExitCode !== 0) {
      console.error(`[capture] parse_report.js 返回非零退出码: ${parseExitCode}`);
      finalizeResolve(1);
      return;
    }

    const reportPath = path.join(filePaths.outDir, 'report.md');
    console.log('[capture] 全部完成。');
    console.log(`[capture] 结果目录: ${filePaths.outDir}`);
    console.log(`[capture] 查看报告: ${reportPath}`);

    try {
      await open(reportPath, { wait: false });
      console.log('[capture] 已尝试自动打开报告。');
    } catch (err) {
      console.warn('[capture] 自动打开报告失败，可手动打开:', String(err.message || err));
    }

    finalizeResolve(exitCode);
  }

  process.on('SIGINT', () => { void stop('SIGINT', 0); });
  process.on('SIGTERM', () => { void stop('SIGTERM', 0); });
  process.on('SIGBREAK', () => { void stop('SIGBREAK', 0); });
  process.on('uncaughtException', (err) => {
    console.error('[capture] uncaughtException:', err);
    void stop('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[capture] unhandledRejection:', reason);
    void stop('unhandledRejection', 1);
  });

  TASKS.forEach((task, idx) => {
    const offset = TASK_START_OFFSETS_MS[idx] || 0;
    const timeoutHandle = setTimeout(() => {
      scheduleTask(task);
      const intervalHandle = setInterval(() => {
        scheduleTask(task);
      }, task.intervalMs);
      state.intervalHandles.push(intervalHandle);
    }, offset);
    state.timeoutHandles.push(timeoutHandle);
  });

  const autoStopMs = Math.round(minutes * 60 * 1000);
  console.log(`[capture] 采集时长: ${minutes} 分钟。按 Ctrl+C 可提前优雅停止。`);
  state.autoStopHandle = setTimeout(() => {
    void stop('duration_reached', 0);
  }, autoStopMs);

  const finalCode = await finalizePromise;
  process.exit(finalCode);
}
