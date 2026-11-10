import { describe, expect, it } from 'vitest';
import { locationForTimeZone, utcOffsetHours, zonedHours } from './publicAstridLocation';
import { skyDarknessAt, sunTimes } from './publicAstridSkyRender';

const hm = (hours: number, minutes: number) => hours + minutes / 60;
const at = (iso: string) => new Date(iso);

describe('the visitor\'s real sky', () => {
  it('places a visitor from their time zone, including the hemisphere for unlisted zones', () => {
    expect(locationForTimeZone('Europe/London')).toMatchObject({ name: 'London', latitude: 51.51 });
    expect(locationForTimeZone('Australia/Lord_Howe').latitude).toBeLessThan(0);
    // Unlisted zones take their longitude from the UTC offset at `at`. Pin a summer date: in winter
    // Winnipeg is on CST (UTC-6), so an unpinned clock made this check depend on the day it ran.
    expect(locationForTimeZone('America/Winnipeg', at('2026-07-01T12:00:00Z')).longitude).toBeCloseTo(-75, -1);
  });

  it('reads wall-clock time and UTC offsets for a place', () => {
    expect(utcOffsetHours(at('2026-07-01T12:00:00Z'), 'Europe/London')).toBe(1);
    expect(utcOffsetHours(at('2026-01-01T12:00:00Z'), 'Europe/London')).toBe(0);
    expect(zonedHours(at('2026-10-01T09:30:00Z'), 'Asia/Tokyo')).toBeCloseTo(18.5);
  });

  // Reference times from the astral library for the same coordinates, 1 October 2026 unless stated;
  // within five minutes.
  const cases: ReadonlyArray<readonly [string, string, number, number]> = [
    ['Europe/London', '2026-10-01T12:00:00Z', hm(7, 1), hm(18, 38)],
    ['America/New_York', '2026-10-01T16:00:00Z', hm(6, 52), hm(18, 37)],
    ['Asia/Singapore', '2026-10-01T04:00:00Z', hm(6, 51), hm(18, 57)],
    ['Australia/Sydney', '2026-10-01T02:00:00Z', hm(5, 33), hm(17, 57)],
    ['Europe/Oslo', '2026-12-21T11:00:00Z', hm(9, 18), hm(15, 11)],
  ];
  it.each(cases)('gets sunrise and sunset right in %s', (zone, iso, sunrise, sunset) => {
    const times = sunTimes(at(iso), locationForTimeZone(zone));
    expect(Math.abs(times.sunrise - sunrise)).toBeLessThan(5 / 60);
    expect(Math.abs(times.sunset - sunset)).toBeLessThan(5 / 60);
  });

  it('handles polar night and the lower winter sun', () => {
    const arctic = { timeZone: 'Europe/Oslo', name: 'Tromsø', latitude: 69.65, longitude: 18.96 };
    const winter = sunTimes(at('2026-12-21T11:00:00Z'), arctic);
    expect(winter.sunrise).toBe(winter.sunset);
    const oslo = locationForTimeZone('Europe/Oslo');
    expect(sunTimes(at('2026-12-21T11:00:00Z'), oslo).peak!).toBeLessThan(sunTimes(at('2026-06-21T11:00:00Z'), oslo).peak!);
  });

  it('is dark in Sydney while it is midday in London', () => {
    const londonNoon = at('2026-10-01T11:00:00Z');
    expect(skyDarknessAt(londonNoon, locationForTimeZone('Europe/London'))).toBe(0);
    expect(skyDarknessAt(londonNoon, locationForTimeZone('Australia/Sydney'))).toBe(1);
  });
});
