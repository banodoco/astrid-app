import { describe, expect, it } from 'vitest';
import { resolveUpdate } from './resolveUpdate.ts';

describe('resolveUpdate', () => {
  it('uses K6 first-match precedence for unavailable, stale, identity, newer, schema, required, soft and real errors', () => {
    expect(resolveUpdate({ runtime: 'unreachable' }).card).toBe('not-running');
    expect(resolveUpdate({ pageStale: true, compatibility: { kind: 'schema', detail: 'old' } }).card).toBe('reload');
    expect(resolveUpdate({ compatibility: { kind: 'identity', detail: 'wrong owner' } }).card).toBe('identity');
    expect(resolveUpdate({ installedRelease: 5, servedRelease: 4, compatibility: { kind: 'schema', detail: 'old' } }).card).toBe('newer');
    expect(resolveUpdate({ compatibility: { kind: 'schema', detail: 'digest mismatch' } })).toMatchObject({ card: 'update', title: 'Update Astrid' });
    expect(resolveUpdate({ installedRelease: 1, requiredRelease: 2, requiredReason: 'security fix' })).toMatchObject({ card: 'update', body: 'This update is required: security fix' });
    expect(resolveUpdate({ releaseBehind: true })).toMatchObject({ card: 'notice', title: 'Update available' });
    expect(resolveUpdate({ compatibility: { kind: 'capability', detail: 'missing feature' } })).toMatchObject({ card: 'error', primary: null });
  });

  it('routes update actions to Settings and prefers in-app update when it is available', () => {
    expect(resolveUpdate({ compatibility: { kind: 'schema', detail: 'old' }, updateNowAvailable: true }).primary)
      .toEqual({ label: 'Update now', destination: 'settings-updates' });
    expect(resolveUpdate({ compatibility: { kind: 'schema', detail: 'old' } })).toMatchObject({
      primary: { label: 'Copy for your agent' }, secondary: { label: 'Run it yourself' },
    });
    expect(resolveUpdate({ compatibility: { kind: 'schema', detail: 'old' }, updateNowAvailable: true }).secondary)
      .toEqual({ label: 'Copy for your agent' });
    expect(resolveUpdate({ compatibility: { kind: 'schema', detail: 'old' }, installType: 'pinokio' }).primary)
      .toEqual({ label: 'Update in Pinokio' });
    expect(resolveUpdate({ compatibility: { kind: 'schema', detail: 'old' }, installType: 'source' }).primary)
      .toEqual({ label: 'update your checkouts' });
  });

  it('keeps mid-session schema errors on the mounted-editor banner path', () => {
    expect(resolveUpdate({ midSessionSchemaMismatch: true })).toMatchObject({ card: 'mid-session', title: 'Editor updated', primary: { label: 'Copy for your agent' }, secondary: { label: 'Run it yourself' } });
  });

  it('routes soft release actions to Settings on the page and keeps command choices in Settings', () => {
    const status = { releaseBehind: true, installType: 'installer' as const };
    expect(resolveUpdate(status).primary).toEqual({ label: 'Update now', destination: 'settings-updates' });
    expect(resolveUpdate(status, 'settings')).toMatchObject({
      primary: { label: 'Copy for your agent' }, secondary: { label: 'Run it yourself' },
    });
    expect(resolveUpdate({ ...status, installType: 'pinokio' }, 'settings').primary).toEqual({ label: 'Update in Pinokio' });
  });

  it('uses the hard Reload action for a stale page ahead of update states', () => {
    for (const input of [
      { compatibility: { kind: 'schema' as const, detail: 'old schema' } },
      { installedRelease: 1, requiredRelease: 2, requiredReason: 'security fix' },
      { releaseBehind: true },
      { installedRelease: 9, servedRelease: 8 },
    ]) {
      expect(resolveUpdate({ ...input, pageStale: true })).toMatchObject({
        card: 'reload', title: 'Editor updated', primary: { label: 'Reload' }, secondary: null,
      });
    }
    expect(resolveUpdate({ pageStale: true, compatibility: { kind: 'schema', detail: 'old' } }).primary)
      .not.toHaveProperty('destination');
  });
});
