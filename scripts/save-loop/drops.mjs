import fs from 'node:fs';
import path from 'node:path';

const MIME_BY_EXTENSION = {
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.m4a': 'audio/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
};

function fixtureDropFiles(fixture) {
  const files = fixture?.media?.drop_files;
  if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== 'string' || !path.isAbsolute(file))) {
    throw new Error('fixture.media.drop_files must contain absolute generated-media paths');
  }
  for (const file of files) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`fixture drop media is missing: ${file}`);
    }
    if (!MIME_BY_EXTENSION[path.extname(file).toLowerCase()]) {
      throw new Error(`fixture drop media has an unsupported extension: ${path.basename(file)}`);
    }
  }
  return files;
}

function visualTrack(fixture) {
  const tracks = fixture?.tracks?.visual;
  if (!Array.isArray(tracks)) throw new Error('fixture.tracks.visual must be an array');
  const track = tracks.find((item) => item && typeof item.id === 'string' && item.id && item.id !== fixture.tracks.occurrence_track_id && (item.kind === 'visual' || item.role === 'visual'));
  if (!track) throw new Error('fixture has no eligible visual track');
  return track;
}

function selectorValue(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

async function trackPoint(page, trackId, slot = 0) {
  const point = await page.evaluate(({ id, slotIndex }) => {
    const row = [...document.querySelectorAll('[data-row-id]')].find((element) => element.getAttribute('data-row-id') === id);
    if (!row) return null;
    row.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = row.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const fraction = Math.max(0.2, Math.min(0.8, 0.3 + slotIndex * 0.12));
    return {
      x: rect.left + rect.width * fraction,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
      offsetX: rect.width * fraction,
    };
  }, { id: trackId, slotIndex: slot });
  if (!point) throw new Error(`fixture visual track is not visible in the timeline: ${trackId}`);
  return point;
}

async function dispatchFileDrop(page, point, filePaths) {
  const files = filePaths.map((filePath) => ({
    name: path.basename(filePath),
    type: MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()],
    base64: fs.readFileSync(filePath).toString('base64'),
  }));
  await page.evaluate(({ x, y, files: payloads }) => {
    const transfer = new DataTransfer();
    for (const payload of payloads) {
      const binary = atob(payload.base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      transfer.items.add(new File([bytes], payload.name, { type: payload.type }));
    }
    const target = document.elementFromPoint(x, y);
    if (!target) throw new Error(`no timeline drop target at ${x},${y}`);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: transfer,
      }));
    }
  }, { x: point.x, y: point.y, files });
}

async function visibleLibrarySources(page, filePaths) {
  const extensions = [...new Set([
    ...Object.keys(MIME_BY_EXTENSION),
    ...filePaths.map((file) => path.extname(file).toLowerCase()),
  ])];
  return page.locator('[draggable="true"]').evaluateAll((elements, acceptedExtensions) => elements
    .map((element, index) => {
      const rect = element.getBoundingClientRect();
      const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      const metadata = {
        index,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role'),
        label: element.getAttribute('aria-label'),
        title: element.getAttribute('title'),
        testId: element.getAttribute('data-testid'),
        text: text.slice(0, 160),
      };
      const suffix = text.toLowerCase().match(/\.[a-z0-9]{2,5}(?:\s|$)/)?.[0]?.trim();
      return { metadata, visible: rect.width > 0 && rect.height > 0, suffix };
    })
    .filter((item) => item.visible && item.metadata.text && acceptedExtensions.includes(item.suffix)), extensions);
}

function clipIdentity(value) {
  return String(value).split('@', 1)[0];
}

function identities(state) {
  return [...new Set((Array.isArray(state?.clipIds) ? state.clipIds : []).map(clipIdentity))];
}

async function retainedDropPlaceholders(page) {
  return page.locator('[data-clip-id^="uploading-"]').evaluateAll((elements) => [...new Set(elements
    .map((element) => element.getAttribute('data-clip-id'))
    .filter(Boolean))]);
}

function dropVerifier({ page, name, expectedPlacements, gestureEvidence, expectedObjects }) {
  return async ({ before, after, result }) => {
    const beforeIds = new Set(identities(before));
    const afterIds = identities(after);
    const added = afterIds.filter((id) => !beforeIds.has(id));
    const placements = added.filter((id) => !id.startsWith('uploading-'));
    const oldPlaceholders = new Set((Array.isArray(before?.clipIds) ? before.clipIds : []).map(clipIdentity));
    const currentPlaceholders = await retainedDropPlaceholders(page);
    const newPlaceholders = currentPlaceholders.filter((id) => !oldPlaceholders.has(id));
    const observations = {
      expectedPlacements,
      observedPlacements: placements.length,
      addedClipIds: placements,
      retainedPlaceholderIds: newPlaceholders,
      beforeHeadCount: before?.headCount,
      afterHeadCount: after?.headCount,
      headCountDelta: Number.isFinite(before?.headCount) && Number.isFinite(after?.headCount)
        ? after.headCount - before.headCount : null,
      beforeHeadRevision: before?.headRevision,
      afterHeadRevision: after?.headRevision,
      beforePublicationId: before?.publicationId,
      afterPublicationId: after?.publicationId,
      headRevisionChanged: before?.headRevision !== after?.headRevision,
      publicationChanged: before?.publicationId !== after?.publicationId,
      gesture: gestureEvidence.current,
    };
    const failed = result?.pass === false || (result?.badge && result.badge !== 'saved');
    if (failed) {
      if (newPlaceholders.length === 0) {
        throw new Error(`${name}: drop was refused but no new parked placeholder remained; ${JSON.stringify(observations)}`);
      }
      throw new Error(`${name}: drop did not save (${result?.reason || result?.badge || 'row failed'}); `
        + `parked placeholder retained; ${JSON.stringify(observations)}`);
    }
    if (placements.length !== expectedPlacements) {
      throw new Error(`${name}: expected ${expectedPlacements} distinct placements, observed ${placements.length}; ${JSON.stringify(observations)}`);
    }
    if (!(Number.isFinite(before?.headCount) && Number.isFinite(after?.headCount) && after.headCount === 1 && before.headCount === 1)
      || !observations.headRevisionChanged || !observations.publicationChanged) {
      throw new Error(`${name}: placements did not advance the public timeline head; ${JSON.stringify(observations)}`);
    }
    if (expectedObjects) {
      const actual = placements.map(id => after.clipMedia?.[id] ?? []);
      const remaining = [...expectedObjects];
      for (const refs of actual) {
        const index = remaining.findIndex(id => refs.includes(id));
        if (index < 0) throw new Error(`${name}: new clip does not resolve an expected file digest; ${JSON.stringify({placements, actual, expectedObjects})}`);
        remaining.splice(index, 1);
      }
      if (remaining.length) throw new Error(`${name}: missing expected dropped file digests: ${remaining.join(', ')}`);
      observations.clipMedia = Object.fromEntries(placements.map((id, index) => [id, actual[index]]));
    }
    if (newPlaceholders.length) {
      throw new Error(`${name}: saved drop left an unexpected placeholder; ${JSON.stringify(observations)}`);
    }
    return observations;
  };
}

function scenario({ page, helpers, name, expectedPlacements, gesture, gestureEvidence, expectedObjects }) {
  return {
    name,
    expected: 'saved',
    gesture,
    verify: dropVerifier({ page, name, expectedPlacements, gestureEvidence, expectedObjects }),
    cleanup: (context) => helpers.restoreScenario(context),
  };
}

export async function dropScenarios({ page, fixture, helpers }) {
  const files = fixtureDropFiles(fixture);
  if (files.length < 2) throw new Error('fixture.media.drop_files needs at least two generated files for drop scenarios');
  const dropIds = fixture.media?.drop_object_ids;
  if (!Array.isArray(dropIds) || dropIds.length !== files.length || dropIds.some(id => !/^sha256:[0-9a-f]{64}$/.test(id)))
    throw new Error('fixture.media.drop_object_ids must pair SHA-256 object IDs with drop_files');
  const track = visualTrack(fixture);
  const trackSelector = `[data-row-id="${selectorValue(track.id)}"]`;

  const libraryEvidence = { current: null };
  const library = scenario({
    page, helpers, name: 'public library item drag x3', expectedPlacements: 3,
    gestureEvidence: libraryEvidence,
    gesture: async ({ iteration }) => {
      const librarySources = await visibleLibrarySources(page, files);
      if (!librarySources.length) throw new Error('no visible public-library drag item matches generated media');
      const source = page.locator('[draggable="true"]').nth(librarySources[0].metadata.index);
      for (let drag = 0; drag < 3; drag += 1) {
      await source.scrollIntoViewIfNeeded();
      await page.evaluate(() => {
        window.__saveLoopDropDragTypes = [];
        document.addEventListener('dragstart', (event) => {
          window.__saveLoopDropDragTypes = Array.from(event.dataTransfer?.types || []);
        }, { once: true });
      });
      const point = await trackPoint(page, track.id, iteration - 1 + drag);
      await source.dragTo(page.locator(trackSelector).first(), {
        targetPosition: { x: Math.max(1, Math.min(point.width - 1, point.offsetX)), y: point.height / 2 },
        timeout: 10000,
      });
      const dragTypes = await page.evaluate(() => window.__saveLoopDropDragTypes || []);
      libraryEvidence.current = {
        source: librarySources[0].metadata,
        transferTypes: dragTypes,
        repeatedDrags: (libraryEvidence.current?.repeatedDrags || 0) + 1,
      };
      if (!dragTypes.includes('asset-key') || !dragTypes.some((type) => type.startsWith('asset-kind:'))) {
        throw new Error(`selected draggable is not a public-library asset; DOM=${JSON.stringify(libraryEvidence.current)}`);
      }
      }
    },
  });

  const fileScenario = (name, paths, expectedPlacements, evidence) => scenario({
    page, helpers, name, expectedPlacements, gestureEvidence: evidence,
    expectedObjects: paths.map(file => dropIds[files.indexOf(file)]),
    gesture: async ({ iteration }) => {
      const point = await trackPoint(page, track.id, iteration - 1);
      await dispatchFileDrop(page, point, paths);
      evidence.current = {
        fileCount: paths.length,
        fileNames: paths.map((file) => path.basename(file)),
        eventType: 'dragenter,dragover,drop',
        track: { id: track.id, label: track.label, kind: track.kind },
      };
    },
  });
  const repeatedEvidence = { current: null };
  const repeatedSameFile = scenario({
    page, helpers, name: 'same generated file dropped twice', expectedPlacements: 2,
    expectedObjects: [dropIds[0], dropIds[0]],
    gestureEvidence: repeatedEvidence,
    gesture: async ({ iteration }) => {
      const points = [];
      for (let drop = 0; drop < 2; drop += 1) {
        const point = await trackPoint(page, track.id, iteration - 1 + drop);
        await dispatchFileDrop(page, point, [files[0]]);
        points.push({ x: point.x, y: point.y });
        if (drop === 0) await page.waitForTimeout(250);
      }
      repeatedEvidence.current = {
        fileName: path.basename(files[0]),
        eventCount: 2,
        eventType: 'two separate dragenter,dragover,drop sequences',
        track: { id: track.id, label: track.label, kind: track.kind },
        points,
      };
    },
  });

  return [
    library,
    fileScenario('generated file drop one', [files[0]], 1, { current: null }),
    fileScenario('generated file drop multiple', files.slice(0, 2), 2, { current: null }),
    repeatedSameFile,
  ];
}
