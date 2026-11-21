/*
 * Gesture descriptors for the isolated Plan 77 save-loop fixture.
 * Coordinates are derived from rendered clips/tracks; targets come only from
 * the fixture manifest. Destructive rows use a different target each time.
 */

const sleep = (page, ms = 250) => page.waitForTimeout(ms);
const cssValue = (value) => String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
const videoPrimary = (fixture) => fixture.clips?.video?.primary;
const audioPrimary = (fixture) => fixture.clips?.audio?.primary;

function targetId(target) {
  return typeof target === 'string' ? target : target?.clip_id;
}

function targetsFor(fixture, kind) {
  const primary = videoPrimary(fixture);
  const primaryAudio = audioPrimary(fixture);
  if (kind.startsWith('audio-')) {
    return [primaryAudio, ...(fixture.clips?.audio?.additional ?? [])].filter((item) => targetId(item));
  }
  if (kind === 'video-delete' || kind === 'video-split') {
    return [primary, ...(fixture.clips?.video?.repeated_delete_and_split ?? [])].filter((item) => targetId(item));
  }
  return [primary].filter((item) => targetId(item));
}

function assertTarget(target, kind) {
  const id = targetId(target);
  if (!id) throw new Error(`${kind} requires a clip target in the fixture manifest`);
  return id;
}

async function clipRect(page, helpers, id) {
  const rect = await helpers.rect(page, id);
  if (!rect) throw new Error(`fixture clip ${id} is not rendered in the timeline`);
  return rect;
}

async function selectClip(page, helpers, id) {
  const rect = await clipRect(page, helpers, id);
  await page.mouse.click(rect.x + rect.w / 2, rect.y + rect.h / 2);
  await sleep(page);
  return rect;
}

async function dragClipToRow(page, helpers, id, rowId, dx = 0) {
  const rect = await clipRect(page, helpers, id);
  const x = rect.x + rect.w / 2;
  await helpers.drag(page, x, rect.y + rect.h / 2, x + dx, await helpers.rowY(page, rowId));
}

function targetForIteration(targets, iteration, name, minimum = 1) {
  if (targets.length < minimum) {
    throw new Error(`${name} needs ${minimum} fixture targets; found ${targets.length}`);
  }
  return targets[(iteration - 1) % targets.length];
}

const destructive = (kind) => kind.endsWith('-delete') || kind.endsWith('-split');

function verifySaved({ before, after }, name) {
  if (!before || !after) throw new Error(`${name}: recorder did not provide before/after state`);
  const advanced = after.headRevision !== before.headRevision || after.revision !== before.revision;
  if (!advanced) throw new Error(`${name}: gesture did not advance the saved revision`);
  return {pass:true};
}

function verifyDeleted({ before, after }, name, count) {
  verifySaved({ before, after }, name);
  const removed = before.clipIds.filter((id) => !after.clipIds.includes(id));
  if (removed.length < count) throw new Error(`${name}: expected ${count} removed clip occurrence(s), found ${removed.length}`);
}

function verifySplit({ before, after }, name) {
  verifySaved({ before, after }, name);
  if (after.clipIds.length <= before.clipIds.length) throw new Error(`${name}: split did not add a clip occurrence`);
}

function descriptor({ name, kind, targets, repetitions, perform, verify }) {
  let rowFixture;
  return {
    name,
    expected: 'saved',
    allowRemovals: kind.endsWith('-delete') || kind.endsWith('-split'),
    async gesture({ page, fixture, helpers, iteration, mark }) {
      rowFixture = fixture;
      const allTargets = targets(fixture);
      const target = targetForIteration(allTargets, iteration, name, destructive(kind) ? repetitions : 1);
      for (let index = 0; index < repetitions; index += 1) {
        const item = destructive(kind)
          ? allTargets[index]
          : target;
        await perform({ page, fixture, helpers, item, index, iteration });
        if (index + 1 < repetitions) await sleep(page, 180);
      }
      mark();
    },
    verify: async (state) => {
      if (verify) await verify(state, name, repetitions); else verifySaved(state, name);
      if (kind === 'video-delete' || kind === 'audio-delete') {
        const permitted = new Set(targets(rowFixture).map(targetId));
        const removed = state.before.clipIds.filter(id => !state.after.clipIds.includes(id));
        if (removed.length !== repetitions || removed.some(id => !permitted.has(id)))
          throw new Error(`${name}: removed unexpected clips: ${removed.join(', ')}`);
      }
      return {pass:true};
    },
    cleanup: (context) => context.helpers.restoreScenario(context),
  };
}

function clipScenarios() {
  const matrix = [
    {
      kind: 'video-move-same-track',
      perform: async ({ page, helpers, item, index }) => {
        const id = assertTarget(item, 'video move');
        const rect = await clipRect(page, helpers, id);
        const delta = Math.max(18, Math.min(64, rect.w * 0.08)) * (index % 2 ? -0.5 : 1);
        await helpers.drag(page, rect.x + rect.w / 2, rect.y + rect.h / 2, rect.x + rect.w / 2 + delta, rect.y + rect.h / 2);
      },
    },
    {
      kind: 'video-move-cross-track',
      perform: async ({ page, helpers, fixture, item }) => {
        const id = assertTarget(item, 'video cross-track move');
        const current = await page.locator(`[data-clip-id="${id}"]`).first().getAttribute('data-row-id');
        const rows = fixture.tracks?.visual ?? [];
        const destination = rows.find((track) => track.id !== current)?.id;
        if (!destination) throw new Error('video cross-track move needs two visual tracks in the fixture manifest');
        await dragClipToRow(page, helpers, id, destination);
      },
    },
    {
      kind: 'video-keyboard-track-move',
      perform: async ({ page, helpers, item, index }) => {
        await selectClip(page, helpers, assertTarget(item, 'keyboard track move'));
        await page.keyboard.press(index % 2 ? 'ArrowUp' : 'ArrowDown');
      },
    },
    {
      kind: 'video-keyboard-nudge',
      perform: async ({ page, helpers, item, index }) => {
        await selectClip(page, helpers, assertTarget(item, 'keyboard nudge'));
        await page.keyboard.press(index % 2 ? 'Alt+ArrowLeft' : 'Alt+ArrowRight');
      },
    },
    ...['left', 'right'].map((side) => ({
      kind: `video-trim-${side}`,
      perform: async ({ page, helpers, item }) => {
        const rect = await clipRect(page, helpers, assertTarget(item, `video ${side} trim`));
        const x = side === 'left' ? rect.x + 2 : rect.x + rect.w - 2;
        const delta = Math.max(8, Math.min(28, rect.w * 0.06)) * (side === 'left' ? 1 : -1);
        await helpers.drag(page, x, rect.y + rect.h / 2, x + delta, rect.y + rect.h / 2);
      },
    })),
    {
      kind: 'video-split',
      verify: verifySplit,
      perform: async ({ page, helpers, item }) => {
        const rect = await selectClip(page, helpers, assertTarget(item, 'video split'));
        const ruler = page.getByTestId('timeline-ruler');
        const box = await ruler.boundingBox();
        if (!box) throw new Error('timeline ruler is not rendered for split gesture');
        await page.mouse.click(rect.x + rect.w / 2, box.y + box.height / 2);
        await page.keyboard.press('s');
      },
    },
    {
      kind: 'video-mute',
      perform: async ({ page, helpers, item }) => {
        await selectClip(page, helpers, assertTarget(item, 'video mute'));
        await page.keyboard.press('m');
      },
    },
    {
      kind: 'video-delete',
      verify: verifyDeleted,
      perform: async ({ page, helpers, item }) => {
        await selectClip(page, helpers, assertTarget(item, 'video delete'));
        await page.keyboard.press('Delete');
      },
    },
    {
      kind: 'audio-move-same-track',
      perform: async ({ page, helpers, item, index }) => {
        const rect = await clipRect(page, helpers, assertTarget(item, 'audio move'));
        const delta = Math.max(16, Math.min(56, rect.w * 0.07)) * (index % 2 ? -0.5 : 1);
        await helpers.drag(page, rect.x + rect.w / 2, rect.y + rect.h / 2, rect.x + rect.w / 2 + delta, rect.y + rect.h / 2);
      },
    },
    {
      kind: 'audio-trim-right',
      perform: async ({ page, helpers, item }) => {
        const rect = await clipRect(page, helpers, assertTarget(item, 'audio trim'));
        const delta = Math.max(8, Math.min(24, rect.w * 0.05));
        await helpers.drag(page, rect.x + rect.w - 2, rect.y + rect.h / 2, rect.x + rect.w - 2 - delta, rect.y + rect.h / 2);
      },
    },
    {
      kind: 'audio-mute',
      perform: async ({ page, helpers, item }) => {
        await selectClip(page, helpers, assertTarget(item, 'audio mute'));
        await page.keyboard.press('m');
      },
    },
    {
      kind: 'audio-delete',
      verify: verifyDeleted,
      perform: async ({ page, helpers, item }) => {
        await selectClip(page, helpers, assertTarget(item, 'audio delete'));
        await page.keyboard.press('Delete');
      },
    },
    {
      kind: 'audio-move-cross-track',
      perform: async ({ page, helpers, fixture, item }) => {
        const id = assertTarget(item, 'audio cross-track move');
        const current = await page.locator(`[data-clip-id="${id}"]`).first().getAttribute('data-row-id');
        const destination = (fixture.tracks?.audio ?? []).find((track) => track.id !== current)?.id;
        if (!destination) throw new Error('audio cross-track move needs two audio tracks in the fixture manifest');
        await dragClipToRow(page, helpers, id, destination);
      },
    },
  ];
  return matrix;
}

function transactionScenarios(repetitions) {
  return ['undo', 'redo'].map((operation) => descriptor({
    name: `video-${operation}-path`, kind: `video-${operation}`,
    targets: (fixture) => targetsFor(fixture, 'video-keyboard-nudge'),
    repetitions,
    verify: verifySaved,
    perform: async ({ page, helpers, item, index }) => {
      const id = assertTarget(item, `${operation} path`);
      await selectClip(page, helpers, id);
      await page.keyboard.press(index % 2 ? 'Alt+ArrowLeft' : 'Alt+ArrowRight');
      await page.keyboard.press('Control+z');
      if (operation === 'redo') await page.keyboard.press('Control+Shift+z');
    },
  }));
}

function trackScenarios(repetitions) {
  return [descriptor({
    name: 'add-video-track', kind: 'track-add', repetitions,
    targets: () => [{}], verify: verifySaved,
    perform: async ({ page }) => {
      const button = page.getByRole('button', { name: /\+\s*Video/ }).first();
      if (!(await button.count())) throw new Error('fixture editor does not expose the add-video-track control');
      await button.click();
    },
  })];
}

function shotScenarios(fixture, repetitions) {
  const occurrences = fixture.clips?.shot_occurrences ?? [];
  return ['move', 'trim', 'delete'].flatMap((operation) => {
    return [descriptor({
      name: `shot-${operation}`, kind: `shot-${operation}`, repetitions,
      targets: () => occurrences,
      verify: operation === 'delete' ? verifyDeleted : verifySaved,
      perform: async ({ page, helpers, item, index }) => {
        const occurrenceId = item?.occurrence_id;
        const trackId = item?.track_id ?? (typeof item?.track === 'object' ? item.track.id : item?.track);
        if (!occurrenceId || !trackId) throw new Error(`shot-${operation} requires occurrence_id and track in the fixture manifest`);
        const label = page.locator(`[data-shot-group-key^="${cssValue(occurrenceId)}:${cssValue(trackId)}:"]`).first();
        const rect = await label.boundingBox();
        if (!rect) throw new Error(`shot occurrence ${occurrenceId} is not rendered on track ${trackId}`);
        if (operation === 'move') {
          const delta = Math.max(16, Math.min(48, rect.width * 0.06)) * (index % 2 ? -0.5 : 1);
          await helpers.drag(page, rect.x + rect.width / 2, rect.y + rect.height / 2, rect.x + rect.width / 2 + delta, rect.y + rect.height / 2);
        } else if (operation === 'trim') {
          const right = index % 2 === 0;
          const x = right ? rect.x + rect.width - 2 : rect.x + 2;
          const delta = Math.max(8, Math.min(24, rect.width * 0.04)) * (right ? -1 : 1);
          await helpers.drag(page, x, rect.y + rect.height / 2, x + delta, rect.y + rect.height / 2);
        } else {
          await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
          await page.keyboard.press('Delete');
        }
      },
    })];
  });
}

function scenariosFor(context, repetitions) {
  return [
    ...clipScenarios().map((scenario) => descriptor({
    ...scenario,
    name: scenario.kind,
    targets: (fixture) => targetsFor(fixture, scenario.kind),
    repetitions,
    verify: scenario.verify,
    })),
    ...transactionScenarios(repetitions),
    ...trackScenarios(repetitions),
    ...shotScenarios(context.fixture, repetitions),
  ];
}

export async function editScenarios(context) {
  return scenariosFor(context, 1);
}

export async function repeatScenarios(context) {
  return [
    ...scenariosFor(context, 2).map((item) => ({ ...item, name: `${item.name} ×2` })),
    ...scenariosFor(context, 10).map((item) => ({ ...item, name: `${item.name} ×10` })),
    ...scenariosFor(context, 3).map((item) => ({ ...item, name: `${item.name} ×3` })),
  ];
}
