import { TASKS } from './constants.js';

export function createCaptureMeta({ startedAtIso, outDir, minutes, serial, devices, hostPing, hostSidePing, pingLogTzOffset }) {
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
    version: 3,
    startedAtIso,
    outDir,
    minutes,
    serial,
    devices,
    pingLogTzOffset: pingLogTzOffset || '+08:00',
    hostPing: {
      enabled: Boolean(hostPing && hostPing.enabled),
      hostIp: hostPing && hostPing.enabled ? hostPing.hostIp : '',
      intervalSec: hostPing && hostPing.enabled ? hostPing.intervalSec : null,
      configPath: hostPing ? hostPing.configPath : '',
      startedAtIso: null,
      stoppedAtIso: null,
      exitCode: null
    },
    hostSidePing: {
      enabled: Boolean(hostSidePing && hostSidePing.enabled),
      hostIp: hostSidePing && hostSidePing.enabled ? hostSidePing.hostIp : '',
      intervalSec: hostSidePing && hostSidePing.enabled ? hostSidePing.intervalSec : null,
      sshHost: hostSidePing && hostSidePing.enabled ? hostSidePing.sshHost : '',
      sshPort: hostSidePing && hostSidePing.enabled ? hostSidePing.sshPort : null,
      sshUser: hostSidePing && hostSidePing.enabled ? hostSidePing.sshUser : '',
      sshKeyPath: hostSidePing && hostSidePing.enabled ? hostSidePing.sshKeyPath : '',
      remoteScriptDir: hostSidePing && hostSidePing.enabled ? hostSidePing.remoteScriptDir : '',
      configPath: hostSidePing ? hostSidePing.configPath : '',
      startedAtIso: null,
      stoppedAtIso: null,
      exitCode: null
    },
    stopReason: null,
    parseExitCode: null,
    stats
  };
}
