const DUMPSYS_SERVICE_NOISE_REGEX = /\bdumpsys\s*:\s*.*\bservicename:\s*(wifi|connectivity|deviceidle|power|alarm|jobscheduler)\b/i;
const DUMPSYS_BINDER_INIT_NOISE_REGEX = /\bdumpsys\s*:.*(?:BBinder_init|Thread Pool max thread count is 0)/i;
const APP_PRECONNECT_POLL_NOISE_REGEX = /com\.limelight\.LimeLog: (?:Starting parallel poll|Starting poll thread|Polling .*TimeoutConfig\{)/i;
const NON_WIFI_ROAM_NOISE_REGEX = /(roam_msg_mgr|group_roam_msg_worker|ntkernel)/i;
const ROAM_STRONG_REGEX = /(reassoc|association|bssid.*change|roam(?:ing)?\s+(to|from|candidate|start|complete|fail|failure))/i;
const ROAM_CONTEXT_REGEX = /(wifi|wlan|supplicant|wificlientmodeimpl|wifinative|networkagent|connectivityservice|networkmonitor|bssid)/i;
const DOZE_IDLE_SYSTEM_CONTEXT_REGEX = /(deviceidlecontroller|powermanagerservice|deviceidlejobscontroller|idle maintenance|idle mode changed|doze)/i;
const NETWORK_CONTEXT_REGEX = /(wifi|wlan|supplicant|connectivity|networkagent|networkmonitor|linkproperties|dhcp|captive|portal|route|ip address|wificlientmodeimpl|wifinative|bssid)/i;

export function getLineFilterReason(line) {
  if (DUMPSYS_SERVICE_NOISE_REGEX.test(line)) return 'dumpsys_service_noise';
  if (DUMPSYS_BINDER_INIT_NOISE_REGEX.test(line)) return 'dumpsys_binder_init_noise';
  if (APP_PRECONNECT_POLL_NOISE_REGEX.test(line)) return 'app_preconnect_poll_noise';
  return null;
}

export function classifyLogcatLine(line) {
  const lower = line.toLowerCase();
  const types = new Set();

  if (/(startscan|scan_results|scanresults|\bpno\b|wifi_scan|\bscan\b)/i.test(lower)) types.add('SCAN');
  const hasRoamToken = /(roam|roaming|reassoc|bssid.*change|association)/i.test(lower);
  if (hasRoamToken && !NON_WIFI_ROAM_NOISE_REGEX.test(lower)) {
    const roamingFieldOnly = /\broaming\s*:\s*(false|0|true|1)\b/i.test(lower);
    if (!roamingFieldOnly && (ROAM_STRONG_REGEX.test(lower) || ROAM_CONTEXT_REGEX.test(lower))) {
      types.add('ROAM');
    }
  }
  if (/(disconnect|disconnected|deauth)/i.test(lower) && NETWORK_CONTEXT_REGEX.test(lower)) types.add('DISCONNECT');
  if (/(^|[^a-z])(connected|completed)([^a-z]|$)|network agent.*connected|supplicant state.*completed/i.test(lower) && NETWORK_CONTEXT_REGEX.test(lower)) types.add('CONNECT');
  if (/(dhcp|lease|renew|ip address|linkproperties)/i.test(lower) && NETWORK_CONTEXT_REGEX.test(lower)) types.add('DHCP');
  if (/\brssi\b/i.test(lower)) types.add('RSSI_CHANGE');
  if (/(link speed|tx rate|rx rate)/i.test(lower)) types.add('LINK_SPEED_CHANGE');
  if (/(networkmonitor|validation)/i.test(lower)) types.add('VALIDATION');
  if (/(captive|portal)/i.test(lower)) types.add('CAPTIVE_PORTAL');

  const hasDozeToken = /(deviceidle|doze)/i.test(lower);
  const hasIdleToken = /(idle mode|light idle|deep idle|deviceidle)/i.test(lower);
  const hasDozeIdleSystemContext = DOZE_IDLE_SYSTEM_CONTEXT_REGEX.test(lower);
  const exitHint = /(exit|exited|leave|leaving|active|wake|wakeup|disabled|off)/i.test(lower);
  const enterHint = /(enter|entered|start|starting|enabled|on|idle|deep|light)/i.test(lower);

  if (hasDozeToken && hasDozeIdleSystemContext) {
    if (exitHint) types.add('DOZE_EXIT');
    else if (enterHint) types.add('DOZE_ENTER');
  }
  if (hasIdleToken && hasDozeIdleSystemContext) {
    if (exitHint) types.add('IDLE_EXIT');
    else if (enterHint) types.add('IDLE_ENTER');
  }

  if (/(battery saver|power save|setpowersavemode)/i.test(lower)) {
    if (/(off|false|disabled)\b/.test(lower)) types.add('BATTERY_SAVER_OFF');
    else if (/(on|true|enabled)\b/.test(lower)) types.add('BATTERY_SAVER_ON');
  }
  return [...types];
}
