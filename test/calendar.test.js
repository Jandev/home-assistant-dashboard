import test from 'node:test';
import assert from 'node:assert/strict';
import { isUpcoming } from '../public/calendar.js';

const now = new Date('2026-11-01T13:00:00+01:00');
test('agenda toont nog niet begonnen afspraken van vandaag en toekomstige dagen', () => {
  for (const [start, expected] of [
    ['2026-10-31T14:00:00+01:00', false],
    ['2026-11-01T12:59:59+01:00', false],
    ['2026-11-01T13:00:00+01:00', true],
    ['2026-11-01T20:00:00+01:00', true],
    ['2026-11-02T09:00:00+01:00', true],
    ['invalid', false],
  ]) assert.equal(isUpcoming({ start, end: '2026-11-02T18:00:00+01:00' }, now), expected, start);
});
test('dagevenementen gebruiken de exclusieve einddatum', () => {
  for (const [start, end, expected] of [
    ['2026-10-31', '2026-11-01', false],
    ['2026-11-01', '2026-11-02', true],
    ['2026-10-30', '2026-11-03', true],
    ['2026-11-02', '2026-11-03', true],
    ['2026-10-31', undefined, false],
    ['2026-11-01', undefined, true],
    ['2026-11-02', undefined, true],
  ]) assert.equal(isUpcoming({ allDay: true, start, end }, now), expected);
});
test('filter volgt de klok en de Nederlandse daggrens, ook rond zomertijd', () => {
  const event = { start: '2026-11-01T13:00:00+01:00' };
  assert.equal(isUpcoming(event, now), true);
  assert.equal(isUpcoming(event, new Date(now.getTime() + 1000)), false);
  assert.equal(isUpcoming({ allDay: true, start: '2026-11-01', end: '2026-11-02' }, new Date('2026-11-01T23:00:00Z')), false);
  assert.equal(isUpcoming({ start: '2026-03-29T22:30:00Z' }, new Date('2026-03-29T21:00:00Z')), true);
  assert.equal(isUpcoming({ start: '2026-03-29T21:30:00Z' }, new Date('2026-03-29T21:00:00Z')), true);
});
