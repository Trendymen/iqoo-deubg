import fs from 'node:fs';
import readline from 'node:readline';

function parseKV(segment) {
  const out = {};
  const re = /([a-zA-Z0-9_]+)=([^\s]+)/g;
  let m;
  while ((m = re.exec(segment)) !== null) out[m[1]] = m[2];
  return out;
}

export async function parseSnapshotFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const snapshots = [];
  const input = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let cur = null;
  for await (const line of rl) {
    if (line.startsWith('### SNAPSHOT START')) {
      const kv = parseKV(line);
      cur = {
        hostTs: kv.host_ts || '',
        task: kv.task || '',
        status: kv.status || '',
        durationMs: Number(kv.duration_ms || 0),
        bodyLines: []
      };
      continue;
    }
    if (line.startsWith('### SNAPSHOT END')) {
      if (cur) snapshots.push(cur);
      cur = null;
      continue;
    }
    if (cur) cur.bodyLines.push(line);
  }
  return snapshots;
}

function parseBoolToken(v) {
  if (v == null) return null;
  const t = String(v).trim().toLowerCase();
  if (['1', 'true', 'on', 'enabled', 'yes'].includes(t)) return true;
  if (['0', 'false', 'off', 'disabled', 'no'].includes(t)) return false;
  return null;
}

function findFirstMatch(text, regexes) {
  for (const re of regexes) {
    const m = text.match(re);
    if (m && m[1] != null) return m[1];
  }
  return null;
}

export function parseDeviceIdleState(bodyText) {
  const mState = findFirstMatch(bodyText, [/mState\s*=\s*([A-Za-z0-9_]+)/i, /\bstate\s*[:=]\s*([A-Za-z0-9_]+)/i]);
  const mLight = findFirstMatch(bodyText, [/mLightState\s*=\s*([A-Za-z0-9_]+)/i, /light[^:\n]*state\s*[:=]\s*([A-Za-z0-9_]+)/i]);
  const mDeep = findFirstMatch(bodyText, [/mDeepState\s*=\s*([A-Za-z0-9_]+)/i, /deep[^:\n]*state\s*[:=]\s*([A-Za-z0-9_]+)/i]);
  const boolLightIdle = parseBoolToken(findFirstMatch(bodyText, [/mLightDeviceIdleMode\s*=\s*(true|false|1|0)/i]));
  const boolDeepIdle = parseBoolToken(findFirstMatch(bodyText, [/mDeviceIdleMode\s*=\s*(true|false|1|0)/i]));

  const tokenList = [mState, mLight, mDeep].filter(Boolean).map((x) => x.toUpperCase());
  const tokenDoze = tokenList.length > 0 ? tokenList.some((t) => /(IDLE|DOZE|SENSING|LOCATING|MAINTENANCE)/.test(t)) : null;
  const tokenIdle = tokenList.length > 0 ? tokenList.some((t) => /(IDLE)/.test(t)) : null;

  const dozeOn = boolDeepIdle != null ? boolDeepIdle : (tokenDoze != null ? tokenDoze : null);
  const idleOn = boolLightIdle != null ? boolLightIdle : (tokenIdle != null ? tokenIdle : null);
  if (dozeOn == null && idleOn == null) return null;
  return { dozeOn, idleOn, mState, mLight, mDeep };
}

export function parsePowerState(bodyText) {
  const bs = findFirstMatch(bodyText, [
    /mBatterySaverEnabled\s*=\s*(true|false|1|0)/i,
    /battery saver[^:\n]*[:=]\s*(on|off|enabled|disabled|true|false|1|0)/i,
    /power save[^:\n]*[:=]\s*(on|off|enabled|disabled|true|false|1|0)/i
  ]);
  const batterySaverOn = parseBoolToken(bs);

  const dozeMode = parseBoolToken(findFirstMatch(bodyText, [/mDeviceIdleMode\s*=\s*(true|false|1|0)/i, /\bdevice idle mode\s*[:=]\s*(true|false|1|0)/i]));
  const idleMode = parseBoolToken(findFirstMatch(bodyText, [/mLightDeviceIdleMode\s*=\s*(true|false|1|0)/i, /\blight device idle mode\s*[:=]\s*(true|false|1|0)/i]));

  if (batterySaverOn == null && dozeMode == null && idleMode == null) return null;
  return { batterySaverOn, dozeMode, idleMode };
}
