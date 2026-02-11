import { TASKS } from './constants.js';

export function createCaptureMeta({ startedAtIso, outDir, minutes, serial, devices, hostPing }) {
  const stats = {};
  for (const task of TASKS) {
    stats[task.name] = {
      runs: 0,
      ok: 0,
      skipped: 0,
      timeout: 0,
      error: 0,
      lastDurationMs: null
    };
  }
  return {
    version: 2,
    startedAtIso,
    outDir,
    minutes,
    serial,
    devices,
    hostPing: {
      enabled: Boolean(hostPing && hostPing.enabled),
      hostIp: hostPing && hostPing.enabled ? hostPing.hostIp : '',
      intervalSec: hostPing && hostPing.enabled ? hostPing.intervalSec : null,
      configPath: hostPing ? hostPing.configPath : '',
      startedAtIso: null,
      stoppedAtIso: null,
      exitCode: null
    },
    stopReason: null,
    parseExitCode: null,
    stats
  };
}
