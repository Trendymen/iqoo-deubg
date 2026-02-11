import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';

dayjs.extend(customParseFormat);

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function pad3(n) {
  return String(n).padStart(3, '0');
}

export function formatDirTimestamp(d) {
  return dayjs(d).format('YYYYMMDD_HHmmss');
}

export function formatMinuteKey(d) {
  return dayjs(d).format('YYYY-MM-DD HH:mm');
}

export function formatTs(d) {
  return dayjs(d).format('YYYY-MM-DD HH:mm:ss.SSS');
}

export function parseThreadtimeDate(line, yearHint) {
  const m = line.match(/^(\d{2})-(\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3})/);
  if (!m) return null;
  const text = `${yearHint}-${m[1]}-${m[2]} ${m[3]}`;
  const parsed = dayjs(text, 'YYYY-MM-DD HH:mm:ss.SSS', true);
  if (!parsed.isValid()) return null;
  return parsed.toDate();
}

export function parseIsoDateSafe(text) {
  if (!text) return null;
  const parsed = dayjs(text);
  return parsed.isValid() ? parsed.toDate() : null;
}

export function buildMinuteRange(startDate, endDate) {
  const out = [];
  const cur = dayjs(startDate).second(0).millisecond(0);
  const end = dayjs(endDate).second(0).millisecond(0);
  for (let p = cur; p.isBefore(end) || p.isSame(end); p = p.add(1, 'minute')) {
    out.push(p.toDate());
  }
  return out;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
