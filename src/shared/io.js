import fs from 'node:fs';
import fsExtra from 'fs-extra';

const { ensureDirSync, pathExistsSync, readJsonSync, writeJsonSync } = fsExtra;

export function ensureDir(dirPath) {
  ensureDirSync(dirPath);
}

export function sanitizeDetail(text) {
  return String(text || '').replace(/\s+/g, '_').slice(0, 240);
}

export function appendSnapshot(stream, { taskName, status, durationMs, detail = '', payload = '', hostTs = null }) {
  const ts = hostTs || new Date().toISOString();
  stream.write(`### SNAPSHOT START host_ts=${ts} task=${taskName} status=${status} duration_ms=${durationMs}${detail ? ` detail=${sanitizeDetail(detail)}` : ''}\n`);
  if (payload && payload.trim()) {
    stream.write(payload.endsWith('\n') ? payload : `${payload}\n`);
  } else {
    stream.write('[no output]\n');
  }
  stream.write('### SNAPSHOT END\n\n');
}

export function closeStream(stream) {
  return new Promise((resolve) => {
    stream.end(() => resolve());
  });
}

export async function closeStreams(streamMap) {
  await Promise.all(Object.values(streamMap).map((s) => closeStream(s)));
}

export function writeJson(filePath, obj) {
  writeJsonSync(filePath, obj, { spaces: 2 });
}

export function readJsonIfExists(filePath) {
  if (!pathExistsSync(filePath)) return null;
  return readJsonSync(filePath);
}

export function fileExists(filePath) {
  return pathExistsSync(filePath);
}

export function createWriteStream(filePath, flags = 'a') {
  return fs.createWriteStream(filePath, { flags });
}
