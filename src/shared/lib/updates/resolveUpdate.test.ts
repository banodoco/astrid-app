import { describe, expect, it } from 'vitest';
import { installTypeOf, resolveUpdate } from './resolveUpdate.ts';

describe('installTypeOf', () => {
  it('takes source from the Runtime identity, after the Pinokio and fully-local modes', () => {
    expect(installTypeOf('source', {})).toBe('source');
    expect(installTypeOf('source', { managedByPinokio: true })).toBe('pinokio');
    expect(installTypeOf('pinokio', {})).toBe('pinokio');
    expect(installTypeOf('source', { local: true })).toBe('fully-local');
    expect(installTypeOf(null, {})).toBe('installer');
    expect(installTypeOf(undefined, { originless: true })).toBe('source');
  });
});

describe('resolveUpdate', () => {
  it.each([
    ['busy', 'Astrid is busy. Wait for the current operation to finish before trying again.'],
    ['autostart-off', 'Automatic startup is off. Turn it on before updating Astrid here.'],
    ['unsupported-service-manager', 'In-app updates require user systemd 254 or newer on Linux.'],
  ] as const)('maps the %s refusal reason to its exact explanation without an action', (updateReason, body) => {
    expect(resolveUpdate({ installType: 'installer', updateReason, releaseBehind: true, updateNowAvailable: false })).toMatchObject({
      card: 'notice', body, primary: null, secondary: null, updateReason,
    });
  });

  it('offers only the normal Update action for recovery-needed', () => {
    expect(resolveUpdate({ installType: 'installer', updateReason: 'recovery-needed', updateNowAvailable: true })).toMatchObject({
      card: 'update',
      body: 'Astrid needs recovery. Select Update to check the previous operation before continuing.',
      primary: { label: 'Update', execute: 'installer-update' },
      secondary: null,
    });
  });

  it('skips the release rules for a source checkout, which has no release, but keeps its schema action', () => {
    expect(resolveUpdate({ installType: 'source', installedRelease: 0, requiredRelease: 5, requiredReason: 'security fix' })).toMatchObject({ card: 'none', primary: null });
    expect(resolveUpdate({ installType: 'source', installedRelease: 0, servedRelease: 5, releaseBehind: true })).toMatchObject({ card: 'none', primary: null });
    expect(resolveUpdate({ installType: 'source', installedRelease: 6, servedRelease: 5 })).toMatchObject({ card: 'none', primary: null });
    expect(resolveUpdate({ installType: 'source', installedRelease: 0, requiredRelease: 5, compatibility: { kind: 'schema', detail: 'digest mismatch' } }))
      .toMatchObject({ card: 'update', primary: { label: 'update your checkouts' } });
  });

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
    expect(resolveUpdate({ compatibility: { kind: 'schema', detail: 'old' }, installType: 'installer', updateNowAvailable: true }).primary)
      .toEqual({ label: 'Update now', execute: 'installer-update' });
    expect(resolveUpdate({ compatibility: { kind: 'schema', detail: 'old' } })).toMatchObject({
      primary: { label: 'Copy for your agent' }, secondary: { label: 'Run it yourself' },
    });
    expect(resolveUpdate({ compatibility: { kind: 'schema', detail: 'old' }, installType: 'installer', updateNowAvailable: true }).secondary)
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

  it('uses the install command for fully-local guidance and preserves Pinokio routing', () => {
    const schema = { compatibility: { kind: 'schema' as const, detail: 'old' } };
    expect(resolveUpdate({ ...schema, installType: 'fully-local' }, 'settings')).toMatchObject({
      primary: { label: 'Copy for your agent' }, secondary: { label: 'Run it yourself' },
    });
    expect(resolveUpdate({ ...schema, installType: 'fully-local' }, 'settings').secondary).not.toHaveProperty('command');
    expect(resolveUpdate({ releaseBehind: true, installType: 'fully-local' })).toMatchObject({
      primary: { label: 'Copy for your agent' }, secondary: { label: 'Run it yourself' },
    });
    expect(resolveUpdate({ ...schema, installType: 'pinokio' }, 'settings')).toMatchObject({
      primary: { label: 'Update in Pinokio' }, secondary: null,
    });
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
