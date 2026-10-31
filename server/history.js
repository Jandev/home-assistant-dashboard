import { power, localDate, midnight, addDays } from './utils.js';

// Time-weighted average power: frequent state updates do not receive extra weight.
export function powerColumns(rows, start, end, period) {
  const first = Date.parse(start), last = Date.parse(end), buckets = new Map();
  const sorted = [...rows].sort((a, b) => Date.parse(a.last_changed || a.last_updated) - Date.parse(b.last_changed || b.last_updated));
  for (let i = 0; i < sorted.length; i++) {
    const value = power(sorted[i]);
    if (value === null) continue;
    let cursor = Math.max(first, Date.parse(sorted[i].last_changed || sorted[i].last_updated));
    const until = Math.min(last, i + 1 < sorted.length ? Date.parse(sorted[i + 1].last_changed || sorted[i + 1].last_updated) : last);
    while (cursor < until) {
      const day = localDate(new Date(cursor));
      const bucketStart = period === 'day' ? Math.floor(cursor / 3600000) * 3600000 : Date.parse(midnight(day));
      const boundary = period === 'day' ? bucketStart + 3600000 : Date.parse(midnight(addDays(day, 1)));
      const duration = Math.min(boundary, until) - cursor;
      const bucket = buckets.get(bucketStart) || { sum: 0, duration: 0 };
      bucket.sum += value * duration; bucket.duration += duration;
      buckets.set(bucketStart, bucket); cursor += duration;
    }
  }
  return [...buckets].sort(([a], [b]) => a - b).map(([time, b]) => ({ time: new Date(time).toISOString(), value: b.sum / b.duration, seconds: b.duration / 1000 }));
}
