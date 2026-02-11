import { quantileSorted } from 'simple-statistics';

export function quantile(sortedArr, q) {
  if (!sortedArr.length) return null;
  return quantileSorted(sortedArr, q);
}

export function median(sortedArr) {
  if (!sortedArr.length) return null;
  return quantileSorted(sortedArr, 0.5);
}

export function secondsDiffs(sortedDates) {
  const out = [];
  for (let i = 1; i < sortedDates.length; i += 1) {
    const diff = (sortedDates[i].getTime() - sortedDates[i - 1].getTime()) / 1000;
    if (diff > 0) out.push(diff);
  }
  return out;
}

export function buildTopBins(values, binSizeSec = 30, topN = 3) {
  if (values.length === 0) return [];
  const bins = new Map();
  for (const v of values) {
    const start = Math.floor(v / binSizeSec) * binSizeSec;
    bins.set(start, (bins.get(start) || 0) + 1);
  }
  return [...bins.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))
    .slice(0, topN)
    .map(([start, count]) => `${start}-${start + binSizeSec - 1}s:${count}`);
}

export function computePeriodicity(diffsSec, targetsSec, tolerance = 0.2) {
  if (diffsSec.length === 0) {
    return {
      bestTargetSec: null,
      bestRatio: 0,
      byTarget: {}
    };
  }
  const byTarget = {};
  let bestTargetSec = null;
  let bestRatio = -1;
  for (const target of targetsSec) {
    const low = target * (1 - tolerance);
    const high = target * (1 + tolerance);
    const hits = diffsSec.filter((v) => v >= low && v <= high).length;
    const ratio = hits / diffsSec.length;
    byTarget[target] = { hits, total: diffsSec.length, ratio };
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestTargetSec = target;
    }
  }
  return { bestTargetSec, bestRatio, byTarget };
}

export function lowerBound(arr, target) {
  let l = 0;
  let r = arr.length;
  while (l < r) {
    const mid = (l + r) >> 1;
    if (arr[mid] < target) l = mid + 1;
    else r = mid;
  }
  return l;
}

export function countInRange(sortedArr, start, end) {
  if (!sortedArr.length || end < start) return 0;
  const i = lowerBound(sortedArr, start);
  const j = lowerBound(sortedArr, end + 1);
  return Math.max(0, j - i);
}
