import { parseIsoDateSafe } from '../shared/time.js';
import { parseSnapshotFile } from './snapshot-parser.js';

function countMatches(text, regex) {
  return (text.match(regex) || []).length;
}

function parseBool(value) {
  if (value == null) return null;
  const t = String(value).trim().toLowerCase();
  if (t === 'true' || t === '1' || t === 'on' || t === 'enabled') return true;
  if (t === 'false' || t === '0' || t === 'off' || t === 'disabled') return false;
  return null;
}

function parseRelativeDurationMs(raw) {
  if (!raw || raw === '--') return null;
  const sign = raw.startsWith('-') ? -1 : 1;
  let total = 0;
  let matched = false;
  const re = /(\d+)(ms|s|m|h|d)/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    matched = true;
    const value = Number(m[1]);
    const unit = m[2];
    if (!Number.isFinite(value)) continue;
    if (unit === 'ms') total += value;
    if (unit === 's') total += value * 1000;
    if (unit === 'm') total += value * 60 * 1000;
    if (unit === 'h') total += value * 60 * 60 * 1000;
    if (unit === 'd') total += value * 24 * 60 * 60 * 1000;
  }
  if (!matched) return null;
  return total * sign;
}

function extractLatestRoamStamp(bodyText) {
  let last = null;
  const lines = bodyText.split('\n');
  for (const line of lines) {
    if (!/CMD_TRIGGER_ROAMING_RESULT/i.test(line)) continue;
    const m = line.match(/time=([0-9]{2}-[0-9]{2}\s+[0-9:.]+)/i);
    if (m && m[1]) last = m[1];
  }
  return last;
}

function parseWifiState(bodyText) {
  const mode = (bodyText.match(/Current wifi mode:\s*([A-Za-z0-9_]+)/i) || [])[1] || null;
  const explicitEnabled = /Wi-?Fi is enabled/i.test(bodyText);
  const explicitDisabled = /Wi-?Fi is disabled/i.test(bodyText);
  const wifiStateNumRaw = (bodyText.match(/\bWifiState\s+(\d+)/i) || [])[1];
  const wifiStateNum = wifiStateNumRaw == null ? null : Number(wifiStateNumRaw);
  const ifaceRaw = (bodyText.match(/\bmIfaceIsUp:\s*(true|false|1|0)/i) || [])[1];
  const ifaceUp = parseBool(ifaceRaw);

  let wifiOn = null;
  if (explicitEnabled) wifiOn = true;
  else if (explicitDisabled) wifiOn = false;
  else if (mode && /enabled/i.test(mode)) wifiOn = true;
  else if (mode && /disabled/i.test(mode)) wifiOn = false;
  else if (wifiStateNum === 1) wifiOn = true;
  else if (wifiStateNum === 0) wifiOn = false;

  return {
    wifiOn,
    ifaceUp,
    mode,
    roamStamp: extractLatestRoamStamp(bodyText)
  };
}

function parseAlarmState(bodyText) {
  const pendingRaw = (bodyText.match(/\b(\d+)\s+pending alarms:/i) || [])[1];
  const pendingTotal = pendingRaw == null ? null : Number(pendingRaw);
  const wakeupCount = countMatches(bodyText, /\b(?:RTC_WAKEUP|ELAPSED_WAKEUP)\s+#\d+:/g);
  const nextWakeRaw = (bodyText.match(/Next wakeup alarm:\s*([+-][0-9a-z]+)/i) || [])[1] || null;
  const nextWakeupMs = parseRelativeDurationMs(nextWakeRaw);
  return {
    pendingTotal: Number.isFinite(pendingTotal) ? pendingTotal : null,
    wakeupCount,
    nextWakeupMs
  };
}

function parseJobsState(bodyText) {
  const topStartedTrue = countMatches(bodyText, /mEnforcementToTopStartedJobs=\d+\s*:\s*true\b/gi);
  const fgsTrue = countMatches(bodyText, /mEnforcementToFgsJobs=\d+\s*:\s*true\b/gi);
  return { topStartedTrue, fgsTrue };
}

export async function addWifiTransitions(wifiFile, store) {
  const snaps = await parseSnapshotFile(wifiFile);
  let prev = null;
  for (const s of snaps) {
    if (s.status !== 'OK') continue;
    const ts = parseIsoDateSafe(s.hostTs);
    if (!ts) continue;
    const cur = parseWifiState(s.bodyLines.join('\n'));
    if (!cur) continue;
    if (prev) {
      if (prev.wifiOn === false && cur.wifiOn === true) store.addEvent('WIFI_ON', ts, 'dumpsys_wifi', '[dumpsys wifi transition]', 1500);
      if (prev.wifiOn === true && cur.wifiOn === false) store.addEvent('WIFI_OFF', ts, 'dumpsys_wifi', '[dumpsys wifi transition]', 1500);
      if (prev.ifaceUp === false && cur.ifaceUp === true) store.addEvent('WIFI_IFACE_UP', ts, 'dumpsys_wifi', '[dumpsys wifi iface transition]', 1500);
      if (prev.ifaceUp === true && cur.ifaceUp === false) store.addEvent('WIFI_IFACE_DOWN', ts, 'dumpsys_wifi', '[dumpsys wifi iface transition]', 1500);
      if (cur.roamStamp && prev.roamStamp && cur.roamStamp !== prev.roamStamp) {
        store.addEvent('ROAM', ts, 'dumpsys_wifi', `[dumpsys wifi roam update] ${cur.roamStamp}`, 3000);
      }
    }
    prev = cur;
  }
}

export async function addAlarmTransitions(alarmFile, store) {
  const snaps = await parseSnapshotFile(alarmFile);
  let prev = null;
  for (const s of snaps) {
    if (s.status !== 'OK') continue;
    const ts = parseIsoDateSafe(s.hostTs);
    if (!ts) continue;
    const cur = parseAlarmState(s.bodyLines.join('\n'));
    if (!cur) continue;

    if (cur.nextWakeupMs != null && cur.nextWakeupMs <= 5000) {
      store.addEvent('ALARM_WAKEUP_SOON', ts, 'dumpsys_alarm', `[dumpsys alarm next wakeup ${cur.nextWakeupMs}ms]`, 25000);
    }

    if (prev) {
      if (prev.pendingTotal != null && cur.pendingTotal != null) {
        const pendingDelta = cur.pendingTotal - prev.pendingTotal;
        if (pendingDelta >= 8) {
          store.addEvent('ALARM_QUEUE_JUMP', ts, 'dumpsys_alarm', `[dumpsys alarm pending +${pendingDelta}]`, 15000);
        }
      }

      const wakeupDelta = cur.wakeupCount - prev.wakeupCount;
      if (wakeupDelta >= 3) {
        store.addEvent('ALARM_WAKEUP_BURST', ts, 'dumpsys_alarm', `[dumpsys alarm wakeup +${wakeupDelta}]`, 15000);
      }

      if (prev.nextWakeupMs != null && cur.nextWakeupMs != null && prev.nextWakeupMs > 30000 && cur.nextWakeupMs <= 30000) {
        store.addEvent('ALARM_WAKEUP_SOON', ts, 'dumpsys_alarm', `[dumpsys alarm next wakeup ${cur.nextWakeupMs}ms]`, 15000);
      }
    }
    prev = cur;
  }
}

export async function addJobsTransitions(jobsFile, store) {
  const snaps = await parseSnapshotFile(jobsFile);
  let prev = null;
  for (const s of snaps) {
    if (s.status !== 'OK') continue;
    const ts = parseIsoDateSafe(s.hostTs);
    if (!ts) continue;
    const cur = parseJobsState(s.bodyLines.join('\n'));
    if (!cur) continue;
    if (prev) {
      const prevTrue = prev.topStartedTrue + prev.fgsTrue;
      const curTrue = cur.topStartedTrue + cur.fgsTrue;
      if (curTrue > prevTrue) {
        store.addEvent('JOB_ACTIVE_SPIKE', ts, 'dumpsys_jobs', `[dumpsys jobs active +${curTrue - prevTrue}]`, 15000);
      }
    }
    prev = cur;
  }
}
