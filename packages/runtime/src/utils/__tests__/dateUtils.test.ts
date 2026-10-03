// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { formatMessageTime, formatTurnFinishedAt } from '../dateUtils';

describe('formatTurnFinishedAt', () => {
  it('shows only the time for turns that ended earlier today', () => {
    const turnEndedAt = new Date(2026, 4, 6, 10, 33, 0);
    const reference = new Date(2026, 4, 6, 16, 0, 0);

    expect(formatTurnFinishedAt(turnEndedAt, reference)).toBe('at 10:33 am');
  });

  it('still shows the time for a turn that just ended', () => {
    const turnEndedAt = new Date(2026, 4, 6, 10, 33, 0);
    const reference = new Date(2026, 4, 6, 10, 38, 0);

    expect(formatTurnFinishedAt(turnEndedAt, reference)).toBe('at 10:33 am');
  });

  it('returns nothing when the timestamp cannot be parsed', () => {
    expect(formatTurnFinishedAt(null, new Date(2026, 4, 6, 16, 0, 0))).toBe('');
    expect(formatTurnFinishedAt('not a date', new Date(2026, 4, 6, 16, 0, 0))).toBe('');
  });

  it('shows the full date for turns that ended on a prior day', () => {
    const turnEndedAt = new Date(2026, 4, 5, 10, 33, 0);
    const reference = new Date(2026, 4, 6, 16, 0, 0);

    expect(formatTurnFinishedAt(turnEndedAt, reference)).toBe('at 10:33 am, Tue May 5th, 2026');
  });

  it('formats ordinal suffixes correctly for teen dates', () => {
    const turnEndedAt = new Date(2026, 4, 13, 10, 33, 0);
    const reference = new Date(2026, 4, 14, 16, 0, 0);

    expect(formatTurnFinishedAt(turnEndedAt, reference)).toBe('at 10:33 am, Wed May 13th, 2026');
  });
});

describe('formatMessageTime', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it('follows a time zone change made while the app is running', () => {
    const sentAt = new Date(Date.UTC(2026, 0, 5, 12, 0, 0));
    const options = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } as const;

    process.env.TZ = 'UTC';
    expect(formatMessageTime(sentAt)).toBe(sentAt.toLocaleString(undefined, options));

    process.env.TZ = 'America/New_York';
    expect(formatMessageTime(sentAt)).toBe(sentAt.toLocaleString(undefined, options));
  });

  it('tells apart zones whose offset matches on the formatted date', () => {
    const options = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } as const;
    const winter = new Date(Date.UTC(2026, 0, 6, 12, 0, 0));
    const summer = new Date(Date.UTC(2026, 6, 1, 12, 0, 0));

    // Berlin in winter and London in summer are both UTC+1.
    process.env.TZ = 'Europe/Berlin';
    expect(formatMessageTime(winter)).toBe(winter.toLocaleString(undefined, options));

    process.env.TZ = 'Europe/London';
    expect(formatMessageTime(summer)).toBe(summer.toLocaleString(undefined, options));
  });
});
