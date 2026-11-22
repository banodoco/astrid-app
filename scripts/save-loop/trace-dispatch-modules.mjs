import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const hooks = '/src/tools/video-editor/hooks';
const commands = '/src/tools/video-editor/commands';
const digest = value => createHash('sha256').update(value).digest('hex');
const mark = (event, fields = '{}') => `globalThis.__p77DispatchTrace?.native(${JSON.stringify(event)}, ${fields});`;

// Match the executable Vite output after verifying its inline source map against
// the pinned product blob. Every edit requires exactly one matching anchor.
const insertAfter = (anchor, code) => [anchor, match => `${match} ${code}`];
const insertBefore = (anchor, code) => [anchor, match => `${code} ${match}`];
const wrapStatement = (anchor, code) => [anchor, match => `{ ${code} ${match} }`];
const literal = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function unnamedBranch(message, reason, fields = '') {
  const doubleQuoted = literal(JSON.stringify(message));
  const singleQuoted = literal(`'${message.replaceAll("'", "\\'")}'`);
  return wrapStatement(new RegExp(`\\breturn\\s+(?:${doubleQuoted}|${singleQuoted})\\s*;`),
    mark('unnamed-edit-refusal-branch', `{ reason: ${JSON.stringify(reason)} ${fields} }`));
}
const dragRoute = (route, fields = '') => mark('drag-move-route', `{ route: ${JSON.stringify(route)} ${fields} }`);
const postAdoptionHistory = [
  insertBefore(/\bconst latest\s*=\s*await options\.loadHistory\(\)\s*;/, mark('post-adoption-history-start')),
  insertAfter(/\bconst latest\s*=\s*await options\.loadHistory\(\)\s*;/, mark('post-adoption-history-complete')),
];
const pump = [
  insertAfter(/\basync function pump\(\)\s*\{/, mark('pump-enter')),
  insertAfter(/\brecord\s*=\s*await box\.read\(\)\s*;\s*if\s*\(at\s*!==\s*generation\)\s*continue\s*;/, mark('pump-record-read', '{ intents: record.intents.length, hasPending: Boolean(record.pending) }')),
  insertBefore(/\bpublish\(["']saving["']\)\s*;/, mark('pump-ready-for-dispatch')),
];
const acceptance = [
  insertAfter(/\bcheckBasis\(\{\s*head:\s*result\.accepted,\s*canonicalDocument:\s*result\.canonicalDocument\s*,?\s*\}\)\s*;/,
    mark('commit-response-basis-verified', '{ revision: result.accepted.revisionId, publication: result.accepted.publicationId }')),
  insertBefore(/\bdelete state\.notice\s*;\s*options\.progress\?\.\(\)\s*;/,
    mark('outbox-acceptance-applied', '{ revision: basis.head.revisionId, publication: basis.head.publicationId }')),
];
const reference = {
  [`${hooks}/useTimelineSave.ts`]: mode => [
    [/\bdeferredHistory:\s*loadCommandHistory\s*&&\s*\{/, match => mode === 'off' ? match.replace('loadCommandHistory', 'void 0 && loadCommandHistory') : match],
    insertAfter(/\blocalOwner\.handoff\s*=\s*handoff\s*;/, mark('handoff-deferred-history-option', `{ configured: Boolean(loadCommandHistory) && ${mode !== 'off'} }`)),
  ],
  [`${hooks}/timelineLocalSaveHandoff.ts`]: () => [
    insertAfter(/\bpendingHistoryHead\s*=\s*head\s*;/, mark('deferred-history-scheduled')),
    insertBefore(/\bconst history\s*=\s*await deferred\.read\(head\)\s*;/, mark('deferred-history-read-start')),
    insertAfter(/\bif\s*\(pendingHistoryHead\s*===\s*head\)\s*pendingHistoryHead\s*=\s*(?:undefined|void\s+0)\s*;/, mark('deferred-history-finished')),
    insertBefore(/\bconst accepted\s*=\s*structuredClone\(basis\)\s*;/,
      mark('canonical-adoption-verified', '{ revision: head.headRevisionId, publication: head.headPublicationId }')),
    ...postAdoptionHistory,
  ],
  [`${commands}/localSaveSession.ts`]: () => [
    ...pump,
    insertBefore(/\bawait box!?\.append\(payload,\s*authoredBasis\)\s*;/, mark('outbox-append-start')),
    insertAfter(/\bawait box!?\.append\(payload,\s*authoredBasis\)\s*;/, mark('outbox-append-persisted')),
    ...acceptance,
  ],
  [`${commands}/commitOutbox.ts`]: () => [
    insertAfter(/\basync dispatch\s*\(build,\s*transmit,\s*assertCurrent\)\s*\{/, mark('outbox-dispatch-enter')),
    insertBefore(/\blet outcome\s*(?:: OutboxOutcome)?\s*;/, mark('outbox-reservation-persisted')),
    insertBefore(/\boutcome\s*=\s*detached\(await transmit\(detached\(pending\.request\)\)\)\s*;/, mark('outbox-transmit-start')),
    insertAfter(/\boutcome\s*=\s*detached\(await transmit\(detached\(pending\.request\)\)\)\s*;/,
      mark('outbox-transmit-returned', '{ kind: outcome.kind }')),
  ],
};

const warmReference = {
  [`${hooks}/timelineLocalSaveHandoff.ts`]: [
    [/\bif\s*\(history\s*&&\s*installHistory\(history,\s*head\)\)\s*\{?\s*deferred\.changed\(\)\s*;/,
      match => match.replace(/deferred\.changed\(\)\s*;/, changed => `{ ${mark('deferred-history-installed', `{
        project: initial.canonicalDocument.project_id, timeline: initial.canonicalDocument.timeline_id,
        revision: head.revisionId, publication: head.publicationId,
        contentDigest: initial.canonicalDocument.parent_revision.content_digest,
        historyMatchesHead: history.head?.revision_id === head.revisionId && history.head?.publication_id === head.publicationId,
        historyComplete: history.next_cursor === null,
        headStillCurrent: () => {
          const current = deferred.currentHead();
          return targetsHead === head && current?.revisionId === head.revisionId && current?.publicationId === head.publicationId;
        }
      }`)} ${changed} }`)],
    insertBefore(/\bconst unnamedRefusal\s*=\s*hasChildren\s*&&\s*gestureBasis\s*===\s*(?:undefined|void\s+0)\s*\?\s*unnamedEditRefusal\(before,\s*authoringSource,\s*next\)\s*:\s*(?:undefined|void\s+0)\s*;/,
      mark('unnamed-edit-ownership-check', '{ hasChildren: Boolean(hasChildren), hasGestureBasis: gestureBasis !== undefined }')),
    wrapStatement(/\brefuseEdit\(unnamedRefusal,\s*["']child-ownership-unavailable["']\)\s*;/,
      mark('unnamed-edit-refused', '{ code: "child-ownership-unavailable" }')),
    unnamedBranch("This edit can't be saved yet because this timeline's clips are stored in a form we can't match to the editor. Reload the timeline and try again.",
      'clip-or-track-storage-unavailable', `, parentConfig: object(config), parentClips: Array.isArray(config?.clips), parentTracks: Array.isArray(config?.tracks),
        beforeClips: Array.isArray(before.config.clips), beforeTracks: Array.isArray(before.config.tracks),
        afterClips: Array.isArray(next.config.clips), afterTracks: Array.isArray(next.config.tracks)`),
    unnamedBranch("This change to the timeline's settings can't be saved yet because the timeline has shots.", 'settings-or-bundle-changed'),
    unnamedBranch("Can't change a clip that belongs to a pinned shot group yet. Edit a clip outside the group.", 'pinned-shot-group-clip'),
    unnamedBranch("Can't change a shot's own clips from here yet. Edit a clip you added to the timeline.", 'shot-owned-clip',
      `, beforeShotPlaceholder: was?.clipType === 'shot', afterShotPlaceholder: now?.clipType === 'shot',
        addedShotClipCopy: !was && shotClipIds.has(id), addedCanonicalClip: !was && canonical !== undefined`),
    unnamedBranch("Can't change a clip on, or move one onto, a track that holds shots yet. Use another track.", 'shot-occupied-clip-track',
      ', beforeOccupied: Boolean(was && occupiedTracks.has(was.track)), afterOccupied: Boolean(now && occupiedTracks.has(now.track))'),
    unnamedBranch("Can't place a clip on a track that doesn't exist. Put it on one of the timeline's tracks.", 'destination-track-missing'),
    unnamedBranch("Can't remove a track that holds shots yet.", 'shot-occupied-track-removed'),
    unnamedBranch("Can't remove a track that a shot plays on yet.", 'shot-shared-track-removed'),
    unnamedBranch("Can't remove a track that still has clips on it. Move or delete its clips first.", 'track-with-clips-removed'),
    unnamedBranch("Can't change what kind of track this is on a timeline with shots yet.", 'track-kind-changed'),
    unnamedBranch("Can't add that track because a shot already uses its name. Add a different track.", 'shot-track-id-reused'),
    unnamedBranch("Can't reorder tracks on a timeline with shots yet.", 'tracks-reordered'),
    unnamedBranch("Can't remove or change project media on a timeline with shots yet.", 'registry-or-existing-media-changed'),
    unnamedBranch("Can't add media under a name a shot already uses. Import the media again.", 'shot-media-name-reused'),
  ],
  [`${hooks}/useClipDrag.helpers.ts`]: [
    [/\bif\s*\(isInvalidTimelineRowTarget\(dropPosition\?\.plan\?\.rejectReason\)\)\s*(return\s*\{\s*deferDeactivate:\s*false\s*,?\s*\}\s*;)/,
      (match, statement) => match.replace(statement, `{ ${dragRoute('invalid-row-target')} ${statement} }`)],
    insertAfter(/\bconst gestureBasis\s*=\s*!isGroupDrag\s*&&\s*session\.draggedClipIds\.length\s*===\s*1\b[^;]*\?\s*session\.moveReadBasis\s*:\s*(?:undefined|void\s+0)\s*;/,
      mark('drag-move-basis-eligibility', `{
        oneClip: session.draggedClipIds.length === 1, groupDrag: isGroupDrag, crossTrackActive,
        authoringDataIsLive: session.authoringData === liveData, plannedDataIsLive: session.plannedData === liveData,
        resolvedPlan: Boolean(resolvedPlan), requestedSourceTrack: resolvedPlan?.requestedTrackId === session.sourceRowId,
        resolvedSourceTrack: resolvedPlan?.targetTrackId === session.sourceRowId, needsNewTrack: resolvedPlan?.needsNewTrack ?? null,
        clipId: session.clipId, sourceTrack: session.sourceRowId, requestedTrack: resolvedPlan?.requestedTrackId ?? null,
        resolvedTrack: resolvedPlan?.targetTrackId ?? null, resolvedStart: resolvedPlan?.resolvedStart ?? null,
        moveReadBasis: Boolean(session.moveReadBasis), forwardsBasis: Boolean(gestureBasis)
      }`)),
    insertAfter(/\bif\s*\(!isGroupDrag\s*&&\s*crossTrackActive\s*&&\s*session\.draggedClipIds\.length\s*===\s*1\)\s*\{\s*if\s*\(resolvedPlan\s*&&\s*callbacks\.applyResolvedClipMove\)\s*\{/,
      dragRoute('cross-track-resolved', ', forwardsBasis: Boolean(gestureBasis)')),
    insertBefore(/\bcallbacks\.createTrackAndMoveClip\(/, dragRoute('cross-track-create-track')),
    [/\bcallbacks\.moveClipToRow\(session\.clipId,\s*dropPosition\.trackId,\s*nextStart,\s*session\.transactionId\)\s*;\s*\}\s*else\s*\{/,
      match => `${dragRoute('cross-track-target-row-fallback')} ${match} ${dragRoute('cross-track-source-row-fallback')}`],
    insertAfter(/\bif\s*\(session\.draggedClipIds\.length\s*>\s*1\s*\|\|\s*isGroupDrag\)\s*\{/,
      dragRoute('multiple-clips-or-group')),
    [/\bif\s*\(resolvedPlan\s*&&\s*callbacks\.applyResolvedClipMove\)\s*\{\s*callbacks\.applyResolvedClipMove\([^;]*;\s*\}\s*else\s*\{/,
      match => `${match.replace('callbacks.applyResolvedClipMove(', `${dragRoute('single-clip-resolved', ', forwardsBasis: Boolean(gestureBasis)')} callbacks.applyResolvedClipMove(`)} ${dragRoute('single-clip-source-row-fallback')}`],
  ],
  [`${hooks}/useTimelineTrackManagement.ts`]: [
    insertAfter(/\bconst applyResolvedClipMove\s*=\s*useCallback\(\(clipId,\s*targetRowId,\s*targetTrackId,\s*start,\s*needsNewTrack,\s*transactionId,\s*gestureBasis\)\s*=>\s*\{/,
      mark('track-move-entry', '{ route: "resolved", receivesBasis: Boolean(gestureBasis), needsNewTrack }')),
    insertAfter(/\bconst moveClipToRow\s*=\s*useCallback\(\(clipId,\s*targetRowId,\s*newStartTime,\s*transactionId\)\s*=>\s*\{/,
      mark('track-move-entry', '{ route: "row-fallback" }')),
    insertAfter(/\bconst translated\s*=\s*translateGroupMembers\(\{\s*current,\s*group:\s*\{\s*\.\.\.enclosingGroup\.group,\s*trackId:\s*sourceTrackId(?:2)?\s*,?\s*\}[^;]*;/,
      mark('track-move-apply-edit', '{ route: "resolved-pinned-group", forwardsBasis: false }')),
    insertAfter(/\bconst translatedGroup\s*=\s*translateGroupMembers\(\{\s*current,\s*group:\s*resolvedGroup,\s*targetRowId:\s*finalTargetId,[^;]*;/,
      mark('track-move-apply-edit', '{ route: "row-fallback-pinned-group", forwardsBasis: false }')),
    insertBefore(/\bapplyEdit\(\{\s*type:\s*["']rows["'],\s*rows:\s*nextRows,\s*metaUpdates:\s*\{\s*\[clipId\]:\s*\{\s*track:\s*finalTrackId\s*,?\s*\}\s*,?\s*\},\s*clipOrderOverride:\s*moveClipBetweenTracks\(current\.clipOrder,\s*clipId,\s*sourceRow\.id,\s*finalTrackId\)\s*,?\s*\},\s*\{\s*transactionId,\s*gestureBasis\s*,?\s*\}\)\s*;/,
      mark('track-move-apply-edit', '{ route: "resolved", finalTrackIsSource: finalTrackId === sourceRow.id, forwardsBasis: Boolean(gestureBasis) }')),
    insertBefore(/\bconst nextStart\s*=\s*typeof newStartTime\s*===\s*["']number["']\s*\?\s*Math\.max\(0,\s*newStartTime\)\s*:\s*action\.start\s*;/,
      mark('track-row-fallback-basis-built', '{ hasBasis: Boolean(gestureBasis), requestedTrackIsSource: targetRowId === sourceRow.id }')),
    insertAfter(/\bconst nextClipOrder\s*=\s*moveClipBetweenTracks\(current\.clipOrder,\s*clipId,\s*sourceRow\.id,\s*finalTrackId\)\s*;/,
      mark('track-move-apply-edit', `{ route: 'row-fallback', requestedTrackIsSource: targetRowId === sourceRow.id,
        finalTrackIsSource: finalTrackId === sourceRow.id, forwardsBasis: targetRowId === sourceRow.id && finalTrackId === sourceRow.id }`)),
  ],
};

const currentReference = {
  [`${hooks}/useTimelineSave.ts`]: [
    insertAfter(/\blocalOwner\.handoff\s*=\s*handoff\s*;/, mark('initial-verified-history', `{
      project: initial.canonicalDocument.project_id, timeline: initial.canonicalDocument.timeline_id,
      revision: initial.head.revisionId, publication: initial.head.publicationId,
      contentDigest: initial.canonicalDocument.parent_revision.content_digest,
      historyMatchesHead: initial.history?.head?.revision_id === initial.head.revisionId &&
        initial.history?.head?.publication_id === initial.head.publicationId,
      historyComplete: initial.history?.next_cursor === null,
      historyItems: initial.history?.items?.length ?? null, readOrdinal, originalUnrecovered: initial === verified.initial && owners.length === 0,
      headStillCurrent: () => {
        const mounted = localDataRef.current?.head;
        return isCurrent() && localOwner.handoff === handoff &&
          mounted?.headRevisionId === initial.head.revisionId && mounted?.headPublicationId === initial.head.publicationId;
      }
    }`)),
  ],
  [`${hooks}/timelineLocalSaveHandoff.ts`]: [
    insertAfter(/\brefuse\(["']canonical assembly did not adopt the accepted head["']\)\s*;/,
      mark('canonical-adoption-verified', '{ revision: head.headRevisionId, publication: head.headPublicationId }')),
    ...postAdoptionHistory,
    ...warmReference[`${hooks}/timelineLocalSaveHandoff.ts`].slice(1),
  ],
  [`${hooks}/useTimelinePersistence.ts`]: [
    insertBefore(/\bcommitData\(restore,\s*\{\s*save:\s*false,\s*skipHistory:\s*true,?\s*\}\)\s*;/,
      mark('native-refused-edit-restore')),
    insertAfter(/\btoast\.error\(timelineSaveRefusalMessage\(error\.message\)\)\s*;/,
      mark('native-refusal-toast-dispatched')),
  ],
  [`${commands}/localSaveSession.ts`]: [
    ...pump,
    insertBefore(/\bawait box!?\.append\(toOutboxJson\(save\),\s*authoredBasis\)\s*;/, mark('outbox-append-start')),
    insertAfter(/\bawait box!?\.append\(toOutboxJson\(save\),\s*authoredBasis\)\s*;/, mark('outbox-append-persisted')),
    ...acceptance,
  ],
  [`${commands}/commitOutbox.ts`]: reference[`${commands}/commitOutbox.ts`](),
  [`${hooks}/useClipDrag.helpers.ts`]: warmReference[`${hooks}/useClipDrag.helpers.ts`],
  [`${hooks}/useTimelineTrackManagement.ts`]: warmReference[`${hooks}/useTimelineTrackManagement.ts`],
};

export const traceModulePaths = Object.keys(reference);
export const traceModulePathsFor = mode => mode === 'warm' ? [...new Set([...traceModulePaths, ...Object.keys(warmReference)])] : traceModulePaths;
const moduleAnchors = (path, mode) => [...(reference[path]?.(mode) ?? []), ...(mode === 'warm' ? warmReference[path] ?? [] : [])];
export const compiledModulePaths = Object.keys(currentReference);
export const compiledAnchorCount = path => currentReference[path].length;

function replaceOne(code, [anchor, replacement], index) {
  const count = [...code.matchAll(new RegExp(anchor.source, 'g'))].length;
  if (count !== 1) throw new Error(`Module anchor ${index + 1} did not match exactly once (${count} matches)`);
  return code.replace(anchor, replacement);
}

export function instrumentModule(path, mode, incoming, expected) {
  if (!['on', 'off', 'warm'].includes(mode) || !traceModulePathsFor(mode).includes(path)) throw new Error('Unexpected module or comparison mode');
  // Strip the inline map from the returned body because these local observations
  // shift columns. The map stays local here and no source body enters the tape.
  const mapMatch = /\n\/\/# sourceMappingURL=data:application\/json(?:;charset=utf-8)?;base64,([\w+/=]+)\s*$/i.exec(incoming);
  if (!mapMatch) throw new Error('Vite module has no inline source identity');
  const sourceMap = JSON.parse(Buffer.from(mapMatch[1], 'base64'));
  if (sourceMap.sourcesContent?.length !== 1 || sourceMap.sourcesContent[0] !== expected) throw new Error('Vite module source does not match the pinned Round 5 source');
  const original = incoming.slice(0, mapMatch.index);
  const anchors = moduleAnchors(path, mode);
  const patched = anchors.reduce(replaceOne, original);
  const name = path.split('/').at(-1);
  const body = `${patched}\n${mark('trace-module-ready', `{ module: ${JSON.stringify(name)} }`)}\n`;
  return {body, module: name, source_sha256: digest(expected), original_js_sha256: digest(original), observed_js_sha256: digest(body), anchors: anchors.length};
}

export function instrumentCompiledModule(path, original, source, buildId, MagicString) {
  if (!compiledModulePaths.includes(path)) throw new Error('Unexpected compiled module');
  const anchors = currentReference[path];
  const edited = new MagicString(original);
  for (const [index, [anchor, replacement]] of anchors.entries()) {
    const matches = [...original.matchAll(new RegExp(anchor.source, 'g'))];
    if (matches.length !== 1) throw new Error(`${path}: compiled anchor ${index + 1} matched ${matches.length} times`);
    const [hit] = matches;
    const {0: match, index: start} = hit;
    const changed = replacement(...hit);
    if (changed !== match) edited.update(start, start + match.length, changed);
  }
  const module = path.split('/').at(-1);
  const source_sha256 = digest(source);
  const original_js_sha256 = digest(original);
  const marker = `p77:${buildId}:${digest(`${path}:${source_sha256}:${original_js_sha256}`)}`;
  edited.append(`\n${mark('trace-module-ready', JSON.stringify({module, marker}))}\n`);
  const code = edited.toString();
  return {
    code, map: edited.generateMap({source: path, includeContent: true, hires: 'boundary'}),
    audit: {path, module, marker, source_sha256, original_js_sha256, observed_js_sha256: digest(code), anchors: anchors.length},
  };
}

export async function installTraceModules(page, {origin, product, revision, mode}) {
  const source = new Map(traceModulePathsFor(mode).map(module => [module,
    execFileSync('git', ['-C', product, 'show', `${revision}:${module.slice(1)}`], {encoding: 'utf8'})]));
  const served = new Map();
  let failedModule, fail;
  const failed = new Promise(resolve => { fail = resolve; });
  await page.route(url => url.origin === origin && (source.has(url.pathname) ||
    (url.pathname.startsWith(`/@fs${product}/`) && source.has(url.pathname.slice(`/@fs${product}`.length)))), async route => {
    const requested = new URL(route.request().url());
    const module = requested.pathname.replace(`/@fs${product}`, '');
    const name = module.split('/').at(-1);
    try {
      if (route.request().method() !== 'GET' || route.request().resourceType() !== 'script' || served.has(name)) {
        throw new Error('Unexpected or repeated module request');
      }
      const reply = await route.fetch({maxRedirects: 0, maxRetries: 0, timeout: 30_000});
      if (reply.status() !== 200) throw new Error('Local Vite module did not return HTTP 200');
      const {body, ...audit} = instrumentModule(module, mode, await reply.text(), source.get(module));
      served.set(name, audit);
      await route.fulfill({status: 200, contentType: 'application/javascript; charset=utf-8', body});
    } catch (error) {
      failedModule ??= {module: name, reason: /^(?:Unexpected|Local Vite module|Vite module|Module anchor)/.test(error?.message ?? '')
        ? error.message : 'Module inspection or delivery failed'};
      fail(failedModule);
      await route.abort().catch(() => {});
    }
  });
  return {failed, audit: () => ({served: [...served.values()], failure: failedModule ?? null,
    complete: !failedModule && served.size === source.size})};
}
