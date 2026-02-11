import { parseIsoDateSafe } from '../shared/time.js';
import { parseSnapshotFile, parseDeviceIdleState, parsePowerState } from './snapshot-parser.js';

export async function addDeviceIdleTransitions(deviceidleFile, store) {
  const snaps = await parseSnapshotFile(deviceidleFile);
  let prev = null;
  for (const s of snaps) {
    if (s.status !== 'OK') continue;
    const ts = parseIsoDateSafe(s.hostTs);
    if (!ts) continue;
    const cur = parseDeviceIdleState(s.bodyLines.join('\n'));
    if (!cur) continue;
    if (prev) {
      if (prev.dozeOn === false && cur.dozeOn === true) store.addEvent('DOZE_ENTER', ts, 'dumpsys_deviceidle', '[dumpsys deviceidle transition]', 1500);
      if (prev.dozeOn === true && cur.dozeOn === false) store.addEvent('DOZE_EXIT', ts, 'dumpsys_deviceidle', '[dumpsys deviceidle transition]', 1500);
      if (prev.idleOn === false && cur.idleOn === true) store.addEvent('IDLE_ENTER', ts, 'dumpsys_deviceidle', '[dumpsys deviceidle transition]', 1500);
      if (prev.idleOn === true && cur.idleOn === false) store.addEvent('IDLE_EXIT', ts, 'dumpsys_deviceidle', '[dumpsys deviceidle transition]', 1500);
    }
    prev = cur;
  }
}

export async function addPowerTransitions(powerFile, store) {
  const snaps = await parseSnapshotFile(powerFile);
  let prev = null;
  for (const s of snaps) {
    if (s.status !== 'OK') continue;
    const ts = parseIsoDateSafe(s.hostTs);
    if (!ts) continue;
    const cur = parsePowerState(s.bodyLines.join('\n'));
    if (!cur) continue;
    if (prev) {
      if (prev.batterySaverOn === false && cur.batterySaverOn === true) store.addEvent('BATTERY_SAVER_ON', ts, 'dumpsys_power', '[dumpsys power transition]', 1500);
      if (prev.batterySaverOn === true && cur.batterySaverOn === false) store.addEvent('BATTERY_SAVER_OFF', ts, 'dumpsys_power', '[dumpsys power transition]', 1500);
      if (prev.dozeMode === false && cur.dozeMode === true) store.addEvent('DOZE_ENTER', ts, 'dumpsys_power', '[dumpsys power transition]', 1500);
      if (prev.dozeMode === true && cur.dozeMode === false) store.addEvent('DOZE_EXIT', ts, 'dumpsys_power', '[dumpsys power transition]', 1500);
      if (prev.idleMode === false && cur.idleMode === true) store.addEvent('IDLE_ENTER', ts, 'dumpsys_power', '[dumpsys power transition]', 1500);
      if (prev.idleMode === true && cur.idleMode === false) store.addEvent('IDLE_EXIT', ts, 'dumpsys_power', '[dumpsys power transition]', 1500);
    }
    prev = cur;
  }
}
