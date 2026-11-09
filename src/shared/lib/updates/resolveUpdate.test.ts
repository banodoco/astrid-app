import { describe, expect, it } from 'vitest';
import { INSTALLER_UPDATE_REASON_MESSAGES } from '@/integrations/runtime/client.ts';
import { installTypeOf, resolveUpdate, type InstallType, type UpdateResolution, type UpdateResolutionInput } from './resolveUpdate.ts';

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
    ['unsupported-service-manager', 'In-app updates require user systemd 254 or newer on Linux.'],
    ['self-update-unavailable', "Astrid can't update itself on this computer. Run the command below to update it."],
  ] as const)('maps the %s refusal reason to its exact explanation and the command when Update now is not offered', (updateReason, body) => {
    expect(resolveUpdate({ installType: 'installer', updateReason, releaseBehind: true, updateNowAvailable: false })).toMatchObject({
      card: 'notice', body, primary: { label: 'Copy instructions for your agent' }, secondary: { label: 'Run it yourself' }, updateReason,
    });
  });

  it('titles an acknowledgement-unknown notice so the title agrees with its body', () => {
    expect(resolveUpdate({ installType: 'installer', updateReason: 'acknowledgement-unknown', updateNowAvailable: false })).toMatchObject({
      card: 'notice',
      title: 'Update not confirmed yet',
      body: INSTALLER_UPDATE_REASON_MESSAGES['acknowledgement-unknown'],
      updateReason: 'acknowledgement-unknown',
    });
  });

  it('shows a needs-repair recovery as an update card with the command and no in-app Update', () => {
    expect(resolveUpdate({ installType: 'installer', updateReason: 'needs-repair', updateNowAvailable: false })).toMatchObject({
      card: 'update', body: 'Astrid needs repair before it can update.', primary: { label: 'Copy instructions for your agent' }, updateReason: 'needs-repair',
    });
  });

  it('gives a source refusal its own line and no installer command', () => {
    expect(resolveUpdate({ installType: 'installer', updateReason: 'source', updateNowAvailable: false })).toMatchObject({
      card: 'notice', body: 'This Astrid runs from source, so update those checkouts to their main branches and restart Astrid.', primary: null, secondary: null, updateReason: 'source',
    });
  });

  it('shows Update now disabled for a busy refusal, with the busy line and no command', () => {
    expect(resolveUpdate({ installType: 'installer', updateReason: 'busy', updateNowAvailable: true })).toMatchObject({
      card: 'notice', body: 'Astrid is busy. Wait for the current operation to finish before trying again.',
      primary: { label: 'Update now', execute: 'installer-update', disabled: true }, secondary: null, updateReason: 'busy',
    });
  });

  it('gives autostart-off the agent copy action and the manual line, and no Update now', () => {
    expect(resolveUpdate({ installType: 'installer', updateReason: 'autostart-off', updateNowAvailable: false })).toMatchObject({
      card: 'notice', primary: { label: 'Copy instructions for your agent' }, secondary: { label: 'Run it yourself' }, updateReason: 'autostart-off',
    });
  });

  it('offers the command for recovery-needed when Astrid cannot update itself', () => {
    expect(resolveUpdate({ installType: 'installer', updateReason: 'recovery-needed', updateNowAvailable: false })).toMatchObject({
      card: 'update', primary: { label: 'Copy instructions for your agent' }, secondary: { label: 'Run it yourself' },
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
      primary: { label: 'Copy instructions for your agent' }, secondary: { label: 'Run it yourself' },
    });
    expect(resolveUpdate({ compatibility: { kind: 'schema', detail: 'old' }, installType: 'installer', updateNowAvailable: true }).secondary)
      .toEqual({ label: 'Copy instructions for your agent' });
    expect(resolveUpdate({ compatibility: { kind: 'schema', detail: 'old' }, installType: 'pinokio' }).primary)
      .toEqual({ label: 'Update in Pinokio' });
    expect(resolveUpdate({ compatibility: { kind: 'schema', detail: 'old' }, installType: 'source' }).primary)
      .toEqual({ label: 'update your checkouts' });
  });

  it('keeps mid-session schema errors on the mounted-editor banner path', () => {
    expect(resolveUpdate({ midSessionSchemaMismatch: true })).toMatchObject({ card: 'mid-session', title: 'Editor updated', primary: { label: 'Copy instructions for your agent' }, secondary: { label: 'Run it yourself' } });
  });

  it('routes soft release actions to Settings on the page and keeps command choices in Settings', () => {
    const status = { releaseBehind: true, installType: 'installer' as const };
    expect(resolveUpdate(status).primary).toEqual({ label: 'See updates', destination: 'settings-updates' });
    expect(resolveUpdate(status, 'settings')).toMatchObject({
      primary: { label: 'Copy instructions for your agent' }, secondary: { label: 'Run it yourself' },
    });
    expect(resolveUpdate({ ...status, installType: 'pinokio' }, 'settings').primary).toEqual({ label: 'Update in Pinokio' });
  });

  it('gives a fully local install the same actions as every other direct install, with no command of its own', () => {
    const inputs = [
      { compatibility: { kind: 'schema' as const, detail: 'old' } },
      { installedRelease: 3, requiredRelease: 4, requiredReason: 'security fix' },
      { releaseBehind: true },
      { midSessionSchemaMismatch: true },
    ];
    for (const input of inputs) {
      for (const context of ['page', 'settings'] as const) {
        const local = resolveUpdate({ ...input, installType: 'fully-local', updateNowAvailable: false }, context);
        expect(local).toEqual(resolveUpdate({ ...input, installType: 'installer', updateNowAvailable: false }, context));
        for (const action of [local.primary, local.secondary]) expect(action ?? {}).not.toHaveProperty('command');
      }
    }
    // A soft release on the page routes to Settings, as it does for an installer install.
    expect(resolveUpdate({ releaseBehind: true, installType: 'fully-local' }).primary).toEqual({ label: 'See updates', destination: 'settings-updates' });
    expect(resolveUpdate({ compatibility: { kind: 'schema', detail: 'old' }, installType: 'fully-local' }, 'settings')).toMatchObject({
      primary: { label: 'Copy instructions for your agent' }, secondary: { label: 'Run it yourself' },
    });
  });

  it('offers a fully local install Update now only when its status reports self_update, with the command as the secondary', () => {
    for (const context of ['page', 'settings'] as const) {
      const on = resolveUpdate({ releaseBehind: true, installType: 'fully-local', updateNowAvailable: true }, context);
      expect(on.primary).toEqual({ label: 'Update now', execute: 'local-update' });
      expect(on.secondary).toEqual({ label: 'Copy instructions for your agent' });
      const required = resolveUpdate({ installedRelease: 3, requiredRelease: 4, requiredReason: 'fix', installType: 'fully-local', updateNowAvailable: true }, context);
      expect(required.primary).toEqual({ label: 'Update now', execute: 'local-update' });
      const off = resolveUpdate({ releaseBehind: true, installType: 'fully-local', updateNowAvailable: false }, context);
      expect(JSON.stringify(off)).not.toContain('local-update');
    }
  });

  it('gives Pinokio only its own Update, on every card and in both contexts', () => {
    const inputs = [
      { compatibility: { kind: 'schema' as const, detail: 'old' } },
      { installedRelease: 3, requiredRelease: 4, requiredReason: 'security fix' },
      { releaseBehind: true },
      { midSessionSchemaMismatch: true },
      // An installer refusal or recovery reason never turns a Pinokio Astrid into an installer one.
      { releaseBehind: true, updateReason: 'recovery-needed' as const, updateNowAvailable: true },
      { releaseBehind: true, updateReason: 'busy' as const },
    ];
    for (const input of inputs) {
      for (const context of ['page', 'settings'] as const) {
        expect(resolveUpdate({ ...input, installType: 'pinokio' }, context)).toMatchObject({ primary: { label: 'Update in Pinokio' }, secondary: null });
      }
    }
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

/** The UI copy the decision table expects, written out so the table reads as the product's contract. */
const COPY_AGENT = 'Copy instructions for your agent';
const RUN_YOURSELF = 'Run it yourself';
const PINOKIO = 'Update in Pinokio';
const CHECKOUTS = 'update your checkouts';
const INSTALL_TYPES: readonly InstallType[] = ['installer', 'fully-local', 'pinokio', 'source'];

type Situation = 'upToDate' | 'releaseBehind' | 'requiredUpdate' | 'schemaMismatch' | 'midSessionSchema' | 'newer'
  | 'busyRefusal' | 'needsRepair' | 'recoveryNeeded' | 'autostartOffRefusal' | 'sourceRefusal' | 'unknownRefusal'
  | 'newerBusyRefusal' | 'newerNeedsRepair' | 'runtimeDown' | 'pageStale';

/** The status inputs for each situation. Releases 9 and earlier arrive with no self_update, so the table passes updateNowAvailable false. */
const SITUATIONS: Record<Situation, UpdateResolutionInput> = {
  upToDate: { installedRelease: 10, servedRelease: 10 },
  releaseBehind: { installedRelease: 9, servedRelease: 10, releaseBehind: true },
  requiredUpdate: { installedRelease: 9, servedRelease: 10, releaseBehind: true, requiredRelease: 10, requiredReason: 'security fix' },
  schemaMismatch: { installedRelease: 10, servedRelease: 10, compatibility: { kind: 'schema', detail: 'digest mismatch' } },
  midSessionSchema: { installedRelease: 10, servedRelease: 10, midSessionSchemaMismatch: true },
  newer: { installedRelease: 11, servedRelease: 10 },
  busyRefusal: { installedRelease: 10, servedRelease: 10, releaseBehind: true, updateReason: 'busy' },
  needsRepair: { installedRelease: 10, servedRelease: 10, updateReason: 'needs-repair' },
  recoveryNeeded: { installedRelease: 10, servedRelease: 10, updateReason: 'recovery-needed' },
  autostartOffRefusal: { installedRelease: 10, servedRelease: 10, updateReason: 'autostart-off' },
  sourceRefusal: { installedRelease: 10, servedRelease: 10, updateReason: 'source' },
  unknownRefusal: { installedRelease: 10, servedRelease: 10, releaseBehind: true, updateReason: 'self-update-unavailable' },
  // Defect cases: a release newer than served shows no action, whatever the installer reason says.
  newerBusyRefusal: { installedRelease: 11, servedRelease: 10, updateReason: 'busy' },
  newerNeedsRepair: { installedRelease: 11, servedRelease: 10, updateReason: 'needs-repair' },
  runtimeDown: { runtime: 'unreachable' },
  pageStale: { pageStale: true, releaseBehind: true },
};

/** [card, primary label, secondary label] as the surfaces read them. */
type Cell = readonly [UpdateResolution['card'], string | null, string | null];
type Row = { readonly page: Cell; readonly settings: Cell };
const both = (cell: Cell): Row => ({ page: cell, settings: cell });
const NONE: Cell = ['none', null, null];
const NEWER: Cell = ['newer', null, null];
const NOT_RUNNING: Cell = ['not-running', 'Start Astrid', 'Repair'];
const RELOAD: Cell = ['reload', 'Reload', null];
const COMMAND_UPDATE: Cell = ['update', COPY_AGENT, RUN_YOURSELF];
const COMMAND_NOTICE: Cell = ['notice', COPY_AGENT, RUN_YOURSELF];
/** Release behind on the page routes to Settings; Settings shows the direct-install command. */
const SOFT: Row = { page: ['notice', 'See updates', null], settings: ['notice', COPY_AGENT, RUN_YOURSELF] };

/**
 * The decision table: each install type against each situation, on the page and in Settings, with Update now off
 * (what a release 9 status gives). Pinokio and source never carry the installer command; "newer" never carries any action.
 */
const DECISION_TABLE: Record<InstallType, Record<Situation, Row>> = {
  installer: {
    upToDate: both(NONE),
    releaseBehind: SOFT,
    requiredUpdate: both(COMMAND_UPDATE),
    schemaMismatch: both(COMMAND_UPDATE),
    midSessionSchema: both(['mid-session', COPY_AGENT, RUN_YOURSELF]),
    newer: both(NEWER),
    busyRefusal: both(['notice', 'Update now', null]),
    needsRepair: both(COMMAND_UPDATE),
    recoveryNeeded: both(COMMAND_UPDATE),
    newerBusyRefusal: both(NEWER),
    newerNeedsRepair: both(NEWER),
    autostartOffRefusal: both(NONE),
    sourceRefusal: both(['notice', null, null]),
    unknownRefusal: both(COMMAND_NOTICE),
    runtimeDown: both(NOT_RUNNING),
    pageStale: both(RELOAD),
  },
  'fully-local': {
    upToDate: both(NONE),
    releaseBehind: SOFT,
    requiredUpdate: both(COMMAND_UPDATE),
    schemaMismatch: both(COMMAND_UPDATE),
    midSessionSchema: both(['mid-session', COPY_AGENT, RUN_YOURSELF]),
    newer: both(NEWER),
    // Refusal reasons come from the installer status only, so a fully local install follows its release rules.
    busyRefusal: SOFT,
    needsRepair: both(NONE),
    recoveryNeeded: both(NONE),
    newerBusyRefusal: both(NEWER),
    newerNeedsRepair: both(NEWER),
    autostartOffRefusal: both(NONE),
    sourceRefusal: both(['notice', null, null]),
    unknownRefusal: SOFT,
    runtimeDown: both(NOT_RUNNING),
    pageStale: both(RELOAD),
  },
  pinokio: {
    upToDate: both(NONE),
    releaseBehind: both(['notice', PINOKIO, null]),
    requiredUpdate: both(['update', PINOKIO, null]),
    schemaMismatch: both(['update', PINOKIO, null]),
    midSessionSchema: both(['mid-session', PINOKIO, null]),
    newer: both(NEWER),
    busyRefusal: both(['notice', PINOKIO, null]),
    needsRepair: both(NONE),
    recoveryNeeded: both(NONE),
    newerBusyRefusal: both(NEWER),
    newerNeedsRepair: both(NEWER),
    autostartOffRefusal: both(NONE),
    sourceRefusal: both(NONE),
    unknownRefusal: both(['notice', PINOKIO, null]),
    runtimeDown: both(NOT_RUNNING),
    pageStale: both(RELOAD),
  },
  source: {
    upToDate: both(NONE),
    // A source checkout has no release, so the release rules never apply to it.
    releaseBehind: both(NONE),
    requiredUpdate: both(NONE),
    schemaMismatch: both(['update', CHECKOUTS, null]),
    midSessionSchema: both(['mid-session', CHECKOUTS, null]),
    newer: both(NONE),
    busyRefusal: both(NONE),
    needsRepair: both(NONE),
    recoveryNeeded: both(NONE),
    newerBusyRefusal: both(NONE),
    newerNeedsRepair: both(NONE),
    autostartOffRefusal: both(NONE),
    sourceRefusal: both(NONE),
    unknownRefusal: both(NONE),
    runtimeDown: both(NOT_RUNNING),
    pageStale: both(RELOAD),
  },
};

function cellOf(resolution: UpdateResolution): Cell {
  return [resolution.card, resolution.primary?.label ?? null, resolution.secondary?.label ?? null];
}

describe('update decision table: install type × situation', () => {
  it.each(INSTALL_TYPES)('resolves every situation for the %s install type to its card and actions, on the page and in Settings', (installType) => {
    for (const situation of Object.keys(SITUATIONS) as Situation[]) {
      for (const context of ['page', 'settings'] as const) {
        const resolution = resolveUpdate({ ...SITUATIONS[situation], installType, updateNowAvailable: false }, context);
        expect(cellOf(resolution), `${installType} / ${situation} / ${context}`).toEqual(DECISION_TABLE[installType][situation][context]);
      }
    }
  });

  it('never shows an enabled Update now for releases 9 and earlier, which have no self_update', () => {
    for (const installType of ['installer', 'fully-local'] as const) {
      for (const situation of Object.keys(SITUATIONS) as Situation[]) {
        for (const context of ['page', 'settings'] as const) {
          const resolution = resolveUpdate({ ...SITUATIONS[situation], installType, updateNowAvailable: false }, context);
          // A busy installer shows Update now disabled; nothing else shows an enabled one.
          if (resolution.primary?.execute) expect(resolution.primary.disabled, `${installType} / ${situation} / ${context}`).toBe(true);
          else expect(JSON.stringify(resolution), `${installType} / ${situation} / ${context}`).not.toContain('Update now');
        }
      }
    }
  });

  it('enables Update now only when the status reports self_update, on the Settings path, for each install that can update itself', () => {
    const expectedExecute = { installer: 'installer-update', 'fully-local': 'local-update' } as const;
    for (const installType of ['installer', 'fully-local'] as const) {
      for (const situation of ['releaseBehind', 'requiredUpdate', 'schemaMismatch', 'midSessionSchema'] as const) {
        const resolution = resolveUpdate({ ...SITUATIONS[situation], installType, updateNowAvailable: true }, 'settings');
        expect(resolution.primary, `${installType} / ${situation}`).toEqual({ label: 'Update now', execute: expectedExecute[installType] });
        expect(resolution.secondary, `${installType} / ${situation}`).toEqual({ label: COPY_AGENT });
      }
    }
  });

  it('gives Pinokio and source no enabled update action, whatever the status reports, and Pinokio never the installer command', () => {
    for (const installType of ['pinokio', 'source'] as const) {
      for (const situation of Object.keys(SITUATIONS) as Situation[]) {
        for (const updateNowAvailable of [false, true]) {
          for (const context of ['page', 'settings'] as const) {
            const resolution = resolveUpdate({ ...SITUATIONS[situation], installType, updateNowAvailable }, context);
            const labels = [resolution.primary?.label, resolution.secondary?.label];
            const where = `${installType} / ${situation} / ${context} / now=${updateNowAvailable}`;
            expect(resolution.primary?.execute, where).toBeUndefined();
            expect(labels, where).not.toContain('Update now');
            if (installType === 'pinokio') {
              expect(labels, where).not.toContain(COPY_AGENT);
              expect(labels, where).not.toContain(RUN_YOURSELF);
            }
          }
        }
      }
    }
  });

  it('shows no action at all for a version newer than astrid.haus, on every direct or Pinokio install', () => {
    for (const installType of ['installer', 'fully-local', 'pinokio'] as const) {
      for (const updateNowAvailable of [false, true]) {
        for (const context of ['page', 'settings'] as const) {
          const resolution = resolveUpdate({ ...SITUATIONS.newer, installType, updateNowAvailable }, context);
          expect(resolution, `${installType} / now=${updateNowAvailable} / ${context}`).toMatchObject({ card: 'newer', primary: null, secondary: null });
        }
      }
    }
    // A source checkout has no release, so its newer-than-served state is never a card.
    expect(resolveUpdate({ ...SITUATIONS.newer, installType: 'source' }, 'page')).toMatchObject({ card: 'none', primary: null, secondary: null });
  });

  it('suppresses Update now for every installer refusal even when self_update is true, and only recovery-needed starts the update', () => {
    // Busy is the one refusal that keeps Update now visible, disabled; it still starts nothing.
    const refusals = ['needsRepair', 'autostartOffRefusal', 'sourceRefusal', 'unknownRefusal', 'newerBusyRefusal', 'newerNeedsRepair'] as const;
    for (const situation of refusals) {
      for (const context of ['page', 'settings'] as const) {
        const resolution = resolveUpdate({ ...SITUATIONS[situation], installType: 'installer', updateNowAvailable: true }, context);
        expect(cellOf(resolution), `${situation} / ${context}`).toEqual(DECISION_TABLE.installer[situation][context]);
        expect(resolution.primary?.execute, `${situation} / ${context}`).toBeUndefined();
        expect(JSON.stringify(resolution), `${situation} / ${context}`).not.toContain('Update now');
      }
    }
    for (const context of ['page', 'settings'] as const) {
      const busy = resolveUpdate({ ...SITUATIONS.busyRefusal, installType: 'installer', updateNowAvailable: true }, context);
      expect(busy.primary, `busy / ${context}`).toEqual({ label: 'Update now', execute: 'installer-update', disabled: true });
    }
    expect(resolveUpdate({ ...SITUATIONS.recoveryNeeded, installType: 'installer', updateNowAvailable: true }, 'settings').primary)
      .toEqual({ label: 'Update', execute: 'installer-update' });
  });
});

describe('setup refusals on a current install', () => {
  it.each(['autostart-off', 'unsupported-service-manager'] as const)('shows no card for %s when the release is current', (updateReason) => {
    expect(resolveUpdate({ installType: 'installer', installedRelease: 10, servedRelease: 10, updateReason, updateNowAvailable: false })).toMatchObject({
      card: 'none', primary: null, secondary: null,
    });
  });

  it('still shows the setup refusal when a release is behind', () => {
    expect(resolveUpdate({ installType: 'installer', installedRelease: 9, servedRelease: 10, releaseBehind: true, updateReason: 'autostart-off', updateNowAvailable: false })).toMatchObject({
      card: 'notice', updateReason: 'autostart-off',
    });
  });

  it('keeps a recovery on a current install', () => {
    expect(resolveUpdate({ installType: 'installer', installedRelease: 10, servedRelease: 10, updateReason: 'recovery-needed', updateNowAvailable: true })).toMatchObject({
      card: 'update', updateReason: 'recovery-needed',
    });
  });
});

describe('a fully local install that cannot update itself', () => {
  it('shows the source line its launcher reports, with no command', () => {
    expect(resolveUpdate({ installType: 'fully-local', updateReason: 'source', installedRelease: 9, servedRelease: 10, releaseBehind: true })).toMatchObject({
      card: 'notice', body: INSTALLER_UPDATE_REASON_MESSAGES.source, primary: null, secondary: null, updateReason: 'source',
    });
  });
});
