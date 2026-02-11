export const TASKS = [
  { name: 'wifi', service: 'wifi', intervalMs: 2000, lineLimit: 200, outFile: 'dumpsys_wifi.log' },
  { name: 'connectivity', service: 'connectivity', intervalMs: 10000, lineLimit: 260, outFile: 'dumpsys_conn.log' },
  { name: 'deviceidle', service: 'deviceidle', intervalMs: 10000, lineLimit: 320, outFile: 'dumpsys_deviceidle.log' },
  { name: 'power', service: 'power', intervalMs: 10000, lineLimit: 320, outFile: 'dumpsys_power.log' },
  { name: 'alarm', service: 'alarm', intervalMs: 30000, lineLimit: 320, outFile: 'dumpsys_alarm.log' },
  { name: 'jobscheduler', service: 'jobscheduler', intervalMs: 30000, lineLimit: 320, outFile: 'dumpsys_jobs.log' }
];

export const TASK_START_OFFSETS_MS = [0, 400, 800, 1200, 1600, 2000];
