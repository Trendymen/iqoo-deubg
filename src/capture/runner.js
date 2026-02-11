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

function buildPingShellCommand({ hostIp, intervalSec }) {
  const normalizedInterval = normalizePingIntervalSec(intervalSec);
  return `ping -i ${normalizedInterval} -D ${hostIp} || ping -i ${normalizedInterval} ${hostIp}`;
}

function startHostPingProcess({ serial, hostPing, streams, meta }) {
  if (!hostPing || !hostPing.enabled || !hostPing.hostIp) return null;

  const pingCmd = buildPingShellCommand(hostPing);
  console.log(`[capture] 启动 host ping: ip=${hostPing.hostIp}, interval=${normalizePingIntervalSec(hostPing.intervalSec)}s`);
  const pingProc = execa('adb', adbArgsForSerial(serial, ['shell', 'sh', '-c', pingCmd]), {
    stdout: 'pipe',
    stderr: 'pipe',
    buffer: false,
    reject: false,
    windowsHide: true
  });

  if (pingProc.stdout) pingProc.stdout.pipe(streams.pingHost, { end: false });
  if (pingProc.stderr) pingProc.stderr.pipe(streams.pingHost, { end: false });

  meta.hostPing.startedAtIso = new Date().toISOString();
  return {
    proc: pingProc,
    exitPromise: pingProc.catch(() => null)
  };
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

export async function runCaptureFlow({ minutes, out, serial, devices, hostPing }) {
  const startedAt = new Date();
  const filePaths = buildCapturePaths(out, startedAt);
  const streams = createCaptureStreams(filePaths, { enablePingHost: Boolean(hostPing && hostPing.enabled) });
  const meta = createCaptureMeta({
    startedAtIso: startedAt.toISOString(),
    outDir: filePaths.outDir,
    minutes,
    serial,
    devices,
    hostPing
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
  const pingRuntime = startHostPingProcess({ serial, hostPing, streams, meta });

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
