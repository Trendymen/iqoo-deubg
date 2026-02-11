import path from 'node:path';
import { ensureDir, createWriteStream } from '../shared/io.js';
import { formatDirTimestamp } from '../shared/time.js';
import { TASKS } from './constants.js';

export function buildCapturePaths(outRoot, startedAt) {
  const outDir = path.join(path.resolve(outRoot), formatDirTimestamp(startedAt));
  ensureDir(outDir);

  const filePaths = {
    outDir,
    logcatAll: path.join(outDir, 'logcat_all.log'),
    logcatErr: path.join(outDir, 'logcat_stderr.log'),
    pingHost: path.join(outDir, 'ping_host.log'),
    pingHostSide: path.join(outDir, 'ping_host_side.log'),
    meta: path.join(outDir, 'capture_meta.json')
  };
  for (const task of TASKS) {
    filePaths[task.name] = path.join(outDir, task.outFile);
  }
  return filePaths;
}

export function createCaptureStreams(filePaths, { enablePingHost = false, enablePingHostSide = false } = {}) {
  const streams = {
    logcatAll: createWriteStream(filePaths.logcatAll, 'a'),
    logcatErr: createWriteStream(filePaths.logcatErr, 'a')
  };
  for (const [name, p] of Object.entries(filePaths)) {
    if (name === 'outDir' || name === 'logcatAll' || name === 'logcatErr' || name === 'meta') continue;
    if (name === 'pingHost' && !enablePingHost) continue;
    if (name === 'pingHostSide' && !enablePingHostSide) continue;
    streams[name] = createWriteStream(p, 'a');
  }
  return streams;
}
