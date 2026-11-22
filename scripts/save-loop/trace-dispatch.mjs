/** One real video move against an already running isolated Plan 77 stack. */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {loadavg} from 'node:os';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {isDeepStrictEqual} from 'node:util';
import {publicSnapshot} from './assert.mjs';
import {parseStat, runtimeRootForData} from './cpu.mjs';
import {editScenarios} from './edits.mjs';
import {expectedFixtureIds, sameIds} from './readiness.mjs';
import {installTraceModules, traceModulePathsFor} from './trace-dispatch-modules.mjs';
import {productRevision, verifyCompiledArtifact, verifyCompiledLock, verifyCompiledPreview} from './trace-dispatch-build.mjs';

const usage = 'Usage: node scripts/save-loop/trace-dispatch.mjs --manifest FILE --versions FILE --results NEW_FILE --mode one|on|off|warm|compiled-first|compiled-free-space|compiled-free-space-settled\n' +
  'Compiled modes also require --build-receipt FILE --receipt-sha SHA256 and SAVE_LOOP_COMPILED_LOCK with the active restore lock inherited on fd 9.\n' +
  'Use one fresh restore of the same authenticated v30 backup per compiled arm, with the same pinned current Release 15 tuple and artifact.\n' +
  'Mode compiled-first performs the original +18 px collision gesture. Mode compiled-free-space-settled also requires SAVE_LOOP_FREE_SPACE_INTERVAL containing the first legal summary\'s free_space.interval JSON.';
const round5 = {
  app: 'be9cc2407306eff06252c0d54be1c7f5afcacf3f',
  agent: '18adee8034973837a97fcd7392cd67f4566fa992',
  runtime: 'd7be2f0458a55c1f26e1138a125ffefe382f56f4',
};
const currentRelease15 = {
  app: productRevision,
  agent: '8807f820eb47d6018db723511e024a0a123fbe95',
  // Literal installed source revision. Same tree as the release wrapper 23310dc8.
  runtime: '3c28211f3cb7ac4867ad744d8cdeeb38dd4484c5',
};
const compiledV30Head = {
  revision_id: 'authoring-parent-revision-9f192b38d84116ee33c8be94208102ef57f38787f4d5cd89c3073bc6e5b3f07d',
  publication_id: 'txn-a3dbef5643ae4893bbe8d7fe5ffb1bbf',
  content_digest: 'sha256:66bddaf88bde38ee8705d755bfb8f80b4cafaec4dce8fb9ffec6eef1ae3b8c95',
};
const openingTimeout = 15 * 60_000;
const saveTimeout = 90_000;
const postTimeout = 90_000;
const idleWindow = 1000;
const refusalWindow = 33_000;
const rollbackToast = "Not saved: Can't change a clip on, or move one onto, a track that holds shots yet. Use another track. That change was undone; your other edits are kept.";
const watchdogText = 'The save has not been confirmed. Your changes are kept.';
const jsonFile = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value);

function options(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--manifest', '--versions', '--results', '--mode', '--build-receipt', '--receipt-sha'].includes(flag) ||
        args.has(flag) || !value || value.startsWith('--')) {
      throw new Error(usage);
    }
    args.set(flag, value);
  }
  const mode = args.get('--mode') ?? 'one';
  const compiled = ['compiled-first', 'compiled-free-space', 'compiled-free-space-settled'].includes(mode);
  const receiptFile = args.get('--build-receipt');
  const receiptSha = args.get('--receipt-sha');
  if (!args.has('--manifest') || !args.has('--versions') || !args.has('--results') ||
      (!compiled && !['one', 'on', 'off', 'warm'].includes(mode)) ||
      (compiled ? !receiptFile?.endsWith('.json') || !/^[a-f0-9]{64}$/.test(receiptSha ?? '') : receiptFile || receiptSha)) {
    throw new Error(usage);
  }
  return {mode, compiled, receiptFile, receiptSha, manifestPath: args.get('--manifest'), versionsPath: args.get('--versions'), resultsPath: args.get('--results')};
}

function fromEnv(name) {
  const key = `SAVE_LOOP_${name}`;
  if (!process.env[key]) throw new Error(`${key} is required`);
  return process.env[key];
}

function firstFreeSpaceInterval() {
  const raw = fromEnv('FREE_SPACE_INTERVAL');
  let interval;
  try { interval = JSON.parse(raw); } catch { /* Use a consistent error for invalid input. */ }
  if (!interval || !sameIds(Object.keys(interval), ['clip_id', 'track_id', 'desired_start_seconds', 'duration_seconds']) ||
      !safeId(interval.clip_id) || !safeId(interval.track_id) ||
      ![interval.desired_start_seconds, interval.duration_seconds].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('SAVE_LOOP_FREE_SPACE_INTERVAL requires clip_id, track_id, desired_start_seconds and duration_seconds');
  }
  return interval;
}

function canonicalDirectory(directory) {
  const resolved = fs.realpathSync(directory);
  if (path.resolve(directory) !== resolved || !fs.statSync(resolved).isDirectory()) {
    throw new Error('Stack, data root and product checkout must be canonical directories');
  }
  return resolved;
}

function readProductHead(product, app) {
  const git = (...args) => execFileSync('git', ['-C', product, ...args], {encoding: 'utf8'}).trim();
  const head = git('rev-parse', 'HEAD');
  if (head !== app || git('status', '--porcelain', '--untracked-files=normal')) {
    throw new Error('Product App must be clean at the exact revision for this trace mode');
  }
  return head;
}

async function preflight(versions, compiledOptions) {
  const tuple = compiledOptions ? currentRelease15 : round5;
  const root = canonicalDirectory(fromEnv('ROOT'));
  const data = canonicalDirectory(fromEnv('RUNTIME_DATA_ROOT'));
  const product = canonicalDirectory(fromEnv('PRODUCT_APP'));
  if (compiledOptions) verifyCompiledLock(root);
  const origin = new URL(fromEnv('BASE_URL'));
  const pid = Number(fromEnv('EDITOR_PID'));
  const proxyPort = Number(fromEnv('PROXY_PORT'));
  const doorPort = Number(fromEnv('DOOR_PORT'));
  const stack = Object.fromEntries(fs.readFileSync(path.join(root, 'stack-info.txt'), 'utf8')
    .split(/\r?\n/).filter(line => /^[A-Z_]+=[^=]+$/.test(line)).map(line => line.split('=')));
  if (!data.startsWith(`${root}${path.sep}`) || stack.STACK_ROOT !== root ||
      fs.readFileSync(path.join(root, '.sl1-stack-owned'), 'utf8') !== `astrid-app-sl1-stack-v1 ${root}`) {
    throw new Error('Runtime data root and stack must be under the same owned local stack');
  }
  if (!Object.entries(tuple).every(([key, sha]) => versions[key] === sha && stack[`${key.toUpperCase()}_SHA`] === sha)) {
    throw new Error(`Versions and stack-info must match the exact ${compiledOptions ? 'current Release 15' : 'Round 5'} tuple`);
  }
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.href !== `${origin.origin}/` ||
      ![Number(origin.port), proxyPort, doorPort].every(port => Number.isInteger(port) && port > 0 && port <= 65535) ||
      Number(origin.port) !== Number(stack.EDITOR_PORT) || proxyPort !== Number(stack.PROXY_PORT) || doorPort !== Number(stack.DOOR_PORT)) {
    throw new Error('Editor origin and proxy/door ports must match the loopback stack-info tuple');
  }
  const free = execFileSync('df', ['-Pk', root], {encoding: 'utf8'}).trim().split('\n').at(-1).trim().split(/\s+/)[3];
  if (!/^\d+$/.test(free) || Number(free) < 25 * 1024 * 1024) throw new Error('The owned stack must have 25 GiB free before tracing');
  if (!Number.isSafeInteger(pid) || pid < 1 || fs.realpathSync(`/proc/${pid}/cwd`) !== product) throw new Error('Editor PID does not identify the product checkout');
  const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  if (!command.some(arg => /(?:^|\/)dev-local-workspace\.mjs$/.test(arg)) || command[command.indexOf('--data-root') + 1] !== data) {
    throw new Error('Editor PID is not the owned local launcher for this data root');
  }
  readProductHead(product, tuple.app);
  let artifact;
  if (compiledOptions) {
    artifact = await verifyCompiledArtifact(compiledOptions.receiptFile, compiledOptions.receiptSha, product);
    if (artifact.receipt.output_dir.startsWith(`${root}${path.sep}`)) throw new Error('Compiled artifact must outlast the restored stack');
    await verifyCompiledPreview(pid, command, product, artifact);
  }
  const runtime = await runtimeRootForData(root, data, `${origin.origin}/api/runtime/v1/health`);
  const direct = await fetch(`http://127.0.0.1:${proxyPort}/v1/health`, {redirect: 'manual', signal: AbortSignal.timeout(3000)});
  const health = direct.ok && await direct.json();
  const discovery = jsonFile(path.join(data, 'runtime', 'discovery.json'));
  if (health?.runtime_instance_id !== discovery.runtime_instance_id || health?.status !== 'ok' || health?.protocol !== 'workspace.v1') {
    throw new Error('Owned proxy health does not match the adopted Runtime instance');
  }
  return {root, product, origin: origin.origin, runtime, tuple, artifact};
}

function fixtureWitness(fixture, mode, compiled) {
  const target = fixture.clips?.video?.primary;
  const ids = [fixture.project_id, fixture.timeline_id, target?.clip_id, target?.track_id];
  const one = mode === 'one';
  const expectedCount = one ? 1 : 300;
  const proof = fixture.live_proof;
  if (!ids.every(safeId) || fixture.media?.synthetic !== true || fixture.measurement?.clip_count !== expectedCount ||
      (!one && proof?.restored_version !== 30)) {
    if (one) throw new Error('Mode one requires an exact synthetic one-video fixture manifest');
    const modes = compiled ? 'Compiled modes require' : mode === 'warm' ? 'Mode warm requires' : 'Modes on/off require';
    throw new Error(`${modes} the restored synthetic v30 300-clip fixture manifest`);
  }
  if ((mode === 'warm' || compiled) && (target.clip_id !== 'fixture-video-0154' || target.track_id !== 'V6')) {
    throw new Error(`${compiled ? 'Compiled modes require' : 'Mode warm requires'} the exact restored v30 primary video target on V6`);
  }
  const expected = expectedFixtureIds(fixture);
  const pin = one ? fixture.measurement.actual_head ?? proof : {
    revision_id: proof.restored_revision, publication_id: proof.restored_publication, content_digest: proof.restored_content_digest,
  };
  if (!expected.includes(target.clip_id) || ![pin?.revision_id, pin?.publication_id, pin?.content_digest].every(safeId)) {
    throw new Error('Fixture manifest must pin the exact published head, publication and content');
  }
  const tracks = compiled ? [...fixture.tracks.visual, ...fixture.tracks.audio].map(track => track.id) : undefined;
  const occurrences = compiled ? fixture.clips.shot_occurrences.map(item => item.occurrence_id) : undefined;
  if (compiled && (!isDeepStrictEqual(pin, compiledV30Head) ||
      !sameIds(tracks, ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'A1', 'A2', 'A3']) ||
      !sameIds(occurrences, Array.from({length: 10}, (_, i) => `fixture-occurrence-${String(i).padStart(2, '0')}`)))) {
    throw new Error('Compiled modes require the pinned v30 head, nine rows and ten exact shot occurrences');
  }
  return {target: {clip_id: target.clip_id, track_id: target.track_id}, expected, tracks, occurrences,
    pin: {revision_id: pin.revision_id, publication_id: pin.publication_id, content_digest: pin.content_digest}};
}

// Self-contained for Playwright. All browser timestamps use this document's performance.now().
function browserTape({timelineKey, projectKey, clipId, trackId, warmScope, compiledFixture, freeSpace, collision}) {
  if (window.top !== window || location.pathname !== '/tools/video-editor') return;
  const limit = 16_000;
  const historyEndpoints = ['history_head_limit_1', 'deferred_history_limit_2', 'history_full_limit_50', 'other_history'];
  const endpointNames = ['timeline_commit', ...historyEndpoints,
    'timeline_metadata', 'revision_index', 'immutable_parent_revision', 'immutable_shot_revision', 'immutable_internal_revision'];
  const counts = Object.fromEntries(endpointNames.map(endpoint => [`app:${endpoint}`, {requested: 0, responded: 0, succeeded: 0, failed: 0}]));
  const tape = {rows: [], omitted: 0, counts, pointer: null, started: false, modules: []};
  if (compiledFixture) {
    tape.compiledMarkers = [];
    tape.timeOrigin = performance.timeOrigin;
    tape.initialFetch = {requested: 0, responded: 0, failed: 0, lastActivity: performance.now()};
  }
  window.__p77DispatchTrace = tape;
  const push = (phase, details = {}, at = performance.now()) => {
    if (tape.rows.length < limit) tape.rows.push({at, phase, ...details});
    else tape.omitted++;
  };
  tape.mark = push;
  let headStillCurrent, initialHeadStillCurrent;
  tape.hasCurrentWarmHistory = () => {
    try { return !tape.warmHistoryMismatch && headStillCurrent?.() === true; }
    catch { return false; }
  };
  tape.hasCurrentInitialHistory = () => {
    try { return tape.initialBasis?.exact === true && initialHeadStillCurrent?.() === true; }
    catch { return false; }
  };
  tape.native = (phase, detail) => {
    try {
      if (phase === 'trace-module-ready') {
        tape.modules.push(detail.module);
        if (compiledFixture) tape.compiledMarkers.push(detail.marker);
      }
      if (compiledFixture && phase === 'initial-verified-history') {
        const {headStillCurrent, ...observed} = detail;
        if (observed.project !== warmScope.project || observed.timeline !== warmScope.timeline) return;
        const at = performance.now();
        tape.initialHistory = {...observed, at};
        initialHeadStillCurrent = headStillCurrent;
        push(phase, {...observed, source: 'local module observer'}, at);
        return;
      }
      if (phase === 'deferred-history-installed') {
        if (!warmScope || detail.project !== warmScope.project || detail.timeline !== warmScope.timeline) return;
        if (detail.revision !== warmScope.revision_id || detail.publication !== warmScope.publication_id ||
            detail.contentDigest !== warmScope.content_digest || !detail.historyMatchesHead || !detail.historyComplete) {
          tape.warmHistoryMismatch = true;
          push('deferred-history-install-not-pinned', {source: 'local module observer'});
          return;
        }
        headStillCurrent = detail.headStillCurrent;
        const at = performance.now();
        tape.warmHistory = {at, head: warmScope};
        push(phase, {head: warmScope, source: 'local module observer'}, at);
        return;
      }
      push(phase, {...detail, source: 'local module observer'});
    } catch { /* Observations must never affect the save path. */ }
  };
  function initialBasisProof(handoff) {
    const history = tape.initialHistory;
    if (!history) return {exact: false, issue: 'missing_initial_history_handoff'};
    const {readOrdinal} = history;
    const basis = tape.rows.filter(row => row.timelineId === warmScope.timeline && row.ownerAlias === handoff.ownerAlias &&
      row.generation === handoff.generation && row.basisReadOrdinal === readOrdinal);
    const start = basis.find(row => row.phase === 'basis-read');
    const end = basis.find(row => row.phase === 'basis-ready');
    const matchesPin = head => head?.revisionId === warmScope.revision_id && head?.publicationId === warmScope.publication_id;
    const operations = basis.filter(row => row.phase === 'basis-operation');
    const span = entry => {
      const finishes = operations.filter(row => row.operation === entry.operation &&
        row.operationOrdinal === entry.operationOrdinal && row.operationState !== 'start');
      const [finish] = finishes;
      return {start_ms: entry.at, end_ms: finish?.at ?? null,
        duration_ms: finish ? finish.at - entry.at : null, complete: finishes.length === 1 && finish.operationState === 'end'};
    };
    const loaders = operations.filter(row => row.operation === 'loader' && row.operationState === 'start');
    const loader = loaders[0] ? span(loaders[0]) : null;
    const historyRequests = tape.rows.filter(row => row.observer === 'app' && historyEndpoints.includes(row.endpoint));
    const pages = operations.filter(row => row.operation === 'history' && row.operationState === 'start').map((entry, index) => {
      const page = span(entry);
      const requests = historyRequests.filter(row => row.phase === 'fetch-request' && row.at >= page.start_ms && row.at <= page.end_ms);
      const [request] = requests;
      const response = request && historyRequests.find(row => row.phase === 'fetch-response' && row.request === request.request);
      return {...page, filter: request?.filter ?? null, limit: request?.limit ?? null, cursor: request?.cursor ?? null,
        status: response?.status ?? null, exact_request: requests.length === 1 && request.filter === 'all' &&
          request.limit === '50' && request.cursor === (index > 0) && response?.status === 200 && response.at <= page.end_ms};
    });
    const exact = history.originalUnrecovered && history.historyMatchesHead && history.historyComplete &&
      Number.isSafeInteger(history.historyItems) && history.revision === warmScope.revision_id &&
      history.publication === warmScope.publication_id && history.contentDigest === warmScope.content_digest &&
      matchesPin(handoff.originalHead) && matchesPin(handoff.mountedHead) && matchesPin(end?.originalHead) &&
      loaders.length === 1 && loader.complete && pages.length > 0 && pages.every(page => page.complete && page.exact_request) &&
      start?.at <= loader.start_ms && loader.start_ms <= pages[0].start_ms && pages.at(-1).end_ms <= loader.end_ms &&
      loader.end_ms <= end.at && end.at <= history.at;
    return {exact: Boolean(exact), basis: {start_ms: start?.at ?? null, end_ms: end?.at ?? null,
      duration_ms: start && end ? end.at - start.at : null}, loader, history: {default_expected_filter: 'all', default_expected_limit: 50,
      page_count: pages.length, pages,
      start_ms: pages[0]?.start_ms ?? null, end_ms: pages.at(-1)?.end_ms ?? null,
      duration_ms: pages.length && pages.at(-1).end_ms !== null ? pages.at(-1).end_ms - pages[0].start_ms : null,
      handoff: history}};
  }
  window.__timelineSaveDiagnosticsEnabled = true;
  window.addEventListener('timeline:save-diagnostic', ({detail}) => {
    if (!detail || typeof detail.phase !== 'string') return;
    const {phase, time, sequence, timelineId, clipId, ownerAlias, generation, current, status,
      basisStatus, operation, operationState, basisReadOrdinal, operationOrdinal, mountedHead,
      originalHead, gestureKind, patch, errorCode} = detail;
    push(phase, {source: 'timeline:save-diagnostic', sequence, timelineId, clipId, ownerAlias, generation,
      current, status, basisStatus, operation, operationState, basisReadOrdinal, operationOrdinal,
      mountedHead, originalHead, gestureKind, patch, errorCode}, time);
    if (compiledFixture && phase === 'handoff-ready' && timelineId === warmScope.timeline && current === true) {
      tape.initialBasis = initialBasisProof({ownerAlias, generation, mountedHead, originalHead});
    }
  });
  window.addEventListener('pointerdown', event => {
    if (!tape.armed || tape.pointer || !event.isTrusted || event.button !== 0) return;
    const action = event.target instanceof Element && event.target.closest('.clip-action[data-row-id][data-clip-id]');
    if (action?.dataset?.clipId !== clipId || action?.dataset?.rowId !== trackId) return;
    tape.pointer = {pointerId: event.pointerId, down: performance.now(), up: null, cancelled: false};
    if (warmScope && !compiledFixture) tape.pointer.warmAtDown = tape.hasCurrentWarmHistory();
    if (compiledFixture) {
      tape.pointer.initialAtDown = tape.hasCurrentInitialHistory();
      tape.pointer.initialFetch = {...tape.initialFetch};
    }
    if (freeSpace) tape.pointer.freeSpaceDown = tape.freeSpacePoint(event.clientX, event.clientY);
    if (collision) {
      tape.pointer.collisionDown = {x: event.clientX, y: event.clientY};
      tape.watchCollision();
    }
    push('pointerdown', freeSpace ? {geometry: tape.pointer.freeSpaceDown} : {}, tape.pointer.down);
  }, true);
  if (freeSpace) window.addEventListener('pointermove', event => {
    if (!event.isTrusted || tape.pointer?.pointerId !== event.pointerId || tape.pointer.up !== null || tape.pointer.cancelled) return;
    const point = tape.freeSpacePoint(event.clientX, event.clientY);
    tape.pointer.freeSpaceMove = point;
    const down = tape.pointer.freeSpaceDown;
    if (!point.in_source_row || point.y !== down.y || point.scroll_left !== down.scroll_left || point.scroll_top !== down.scroll_top ||
        JSON.stringify(point.source_row) !== JSON.stringify(down.source_row)) tape.pointer.freeSpacePathInvalid = true;
    push('pointermove', {geometry: point});
  }, true);
  for (const type of ['pointerup', 'pointercancel']) window.addEventListener(type, event => {
    if (!event.isTrusted || tape.pointer?.pointerId !== event.pointerId || tape.pointer.up !== null || tape.pointer.cancelled) return;
    if (type === 'pointerup') {
      tape.pointer.up = performance.now();
      if (warmScope && !compiledFixture) tape.pointer.warmAtUp = tape.hasCurrentWarmHistory();
      if (compiledFixture) {
        tape.pointer.initialAtUp = tape.hasCurrentInitialHistory();
        tape.pointer.fetchAtUp = {...tape.initialFetch};
      }
      if (collision) {
        tape.pointer.collisionUp = {x: event.clientX, y: event.clientY};
        push('collision-clip-at-pointerup', {geometry: collisionClipPose()});
      }
      if (freeSpace) tape.pointer.freeSpaceUp = tape.freeSpacePoint(event.clientX, event.clientY);
    } else tape.pointer.cancelled = true;
    push(type, freeSpace ? {geometry: tape.pointer.freeSpaceUp} : {}, tape.pointer.up ?? performance.now());
  }, true);

  let serial = 0;
  const fetch = window.fetch;
  function classify(input, init) {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    if (url.origin !== location.origin) return null;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const route = url.pathname.replace(/^\/api\/runtime/, '');
    if (method === 'POST' && route === `${timelineKey}/commit`) return 'timeline_commit';
    if (method !== 'GET' || !route.startsWith(`${projectKey}/`)) return null;
    if (route === `${timelineKey}/commits`) {
      const limit = url.searchParams.get('limit');
      return limit === '1' ? 'history_head_limit_1' : limit === '2' ? 'deferred_history_limit_2'
        : limit === '50' ? 'history_full_limit_50' : 'other_history';
    }
    if (route === timelineKey) return 'timeline_metadata';
    if (route === `${timelineKey}/composition-revisions`) return 'revision_index';
    if (route.startsWith(`${timelineKey}/composition-revisions/`)) return 'immutable_parent_revision';
    if (route.includes('/shots/') && route.includes('/revisions/')) return 'immutable_shot_revision';
    if (route.includes('/timelines/') && route.includes('/revisions/')) return 'immutable_internal_revision';
    return null;
  }
  window.fetch = function(input, init) {
    let endpoint = null;
    let initial;
    let historyQuery;
    try {
      endpoint = classify(input, init);
      if (compiledFixture && historyEndpoints.includes(endpoint)) {
        const {searchParams: query} = new URL(input instanceof Request ? input.url : input, location.href);
        const keys = [...query.keys()];
        const cursor = query.has('cursor');
        historyQuery = {filter: keys.length === (cursor ? 2 : 1) && keys.every(key => key === 'limit' || key === 'cursor') &&
          query.has('limit') && (!cursor || Boolean(query.get('cursor'))) ? 'all' : 'other',
          limit: query.getAll('limit').length === 1 && /^\d{1,3}$/.test(query.get('limit')) ? query.get('limit') : null, cursor};
      }
      if (compiledFixture && tape.pointer?.up == null) {
        const url = new URL(input instanceof Request ? input.url : input, location.href);
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        if (url.protocol === location.protocol && url.origin === location.origin && method === 'GET') {
          initial = tape.initialFetch;
          initial.requested++;
          initial.lastActivity = performance.now();
        }
      }
    } catch { /* Leave unrelated requests alone. */ }
    if (!endpoint && !initial) return fetch.apply(this, arguments);
    const request = ++serial;
    const observer = tape.probe && init?.cache === 'no-store' && typeof input === 'string' && input.startsWith(`${location.origin}/`)
      ? 'independent_public_proof' : 'app';
    let count;
    if (endpoint) {
      count = tape.counts[`${observer}:${endpoint}`] ??= {requested: 0, responded: 0, succeeded: 0, failed: 0};
      count.requested++;
      push('fetch-request', {endpoint, request, observer, ...historyQuery});
    }
    const observeInitial = outcome => {
      if (!initial) return;
      initial[outcome]++;
      initial.lastActivity = performance.now();
    };
    const failure = () => {
      observeInitial('failed');
      if (count) { count.failed++; push('fetch-failed', {endpoint, request, observer}); }
    };
    let pending;
    try { pending = fetch.apply(this, arguments); } catch (error) { failure(); throw error; }
    void pending.then(response => {
      observeInitial('responded');
      if (!count) return;
      count.responded++;
      if (response.ok) count.succeeded++;
      push('fetch-response', {endpoint, request, observer, status: response.status});
    }, failure);
    return pending;
  };

  function visible(element) {
    if (!element || element.getAttribute('aria-hidden') === 'true' || !element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    return style.visibility === 'visible' && style.display !== 'none';
  }
  tape.readBadge = () => {
    const bar = document.querySelector('[role="alert"][data-save-bar]');
    if (visible(bar)) {
      // The displayed headline can contain server text. Keep bounded ordinary prose only.
      const text = (bar.firstElementChild?.textContent ?? '').replace(/\s+/g, ' ').trim();
      const scrubbed = text.replace(/\b(?:https?:\/\/|Bearer\b|Authorization\b|Cookie\b|\S*(?:token|credential|secret)[=:])\S*(?:\s+\S+)?/gi, '[redacted]')
        .replace(/\S{40,}/g, '[redacted]').slice(0, 300);
      return {state: 'not saved', kind: bar.getAttribute('data-save-bar'), text: scrubbed};
    }
    const badge = [...document.querySelectorAll('[data-video-editor-instance] .video-editor-panel-work-area .capitalize')].find(element =>
      element.children.length === 0 && /^(saved|saving|not saved|dirty|retrying|error|loading)$/i.test(element.textContent.trim()) && visible(element));
    return {state: badge?.textContent.trim().toLowerCase() ?? 'unknown'};
  };
  function collisionClipPose() {
    const slots = document.querySelectorAll(`[data-action-id="${CSS.escape(clipId)}"][data-row-id]`);
    const [slot] = slots;
    const clip = slot?.querySelector('.clip-action[data-clip-id]');
    if (slots.length !== 1 || !visible(clip)) return null;
    return {track: slot.dataset.rowId, left: slot.style.left, width: slot.style.width, clip_rect: clip.getBoundingClientRect().toJSON()};
  }
  tape.watchCollision = () => {
    const original = collisionClipPose();
    tape.collisionUi = {original, sample_count: 0, max_sample_gap_ms: 0};
    let lastAt = performance.now();
    let lastPose;
    const sample = () => {
      const at = performance.now();
      const ui = tape.collisionUi;
      ui.sample_count++;
      ui.max_sample_gap_ms = Math.max(ui.max_sample_gap_ms, at - lastAt);
      lastAt = at;
      const pose = collisionClipPose();
      const poseKey = JSON.stringify(pose);
      if (poseKey !== lastPose) {
        lastPose = poseKey;
        push('collision-clip-rendered', {geometry: pose}, at);
      }
      if (tape.pointer.up !== null) {
        const restore = tape.rows.some(row => row.phase === 'native-refused-edit-restore' && row.at >= tape.pointer.up);
        const moved = pose && original && (pose.track !== original.track || pose.left !== original.left || pose.width !== original.width);
        if (moved) ui.rendered_displaced = true;
        if (restore && pose && original && !moved && ui.source_pose_after_restore_ms === undefined) {
          ui.source_pose_after_restore_ms = at;
          push('collision-source-pose-after-restore', {geometry: pose}, at);
        }
        // The current app mounts Base UI Toast.Root and Toast.Title.
        const toast = [...document.querySelectorAll('.destructive[role="dialog"][aria-labelledby], .destructive[role="alertdialog"][aria-labelledby]')].find(root => {
          const title = document.getElementById(root.getAttribute('aria-labelledby'));
          if (!root.contains(title) || title?.textContent.trim() !== collision.rollbackToast || !visible(root) || !visible(title) ||
              Number(getComputedStyle(root).opacity) <= 0) return false;
          const rect = title.getBoundingClientRect();
          return rect.right > 0 && rect.left < innerWidth && rect.bottom > 0 && rect.top < innerHeight;
        });
        if (toast && ui.rollback_toast_ms === undefined) {
          ui.rollback_toast_ms = at;
          push('collision-rollback-toast-visible', {text: collision.rollbackToast}, at);
        }
        const badge = tape.readBadge();
        if (badge.kind === 'waiting' && badge.text === collision.watchdogText && ui.watchdog_ms === undefined) {
          ui.watchdog_ms = at;
          push('collision-watchdog-visible', {text: collision.watchdogText}, at);
        }
        if (at - tape.pointer.up >= collision.window) {
          ui.observed_through_ms = at;
          ui.terminal = pose;
          return;
        }
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  };
  if (compiledFixture) tape.fullWritable = () => {
    const url = new URL(location.href);
    if (url.searchParams.get('project') !== warmScope.project || url.searchParams.get('timeline') !== warmScope.timeline) return false;
    const rows = new Set([...document.querySelectorAll('[data-row-id]')].map(row => row.dataset.rowId));
    const clips = new Set([...document.querySelectorAll('.clip-action[data-row-id][data-clip-id]')]
      .map(clip => clip.dataset.clipId).filter(id => /^fixture-(?:image|video|audio)-/.test(id)));
    const target = document.querySelector(`.clip-action[data-clip-id="${CSS.escape(clipId)}"][data-row-id="${CSS.escape(trackId)}"]`);
    const field = document.querySelector(`[data-track-label][data-track-id="${CSS.escape(trackId)}"] input[aria-label="Track name"]`);
    return rows.size === compiledFixture.tracks.length && compiledFixture.tracks.every(id => rows.has(id)) &&
      clips.size === compiledFixture.clips.length && compiledFixture.clips.every(id => clips.has(id)) &&
      visible(target) && target.getAttribute('role') === 'button' && target.tabIndex >= 0 && target.getAttribute('aria-disabled') !== 'true' &&
      visible(field) && !field.disabled && !field.readOnly && !field.matches(':disabled') && tape.readBadge().state === 'saved';
  };
  if (freeSpace) {
    // The exact App's TrackListRenderer positions these slots from canonical
    // action starts and durations. Measure the projection without changing zoom.
    const {span, siblings} = freeSpace;
    const rowSelector = `[data-sortable-id="track-${CSS.escape(trackId)}"][data-row-id="${CSS.escape(trackId)}"]`;
    const clipSelector = `.clip-action[data-clip-id="${CSS.escape(clipId)}"][data-row-id="${CSS.escape(trackId)}"]`;
    const rowAt = (x, y) => document.elementFromPoint(x, y)?.closest('[data-sortable-id][data-row-id]');
    tape.freeSpacePoint = (x, y) => {
      const source = document.querySelector(rowSelector);
      const hit = rowAt(x, y);
      const canvas = source?.closest('.timeline-canvas-edit-area');
      return {x, y, in_source_row: Boolean(source && source === hit), hit_row: hit?.dataset.rowId ?? null,
        source_row: source?.getBoundingClientRect().toJSON() ?? null, hit_row_rect: hit?.getBoundingClientRect().toJSON() ?? null,
        scroll_left: canvas?.scrollLeft ?? null, scroll_top: canvas?.scrollTop ?? null,
        viewport: {width: window.innerWidth, height: window.innerHeight}};
    };
    tape.planFreeSpace = ({scroll = false} = {}) => {
      const targets = document.querySelectorAll(clipSelector);
      const [target] = targets;
      const rows = document.querySelectorAll(rowSelector);
      const [row] = rows;
      const canvas = row?.closest('.timeline-canvas-edit-area');
      const label = row?.querySelector('[data-track-label]')?.parentElement;
      if (targets.length !== 1 || rows.length !== 1 || !row.contains(target) || !canvas || !label) return {issue: 'ambiguous_source_row'};
      if (scroll) target.scrollIntoView({behavior: 'instant', block: 'center', inline: 'center'});
      const slots = [...row.querySelectorAll(':scope > [data-action-id][data-row-id]')];
      const spans = [...siblings, span];
      const slotById = new Map(slots.map(slot => [slot.dataset.actionId, slot]));
      if (slotById.size !== spans.length || slots.length !== spans.length ||
          spans.some(item => slotById.get(item.clip_id)?.dataset.rowId !== trackId) ||
          slotById.get(clipId) !== target.parentElement) return {issue: 'rendered_occupancy_differs'};
      const clip = target.getBoundingClientRect();
      const reference = siblings[0];
      const refRect = slotById.get(reference.clip_id).getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      const zeroX = rowRect.left + labelRect.width;
      const pixelsPerSecond = (clip.left - refRect.left) / (span.start_seconds - reference.start_seconds);
      const handleWidth = target.parentElement.querySelector('[data-resize-edge="left"]')?.getBoundingClientRect().width;
      if (!(pixelsPerSecond > 0 && Number.isFinite(pixelsPerSecond) && handleWidth > 0) || spans.some(item => {
        const rect = slotById.get(item.clip_id).getBoundingClientRect();
        return Math.abs(rect.left - (zeroX + item.start_seconds * pixelsPerSecond)) > 1 ||
          Math.abs(rect.width - Math.max(item.duration_seconds * pixelsPerSecond, 3 * handleWidth)) > 1;
      })) return {issue: 'canonical_and_rendered_projection_differ'};

      const x0 = Math.round(clip.left + clip.width / 2);
      const y = Math.round(rowRect.top + rowRect.height / 2);
      const dx = Math.max(18, Math.ceil(clip.right - x0) + 2);
      const x1 = x0 + dx;
      // Stay beyond the sticky label and outside the product's 40 px auto-scroll zones.
      const left = Math.max(rowRect.left, labelRect.right, canvasRect.left + 41, 1);
      const right = Math.min(rowRect.right, canvasRect.right - 41, canvasRect.left + canvas.clientWidth, window.innerWidth - 1);
      const top = Math.max(rowRect.top, canvasRect.top + 41, 1);
      const bottom = Math.min(rowRect.bottom, canvasRect.bottom - 41, window.innerHeight - 1);
      const desiredStart = span.start_seconds + dx / pixelsPerSecond;
      const desiredEnd = desiredStart + span.duration_seconds;
      const geometry = {x0, y, x1, dx, pixels_per_second: pixelsPerSecond, desired_start_seconds: desiredStart,
        desired_end_seconds: desiredEnd, visible_time_bounds_seconds: [(left - zeroX) / pixelsPerSecond, (right - zeroX) / pixelsPerSecond],
        clip_rect: clip.toJSON(), canvas_rect: canvasRect.toJSON(), visible_bounds: {left, right, top, bottom},
        source: tape.freeSpacePoint(x0, y), destination: tape.freeSpacePoint(x1, y)};
      const hit = document.elementFromPoint(x0, y);
      const dest = document.elementFromPoint(x1, y);
      if (!(clip.left > left && clip.right + dx < right && y > top && y < bottom &&
          desiredEnd > desiredStart && desiredStart > span.start_seconds &&
          geometry.source.in_source_row && geometry.destination.in_source_row && hit?.closest('.clip-action') === target &&
          !hit.closest('button, [data-no-clip-drag], [data-resize-edge]') && !dest?.closest('[data-action-id], [data-overlay-interactive]'))) {
        return {...geometry, issue: 'gesture_crosses_visual_boundary_or_hits_control'};
      }
      return geometry;
    };
  }
  tape.watchBadge = () => {
    if (tape.started) return;
    tape.started = true;
    let last;
    const sample = () => {
      const badge = tape.readBadge();
      if (JSON.stringify(badge) !== last) {
        last = JSON.stringify(badge);
        push('badge', badge);
      }
    };
    sample();
    new MutationObserver(sample).observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['data-save-bar', 'aria-hidden', 'aria-live'],
    });
  };
}

function wireCommits(page, endpoint, fixture, before, freeSpace) {
  const requests = new Map();
  const observed = request => request.method() === 'POST' && new URL(request.url()).origin === new URL(endpoint).origin && new URL(request.url()).pathname === new URL(endpoint).pathname;
  page.on('request', request => {
    if (!observed(request)) return;
    let body;
    try { body = request.postDataJSON(); } catch { /* Retain only an absent CAS witness. */ }
    requests.set(request, {status: null, outcome: 'pending', receipt: null, exactCas: Boolean(
      body?.project_id === fixture.project_id && body?.timeline_id === fixture.timeline_id && body.dry_run === false &&
      body.base_revision_id === before.headRevision && body.base_publication_id === before.publicationId,
    )});
  });
  page.on('requestfailed', request => {
    const row = requests.get(request);
    if (row) row.outcome = 'request_failed';
  });
  page.on('response', async response => {
    const row = requests.get(response.request());
    if (!row) return;
    row.status = response.status();
    row.outcome = 'response_observed';
    try {
      const body = await response.json();
      const {data, receipt} = body;
      if (response.ok() && ['accepted', 'rebased', 'merged'].includes(data?.status) &&
          receipt?.project_id === fixture.project_id && receipt.command_kind === 'timeline.commit' &&
          safeId(data.accepted_revision_id) && safeId(receipt.receipt_id) && isDeepStrictEqual(receipt.result, data)) {
        row.receipt = {revision: data.accepted_revision_id, publication: receipt.receipt_id, status: data.status};
        if (freeSpace) {
          const canonical = data.canonical_document?.parent_revision;
          row.exactAcceptedCas = data.status === 'accepted' && data.rebased_onto === null &&
            data.base_revision_id === before.headRevision && data.base_publication_id === before.publicationId &&
            data.previous_revision_id === before.headRevision && data.previous_publication_id === before.publicationId &&
            canonical?.revision_id === data.accepted_revision_id && /^sha256:[a-f0-9]{64}$/.test(canonical.content_digest);
          if (row.exactAcceptedCas) row.receipt.content_digest = canonical.content_digest;
        }
      }
      row.outcome = row.receipt ? 'accepted' : 'unconfirmed_response';
    } catch { row.outcome = 'unreadable_response'; }
  });
  return requests;
}

function observeCompiledOpening(page, origin, projectKey, timelineKey, receipt) {
  const reads = new Map();
  const measurements = [];
  const sizesPending = new Set();
  const pendingAssets = new Map();
  const assets = new Map();
  const fileHashes = new Map(receipt.files.map(({file, sha256}) => [file, sha256]));
  const required = ['index.html', ...new Set(receipt.modules.map(module => module.chunk))];
  const counts = {};
  let initial = true;
  let sourceScripts = 0;
  let writes = 0;
  let omittedMeasurements = 0;
  let lastActivity = performance.now();
  const start = lastActivity;
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== origin || url.protocol !== 'http:') return;
    const resource = request.resourceType();
    const route = url.pathname;
    const method = request.method();
    if (method === 'GET') {
      const count = counts[resource] ??= {requested: 0, headers: 0, finished: 0, failed: 0, http_errors: 0};
      count.requested++;
      const endpoint = route.replace(/^\/api\/runtime/, '');
      const runtime = route.startsWith('/api/runtime/');
      const scope = !runtime ? null : endpoint === `${timelineKey}/commits` ? 'history'
        : endpoint === timelineKey ? 'timeline_metadata'
        : endpoint === `${timelineKey}/composition-revisions` ? 'revision_index'
        : endpoint.startsWith(`${timelineKey}/composition-revisions/`) ? 'immutable_parent_revision'
        : endpoint.startsWith(`${projectKey}/shots/`) && endpoint.includes('/revisions/') ? 'immutable_shot_revision'
        : endpoint.startsWith(`${projectKey}/timelines/`) && endpoint.includes('/revisions/') ? 'immutable_internal_revision'
        : 'other_runtime_get';
      const at = request.timing().startTime;
      const measurement = scope ? {scope, start_epoch_ms: at > 0 ? at : null, status: null, finish_epoch_ms: null,
        outcome: 'pending', response_body_bytes: null} : null;
      if (scope === 'history') {
        const value = url.searchParams.get('limit');
        measurement.limit = /^\d{1,3}$/.test(value) ? value : null;
        measurement.cursor = url.searchParams.has('cursor');
      }
      const tracked = measurement && measurements.length < 16_000 ? measurement : null;
      if (tracked) measurements.push(tracked);
      else if (measurement) omittedMeasurements++;
      reads.set(request, {count, measurement: tracked});
      lastActivity = performance.now();
      if (resource === 'script' && !fileHashes.has(route.slice(1))) sourceScripts++;
      const file = resource === 'document' && route === '/tools/video-editor' ? 'index.html' : route.slice(1);
      if (required.includes(file) && !assets.has(file)) pendingAssets.set(request, file);
    } else if (initial && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      // The stock opening uses POSTs for transport admission and read-only inspect,
      // and PUT to remember the selected project. Other writes disqualify the run.
      const setup = (method === 'POST' && ['/api/runtime/v1/handshake', '/api/astrid/v1/handshake',
        '/__astrid/local-update-status', `/api/runtime${timelineKey}/inspect`].includes(route)) ||
        (method === 'PUT' && route === '/api/runtime/v1/projects/selection');
      if (!setup) writes++;
    }
  });
  page.on('response', response => {
    const row = reads.get(response.request());
    if (row) {
      row.count.headers++;
      if (response.status() >= 400) row.count.http_errors++;
      if (row.measurement) {
        const {startTime, responseStart} = response.request().timing();
        if (startTime > 0) row.measurement.start_epoch_ms = startTime;
        row.measurement.headers_epoch_ms = startTime > 0 && responseStart >= 0 ? startTime + responseStart : null;
        row.measurement.status = response.status();
      }
    }
  });
  async function settled(request, outcome) {
    const row = reads.get(request);
    if (row) {
      row.count[outcome]++;
      reads.delete(request);
      lastActivity = performance.now();
      if (row.measurement) {
        const {startTime, responseEnd} = request.timing();
        if (startTime > 0) row.measurement.start_epoch_ms = startTime;
        row.measurement.outcome = outcome;
        row.measurement.finish_epoch_ms = startTime > 0 && responseEnd >= 0 ? startTime + responseEnd : null;
        if (outcome === 'finished' && row.measurement.scope === 'history') {
          const sizes = request.sizes().then(({responseBodySize}) => {
            if (Number.isSafeInteger(responseBodySize) && responseBodySize >= 0) row.measurement.response_body_bytes = responseBodySize;
          }).catch(() => {});
          sizesPending.add(sizes);
          void sizes.finally(() => sizesPending.delete(sizes));
        }
      }
    }
    const file = pendingAssets.get(request);
    if (!file) return;
    pendingAssets.delete(request);
    let status = null;
    let sha256 = null;
    if (outcome === 'finished') {
      try {
        const response = await request.response();
        status = response?.status() ?? null;
        if (status === 200) sha256 = createHash('sha256').update(await response.body()).digest('hex');
      } catch { /* A missing body cannot establish served artifact identity. */ }
    }
    assets.set(file, {file, status, sha256, match: sha256 === fileHashes.get(file)});
  }
  page.on('requestfinished', request => { void settled(request, 'finished'); });
  page.on('requestfailed', request => { void settled(request, 'failed'); });
  return {
    snapshot: () => {
      const pendingByScope = {};
      for (const {measurement} of reads.values()) {
        if (measurement) pendingByScope[measurement.scope] = (pendingByScope[measurement.scope] ?? 0) + 1;
      }
      return {pending: reads.size, pending_by_runtime_scope: pendingByScope, writes, idle_ms: performance.now() - lastActivity,
        last_activity_since_observer_ms: lastActivity - start, by_resource: structuredClone(counts)};
    },
    seal: () => { initial = false; },
    async readMeasurements() {
      await Promise.all([...sizesPending]);
      return {rows: structuredClone(measurements), omitted: omittedMeasurements};
    },
    assetAudit: () => ({complete: !sourceScripts && required.every(file => assets.get(file)?.match),
      source_scripts: sourceScripts, served: required.map(file => assets.get(file) ?? {file, match: false})}),
  };
}

function runtimeCpuClock(runtime) {
  const ticksPerSecond = Number(execFileSync('getconf', ['CLK_TCK'], {encoding: 'utf8'}).trim());
  if (!Number.isFinite(ticksPerSecond) || ticksPerSecond <= 0) throw new Error('Runtime CPU counter resolution is unavailable');
  function mark() {
    const stat = parseStat(fs.readFileSync(`/proc/${runtime.pid}/stat`, 'utf8'));
    if (stat.start !== runtime.start || stat.pid !== runtime.pid) throw new Error('Runtime CPU counter process identity changed');
    return {at: performance.timeOrigin + performance.now(), ticks: stat.cpu};
  }
  const start = mark();
  return () => {
    const end = mark();
    if (end.ticks < start.ticks) throw new Error('Runtime CPU counter moved backwards');
    return {counter: 'Runtime PID user + system proc_stat ticks', ticks_per_second: ticksPerSecond,
      start_epoch_ms: start.at, end_epoch_ms: end.at, wall_ms: end.at - start.at,
      cpu_seconds: (end.ticks - start.ticks) / ticksPerSecond};
  };
}

function compiledReadReport(wire, trace, writable) {
  const history = trace?.initialBasis?.history;
  const fromEpoch = stamp => Number.isFinite(stamp) && Number.isFinite(trace?.timeOrigin) ? stamp - trace.timeOrigin : null;
  const rows = (wire?.rows ?? []).map(row => ({scope: row.scope, limit: row.limit, cursor: row.cursor,
    sent_ms: fromEpoch(row.start_epoch_ms), headers_ms: fromEpoch(row.headers_epoch_ms), finish_ms: fromEpoch(row.finish_epoch_ms),
    duration_ms: Number.isFinite(row.start_epoch_ms) && Number.isFinite(row.finish_epoch_ms) ? row.finish_epoch_ms - row.start_epoch_ms : null,
    status: row.status, outcome: row.outcome, response_body_bytes: row.response_body_bytes}));
  const pages = history?.pages.map(page => {
    const matches = rows.filter(row => row.scope === 'history' && row.limit === page.limit && row.cursor === page.cursor &&
      Number.isFinite(row.sent_ms) && row.sent_ms >= page.start_ms && row.sent_ms <= page.end_ms &&
      row.status === 200 && row.outcome === 'finished');
    return {...page, wire_matches: matches.length,
      response_body_bytes: matches.length === 1 ? matches[0].response_body_bytes : null};
  });
  function activeAt(at) {
    if (!wire || !Number.isFinite(at)) return null;
    const scopes = ['history', 'timeline_metadata', 'revision_index', 'immutable_parent_revision', 'immutable_shot_revision', 'immutable_internal_revision'];
    return Object.fromEntries(scopes.map(scope => {
      const scoped = rows.filter(row => row.scope === scope);
      const known = scoped.filter(row => Number.isFinite(row.sent_ms) && row.sent_ms <= at);
      return [scope, {requested: known.length, known_in_flight: known.filter(row => row.finish_ms > at || row.outcome === 'pending').length,
        missing_start_clock: scoped.filter(row => row.sent_ms === null).length,
        missing_completion_clock: known.filter(row => row.outcome !== 'pending' && row.finish_ms === null).length}];
    }));
  }
  return {
    clock: 'Playwright Chromium request.timing() epoch timestamps minus browser performance.timeOrigin',
    response_body_byte_basis: 'Playwright request.sizes().responseBodySize for finished history GETs, excluding HTTP headers. No response body is copied.',
    history_pages: pages ?? null,
    history_response_body_total_bytes: pages?.length && pages.every(page => page.response_body_bytes !== null)
      ? pages.reduce((sum, page) => sum + page.response_body_bytes, 0) : null,
    at_writable: activeAt(writable),
    at_pointerdown: activeAt(trace?.pointer?.down),
    at_pointerup: activeAt(trace?.pointer?.up),
    slow_runtime_gets_started_before_writable: Number.isFinite(writable) ? rows.filter(row => row.sent_ms !== null && row.sent_ms <= writable)
      .sort((a, b) => (b.duration_ms ?? writable - b.sent_ms) - (a.duration_ms ?? writable - a.sent_ms)).slice(0, 15) : null,
    omitted_runtime_gets: wire?.omitted ?? null,
  };
}

const rootClips = snapshot => snapshot.payload?.config?.clips ?? snapshot.payload?.clips ?? [];

function exactMove(before, after, target) {
  const matching = snapshot => rootClips(snapshot).filter(clip => clip?.id === target.clip_id);
  const [oldClip, extraOld] = matching(before);
  const [newClip, extraNew] = matching(after);
  if (!oldClip || !newClip || extraOld || extraNew || oldClip.track !== target.track_id || newClip.track !== target.track_id ||
      !Number.isFinite(oldClip.at) || !Number.isFinite(newClip.at) || oldClip.at === newClip.at ||
      !isDeepStrictEqual({...oldClip, at: newClip.at}, newClip)) return null;
  return {clip: target.clip_id, track: target.track_id, from_seconds: oldClip.at, to_seconds: newClip.at};
}

function otherClipsUnchanged(before, after, target) {
  const remaining = snapshot => new Map(rootClips(snapshot).filter(clip => clip.id !== target.clip_id).map(clip => [clip.id, clip]));
  return isDeepStrictEqual(remaining(before), remaining(after));
}

function canonicalSpan(clip) {
  // Round 5 timeline-domain.ts uses a hold, otherwise an explicit trim, then
  // divides by the canonical playback rate. Unknown source spans are unsafe.
  const held = clip.clipType === 'hold' || typeof clip.hold === 'number';
  const source = held ? clip.hold : Number.isFinite(clip.from) && Number.isFinite(clip.to) ? clip.to - clip.from : NaN;
  const rate = clip.speed ?? 1;
  if (!Number.isFinite(clip.at) || clip.at < 0 || !Number.isFinite(source) || source <= 0 ||
      !Number.isFinite(rate) || rate <= 0 || (!held && clip.hold != null)) return null;
  const duration = source / rate;
  const end = clip.at + duration;
  if (!Number.isFinite(end) || end <= clip.at) return null;
  return {clip_id: clip.id, start_seconds: clip.at, duration_seconds: duration, end_seconds: end,
    timing: held ? {hold: clip.hold, speed: rate} : {from: clip.from, to: clip.to, speed: rate}};
}

function canonicalFreeSpace(before, expected, tracks) {
  const {config, registry, occurrences, clips: mirrorClips, tracks: mirrorTracks} = before.payload;
  const {clips, tracks: authoredTracks, pinnedShotGroups: groups = []} = config ?? {};
  if (!Array.isArray(clips) || !Array.isArray(authoredTracks) || !Array.isArray(groups) ||
      (mirrorClips !== undefined && !isDeepStrictEqual(mirrorClips, clips)) ||
      (mirrorTracks !== undefined && !isDeepStrictEqual(mirrorTracks, authoredTracks)) ||
      !sameIds(clips.map(clip => clip?.id), expected) || !sameIds(authoredTracks.map(track => track?.id), tracks)) {
    return {issue: 'ambiguous_canonical_root'};
  }
  const trackIds = new Set(tracks);
  if (clips.some(clip => !trackIds.has(clip.track))) return {issue: 'unknown_clip_track'};
  const occupied = new Set();
  for (const occurrence of occurrences) {
    const locations = [occurrence.track, occurrence.placement?.track].filter(value => value !== undefined);
    if (!locations.length || locations.some(value => !trackIds.has(value)) || new Set(locations).size !== 1) {
      return {issue: 'ambiguous_occurrence_track'};
    }
    occupied.add(locations[0]);
  }
  const groupClips = new Set();
  for (const group of groups) {
    if (!trackIds.has(group?.trackId) || !Array.isArray(group.clipIds) || !group.clipIds.every(safeId)) {
      return {issue: 'ambiguous_group_track'};
    }
    occupied.add(group.trackId);
    for (const id of group.clipIds) groupClips.add(id);
  }
  for (const track of authoredTracks) {
    if (track.kind !== 'visual' || (track.role ?? 'output') !== 'output' || occupied.has(track.id)) continue;
    const lane = clips.filter(clip => clip.track === track.id);
    if (lane.length < 2 || lane.some(clip => groupClips.has(clip.id) || clip.clipType === 'shot')) continue;
    const spans = lane.map(canonicalSpan);
    if (spans.some(span => !span)) continue;
    spans.sort((a, b) => a.start_seconds - b.start_seconds);
    const span = spans.at(-1);
    const clip = lane.find(item => item.id === span.clip_id);
    const type = registry?.assets?.[clip.asset]?.type;
    const siblings = spans.slice(0, -1);
    if (!['media', 'hold'].includes(clip.clipType) || clip.app?.canonical !== undefined ||
        typeof type !== 'string' || !/^video(?:\/|$)/.test(type) ||
        siblings.some(sibling => sibling.end_seconds > span.start_seconds)) continue;
    return {target: {clip_id: clip.id, track_id: track.id}, track_kind: track.kind, track_role: track.role ?? 'output',
      video_asset_type: type, span, siblings,
      occupied_shot_track_ids: [...occupied].sort(), rightward_clear_from_seconds: span.start_seconds,
      provenance: 'Verified immutable parent payload config.clips, config.tracks, occurrences and pinnedShotGroups at the exact v30 head.'};
  }
  return {issue: 'no_last_regular_video_with_known_nonoverlapping_siblings'};
}

function exactFreeSpaceDiff(before, after, move) {
  if (!move) return false;
  const expected = structuredClone(before.payload);
  // Runtime may mirror config.clips at the parent root. Both copies must
  // carry the same sole logical change and all other payload data must match.
  for (const container of [expected.config, expected]) {
    if (container.clips === undefined) continue;
    container.clips.find(clip => clip.id === move.clip).at = move.to_seconds;
  }
  return isDeepStrictEqual(expected, after.payload);
}

// JSON objects use UTF-16 key order, arrays keep their stored order, and
// primitive values use JSON.stringify with negative zero kept distinct.
function canonicalPayloadJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalPayloadJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalPayloadJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return Object.is(value, -0) ? '-0' : JSON.stringify(value);
}

function freeSpacePayloadFingerprint(payload, clipId) {
  const normalized = structuredClone(payload);
  const {config, clips: mirror} = normalized;
  if (!Array.isArray(config?.clips) || (mirror !== undefined && !isDeepStrictEqual(mirror, config.clips))) {
    throw new Error('Free-space fingerprint requires one canonical clip list and an exact optional root mirror');
  }
  const atSentinel = 'p77-free-space:selected-at';
  for (const clips of mirror === undefined ? [config.clips] : [config.clips, mirror]) {
    const [clip, duplicate] = clips.filter(item => item?.id === clipId);
    if (!clip || duplicate || !Number.isFinite(clip.at)) throw new Error('Free-space fingerprint requires one numeric start per clip list');
    clip.at = atSentinel;
  }
  return {algorithm: 'sha256/canonical-json-v1', at_sentinel: atSentinel,
    sha256: createHash('sha256').update(canonicalPayloadJson(normalized), 'utf8').digest('hex')};
}

const safeSnapshot = snapshot => snapshot ? {
  revision: snapshot.headRevision, publication: snapshot.publicationId, content_digest: snapshot.content_digest,
  head_count: snapshot.headCount, clip_count: snapshot.clipIds.length,
} : null;

function bounded(phase, timeout, operation) {
  let timer;
  return Promise.race([operation(), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${phase} deadline expired`)), timeout);
  })]).finally(() => clearTimeout(timer));
}

const errorKind = error => error?.name === 'TimeoutError' || / deadline expired$/.test(error?.message ?? '') ? 'deadline' : 'operation_failed';

class UnsupportedGesture extends Error {}

async function compiledGestureGuard(page, {x, y, selector, markers, settled, deadline, network, commits, freeSpaceGeometry, prepareOnly = false}) {
  while (performance.now() < deadline) {
    const state = await bounded('browser gesture guard', Math.min(5000, deadline - performance.now()), () =>
      page.evaluate(({x, y, selector, markers, settled, idleWindow, freeSpace, prepareOnly}) => {
        const tape = window.__p77DispatchTrace;
        const fetch = tape.initialFetch;
        const at = performance.now();
        const exactHistory = tape.hasCurrentInitialHistory();
        const pending = fetch.requested - fetch.responded - fetch.failed;
        const idle = at - fetch.lastActivity;
        const hit = prepareOnly ? null : document.elementFromPoint(x, y)?.closest('.clip-action');
        const idleEnough = !settled || (pending === 0 && idle >= idleWindow);
        const geometry = freeSpace && idleEnough ? tape.planFreeSpace() : undefined;
        const issue = tape.pointer ? 'A trusted gesture is already recorded.'
          : !exactHistory ? 'The mounted initial verified history is missing, incomplete, or no longer on the pinned head.'
          : tape.counts['app:timeline_commit'].requested ? 'The app issued a timeline commit before the gesture.'
          : tape.compiledMarkers.length !== markers.length || markers.some(marker => !tape.compiledMarkers.includes(marker)) ? 'Compiled module markers differ from the receipt.'
          : geometry?.issue ? `Rendered free-space geometry differs: ${geometry.issue}`
          : idleEnough && (!tape.fullWritable() || (!prepareOnly && !hit?.matches(selector))) ? 'The pinned writable editor or exact gesture target is unavailable.'
          : null;
        const ready = !issue && idleEnough;
        if (ready && !prepareOnly) tape.armed = true;
        return {issue, ready, at, exact_history: exactHistory, fetch: {...fetch, pending, idle_ms: idle},
          ...(geometry ? {free_space: geometry} : {})};
      }, {x, y, selector, markers, settled, idleWindow, freeSpace: Boolean(freeSpaceGeometry), prepareOnly}));
    const wire = network.snapshot();
    if (state.issue) throw new UnsupportedGesture(state.issue);
    if (commits.size || wire.writes) throw new UnsupportedGesture('Playwright observed a write before the gesture.');
    if (!network.assetAudit().complete) throw new UnsupportedGesture('The served index and instrumented chunks do not yet match the receipt.');
    if (freeSpaceGeometry && state.ready && !isDeepStrictEqual(state.free_space, freeSpaceGeometry)) {
      throw new UnsupportedGesture('The source row or projected interval changed before the gesture.');
    }
    if (state.ready && (!settled || (wire.pending === 0 && wire.idle_ms >= idleWindow)) && performance.now() < deadline) {
      return {state, wire};
    }
    await delay(50);
  }
  throw new Error('compiled settling deadline expired');
}

const exactOccurrences = (snapshot, expected) => Array.isArray(snapshot.payload.occurrences) &&
  sameIds(snapshot.payload.occurrences.map(item => item.occurrence_id), expected);

function freeSpacePointsMatch(point, expected) {
  return Boolean(point?.in_source_row && isDeepStrictEqual(point, expected));
}

function freeSpaceNativeBasis(edit, target) {
  const observed = phase => edit.filter(row => row.phase === phase && row.source === 'local module observer');
  const [eligibility, extraEligibility] = observed('drag-move-basis-eligibility');
  const [drag, extraDrag] = observed('drag-move-route');
  const [entry, extraEntry] = observed('track-move-entry');
  const [apply, extraApply] = observed('track-move-apply-edit');
  const capture = edit.find(row => row.phase === 'capture-called' && row.clipId === target?.clip_id && row.gestureKind === 'move');
  const sameTrack = eligibility?.oneClip === true && eligibility.groupDrag === false && eligibility.crossTrackActive === false &&
    eligibility.resolvedPlan === true &&
    eligibility.requestedSourceTrack === true && eligibility.resolvedSourceTrack === true && eligibility.needsNewTrack === false &&
    drag?.route === 'single-clip-resolved' && entry?.route === 'resolved' && entry.needsNewTrack === false &&
    !extraEligibility && !extraDrag && !extraEntry && !extraApply;
  const qualified = sameTrack && eligibility.authoringDataIsLive === true && eligibility.plannedDataIsLive === true &&
    eligibility.moveReadBasis === true && eligibility.forwardsBasis === true && drag.forwardsBasis === true &&
    entry.receivesBasis === true && apply?.route === 'resolved' && apply.forwardsBasis === true && apply.finalTrackIsSource === true && Boolean(capture);
  return {qualified, same_track: sameTrack, eligibility: eligibility ?? null, drag: drag ?? null, entry: entry ?? null,
    apply: apply ?? null, capture: capture ?? null};
}

function collisionObservation(edit, pointer, ui, target) {
  const native = phase => edit.find(row => row.phase === phase && row.source === 'local module observer');
  const plan = native('drag-move-basis-eligibility');
  const route = native('drag-move-route');
  const ownership = native('unnamed-edit-ownership-check');
  const branch = native('unnamed-edit-refusal-branch');
  const refused = native('unnamed-edit-refused');
  const capture = edit.find(row => row.phase === 'capture-rejected' && row.errorCode === 'child-ownership-unavailable');
  const restore = native('native-refused-edit-restore');
  const toast = native('native-refusal-toast-dispatched');
  const up = pointer?.up;
  const sinceUp = at => Number.isFinite(up) && Number.isFinite(at) ? at - up : null;
  const observedMs = sinceUp(ui?.observed_through_ms);
  const watchdog = edit.find(row => row.phase === 'badge' && row.kind === 'waiting' &&
    row.text === watchdogText && row.at <= ui?.observed_through_ms);
  const watchdogMs = sinceUp(watchdog?.at ?? ui?.watchdog_ms);
  const original = ui?.original;
  const terminal = ui?.terminal;
  const originalPose = Boolean(original?.track === target.track_id && terminal?.track === original.track &&
    original.left && terminal.left === original.left && terminal.width === original.width);
  const downPoint = pointer?.collisionDown;
  const upPoint = pointer?.collisionUp;
  const verifiedDelta = Boolean(downPoint && upPoint && upPoint.x - downPoint.x === 18 && upPoint.y === downPoint.y);
  const expectedNativeRefusal = plan?.clipId === target.clip_id && plan.sourceTrack === target.track_id &&
    plan.requestedTrack === target.track_id && plan.resolvedPlan && plan.resolvedSourceTrack === false &&
    plan.needsNewTrack === false && plan.forwardsBasis === false && ownership?.hasChildren && ownership.hasGestureBasis === false &&
    branch?.reason === 'shot-occupied-clip-track' && branch.afterOccupied && refused?.code === 'child-ownership-unavailable' &&
    Boolean(capture);
  const visibleRollback = Boolean(restore && toast && ui?.source_pose_after_restore_ms >= restore.at && ui.rollback_toast_ms >= toast.at);
  return {
    verified_delta: verifiedDelta, pointerdown: downPoint ?? null, pointerup: upPoint ?? null,
    plan: plan ?? null, move_route: route ?? null, ownership_check: ownership ?? null, ownership_branch: branch ?? null,
    refusal: capture ?? refused ?? null,
    pointerup_to_capture_refusal_ms: sinceUp(capture?.at),
    pointerup_to_native_restore_ms: sinceUp(restore?.at),
    pointerup_to_toast_dispatched_ms: sinceUp(toast?.at),
    pointerup_to_visible_rollback_toast_ms: sinceUp(ui?.rollback_toast_ms),
    pointerup_to_rendered_source_pose_after_restore_ms: sinceUp(ui?.source_pose_after_restore_ms),
    original_clip_pose: original ?? null, terminal_clip_pose: terminal ?? null,
    rendered_displaced_after_pointerup: Boolean(ui?.rendered_displaced),
    clip_ended_at_original_pose: originalPose,
    watchdog: {state: watchdogMs !== null ? 'visible' : observedMs >= refusalWindow ? 'not_observed' : 'undetermined',
      pointerup_to_visible_ms: watchdogMs, observed_through_ms_after_pointerup: observedMs,
      sample_count: ui?.sample_count ?? 0, max_sample_gap_ms: ui?.max_sample_gap_ms ?? null},
    qualified: verifiedDelta && expectedNativeRefusal && originalPose && visibleRollback && observedMs >= refusalWindow,
  };
}

async function run({mode, compiled, receiptFile, receiptSha, manifestPath, versionsPath, resultsPath}) {
  const fixture = jsonFile(manifestPath);
  const versions = jsonFile(versionsPath);
  const {target: manifestTarget, expected, tracks, occurrences, pin} = fixtureWitness(fixture, mode, compiled);
  const warm = mode === 'warm';
  const settled = mode === 'compiled-free-space-settled';
  const freeSpace = mode === 'compiled-free-space' || mode === 'compiled-free-space-settled';
  const collision = mode === 'compiled-first';
  const expectedInterval = freeSpace && settled ? firstFreeSpaceInterval() : null;
  let target = freeSpace ? null : manifestTarget;
  const warmScope = warm || compiled ? {project: fixture.project_id, timeline: fixture.timeline_id, ...pin} : undefined;
  const stack = await preflight(versions, compiled && {receiptFile, receiptSha});
  const chrome = fromEnv('CHROME');
  const {chromium} = await import(process.env.SAVE_LOOP_PLAYWRIGHT || 'playwright');
  const out = fs.openSync(resultsPath, 'wx', 0o600);
  const record = row => fs.writeSync(out, `${JSON.stringify(row)}\n`);
  const projectKey = `/v1/projects/${encodeURIComponent(fixture.project_id)}`;
  const timelineKey = `${projectKey}/timelines/${encodeURIComponent(fixture.timeline_id)}`;
  const editor = new URL('/tools/video-editor', stack.origin);
  editor.search = new URLSearchParams({connect: '1', project: fixture.project_id, timeline: fixture.timeline_id});
  const started = performance.now();
  let profile, context, page, before, after, commits, trace, move, confirmed, failure, modules, phase = 'browser_start';
  let finalBadge, proofAt, readinessAt, failureKind;
  let beforeVerified = false;
  let terminalPublicProof, settlementBadge;
  let network, wireAtReady, wireAtGesture, wireAtDown, wireAfterGesture, artifactsReverified, profileRemoved, browserClosed;
  let gestureData, freeSpaceDocument, freeSpaceGeometry, freeSpaceInterval, browserFetchAtReady, exactHistoryAtReady;
  let readMeasurements, openingCpu, unsupported;
  const machineLoad = compiled ? {at_full_writable: null, before_pointerdown: null, at_terminal: null} : null;
  const cleanup = async () => {
    try {
      if (context) {
        await context.close();
        browserClosed = true;
      }
    }
    finally { if (profile) fs.rmSync(profile, {recursive: true, force: true, maxRetries: 8, retryDelay: 100}); }
  };
  const onSignal = code => () => { void cleanup().finally(() => process.exit(code)); };
  const interrupt = onSignal(130);
  const terminate = onSignal(143);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  record({type: 'run', mode, versions: stack.tuple, project: fixture.project_id, timeline: fixture.timeline_id, target,
    runtime_pid: stack.runtime.pid, started_at: new Date().toISOString(),
    schedule: settled ? 'One collision-free rightward move after the verified initial exact-head history and one second of same-origin GET idle.'
      : freeSpace ? 'One collision-free rightward move at the first full writable v30 editor.'
      : collision ? 'The original +18 px horizontal gesture at the first full writable v30 editor, then 33 seconds of rollback and watchdog observation.'
      : warm ? 'One real move after deferred history is installed for the independently verified v30 head.'
      : 'One real move when the exact target and desktop save badge are visible on a writable timeline.',
    history_scope: compiled ? 'Opening awaits the original authoring basis. The default loader walks every history cursor at limit 50 and verifies immutable sources before handing off the complete history.'
      : mode === 'off'
      ? 'The browser module suppresses the automatic deferred-history option only. Verified head/source, CAS, commit, response verification, canonical adoption and post-adoption history stay active.'
      : 'Automatic deferred history and required verified head/source reads are enabled.',
    expected_fixture: {clip_count: expected.length, restored_version: mode === 'one' ? null : 30, head: pin,
      ...(compiled ? {track_count: tracks.length, occurrence_count: occurrences.length} : {})},
    ...(compiled ? {compiled_artifact: {receipt_sha256: receiptSha, inputs_sha256: stack.artifact.receipt.inputs_sha256,
      output_sha256: stack.artifact.receipt.output_sha256, node: stack.artifact.receipt.inputs.node}} : {})});
  try {
    if (compiled) {
      phase = 'fresh_stack_guard';
      // The operator tears down this stack. Keep the marker so another run
      // cannot reuse the same restored root after refusal or interruption.
      fs.mkdirSync(path.join(stack.root, '.p77-compiled-dispatch-used'), {mode: 0o700});
    }
    phase = 'browser_start';
    profile = fs.mkdtempSync(path.join(stack.root, 'p77-dispatch-chrome-'));
    context = await chromium.launchPersistentContext(profile, {
      executablePath: chrome, headless: true, viewport: {width: 1700, height: 1500},
      args: ['--disk-cache-size=1', '--media-cache-size=1', ...(compiled ? ['--disable-gpu', '--no-first-run'] : [])],
    });
    page = context.pages()[0] ?? await context.newPage();
    if (!freeSpace) await page.addInitScript(browserTape, {timelineKey, projectKey, clipId: target.clip_id, trackId: target.track_id, warmScope,
      compiledFixture: compiled ? {clips: expected, tracks} : undefined,
      collision: collision ? {rollbackToast, watchdogText, window: refusalWindow} : undefined});
    if (mode !== 'one' && !compiled) {
      phase = 'module_observer_setup';
      modules = await installTraceModules(page, {origin: stack.origin, product: stack.product, revision: round5.app, mode});
    }
    phase = 'before_public_head';
    await bounded(phase, openingTimeout, async () => {
      await page.goto(`${stack.origin}/api/runtime${projectKey}`, {waitUntil: 'domcontentloaded', timeout: openingTimeout});
      const validProject = await page.evaluate(async ({path, project}) => {
        const response = await fetch(path, {cache: 'no-store', credentials: 'same-origin'});
        if (!response.ok) return false;
        const body = await response.json();
        const value = body?.data ?? body;
        return value?.project_id === project && value.metadata?.purpose === 'synthetic Plan 77 save-loop fixture';
      }, {path: `/api/runtime${projectKey}`, project: fixture.project_id});
      if (!validProject) throw new Error('Public project did not match the synthetic fixture');
      before = await publicSnapshot(page, stack.origin, fixture);
      if (before.headRevision !== pin.revision_id || before.publicationId !== pin.publication_id ||
          before.content_digest !== pin.content_digest || !sameIds(before.clipIds, expected) ||
          (compiled && !exactOccurrences(before, occurrences))) {
        throw new Error('Public head or exact clip inventory does not match the fixture manifest');
      }
      beforeVerified = true;
    });
    if (freeSpace) {
      phase = 'canonical_free_space';
      freeSpaceDocument = canonicalFreeSpace(before, expected, tracks);
      if (freeSpaceDocument.issue) {
        unsupported = freeSpaceDocument.issue;
        throw new Error('Verified public payload does not prove a regular free-space target');
      }
      target = freeSpaceDocument.target;
      record({type: 'free_space_document', ...freeSpaceDocument,
        normalized_payload_fingerprint: freeSpacePayloadFingerprint(before.payload, target.clip_id)});
      await page.addInitScript(browserTape, {timelineKey, projectKey, clipId: target.clip_id, trackId: target.track_id, warmScope,
        compiledFixture: {clips: expected, tracks}, freeSpace: {span: freeSpaceDocument.span, siblings: freeSpaceDocument.siblings}});
    }
    commits = wireCommits(page, `${stack.origin}/api/runtime${timelineKey}/commit`, fixture, before, freeSpace);
    if (compiled) network = observeCompiledOpening(page, stack.origin, projectKey, timelineKey, stack.artifact.receipt);
    phase = 'opening_readiness';
    const opening = bounded(phase, openingTimeout, async () => {
      const cpu = compiled ? runtimeCpuClock(stack.runtime) : null;
      await page.goto(editor.href, {waitUntil: compiled ? 'commit' : 'domcontentloaded', timeout: openingTimeout});
      if (compiled) {
        const ready = await page.waitForFunction(() => {
          const tape = window.__p77DispatchTrace;
          if (!tape?.fullWritable()) return false;
          const at = performance.now();
          tape.watchBadge();
          tape.mark('ui-writable', {clips: 300, tracks: 9}, at);
          return {at, fetch: {...tape.initialFetch}, exactHistory: tape.hasCurrentInitialHistory()};
        }, null, {timeout: openingTimeout});
        ({at: readinessAt, fetch: browserFetchAtReady, exactHistory: exactHistoryAtReady} = await ready.jsonValue());
        openingCpu = cpu();
        machineLoad.at_full_writable = loadavg()[0];
        wireAtReady = network.snapshot();
        return;
      }
      await page.waitForFunction(({project, timeline, clip, track}) => {
        const url = new URL(location.href);
        if (url.searchParams.get('project') !== project || url.searchParams.get('timeline') !== timeline) return false;
        const target = document.querySelector(`.clip-action[data-clip-id="${CSS.escape(clip)}"][data-row-id="${CSS.escape(track)}"]`);
        const input = document.querySelector(`[data-track-label][data-track-id="${CSS.escape(track)}"] input[aria-label="Track name"]`);
        return target?.getClientRects().length && target.getAttribute('role') === 'button' && target.tabIndex >= 0 &&
          target.getAttribute('aria-disabled') !== 'true' && input?.getClientRects().length && !input.disabled &&
          !input.readOnly && window.__p77DispatchTrace?.readBadge().state === 'saved';
      }, {project: fixture.project_id, timeline: fixture.timeline_id, clip: target.clip_id, track: target.track_id}, {timeout: openingTimeout});
    });
    if (modules) {
      await Promise.race([opening, modules.failed.then(() => { throw new Error('Comparison module failed its audit'); })]);
      phase = 'module_observer_verification';
      const executed = await page.evaluate(() => window.__p77DispatchTrace.modules);
      if (!modules.audit().complete || !sameIds(executed, traceModulePathsFor(mode).map(module => module.split('/').at(-1)))) {
        throw new Error('The comparison modules did not all load and execute at their pinned anchors');
      }
    } else await opening;
    phase = 'pre_gesture_guard';
    if (commits.size || wireAtReady?.writes) throw new Error('A timeline write was observed before the sole authorized gesture');
    if (compiled && !settled && !exactHistoryAtReady) {
      unsupported = 'The first full writable marker lacks a proven current initial verified history.';
      throw new Error(unsupported);
    }
    if (!compiled) readinessAt = await page.evaluate(warm => {
      const tape = window.__p77DispatchTrace;
      tape.watchBadge();
      tape.armed = !warm;
      const at = performance.now();
      tape.mark('ui-writable', {}, at);
      return at;
    }, warm);
    if (warm) {
      phase = 'warm_history_install';
      await page.waitForFunction(() => {
        const tape = window.__p77DispatchTrace;
        return tape?.warmHistoryMismatch || tape?.hasCurrentWarmHistory();
      }, null, {timeout: openingTimeout, polling: 100});
      if (!await page.evaluate(() => window.__p77DispatchTrace?.hasCurrentWarmHistory())) {
        throw new Error('Deferred history did not install on the pinned current v30 head');
      }
    }
    phase = 'gesture';
    const selector = `.clip-action[data-clip-id="${target.clip_id}"][data-row-id="${target.track_id}"]`;
    const gestureTimeout = settled ? openingTimeout + 15_000 : 15_000;
    const gestureDeadline = performance.now() + gestureTimeout;
    const compiledGuard = compiled ? {selector, markers: stack.artifact.receipt.modules.map(module => module.marker), settled, network, commits} : null;
    let gestureExpired = false;
    async function drag(p, x0, y0, x1, y1) {
      await p.mouse.move(x0, y0);
      if (compiled) {
        phase = settled ? 'compiled_opening_settlement' : 'compiled_gesture_guard';
        const deadline = settled ? Math.min(performance.now() + openingTimeout, gestureDeadline - 5000) : gestureDeadline;
        const {state, wire} = await compiledGestureGuard(p, {...compiledGuard, x: x0, y: y0, deadline, freeSpaceGeometry});
        wireAtGesture = wire;
        if (gestureExpired || performance.now() >= gestureDeadline) throw new Error('Compiled gesture deadline expired');
        gestureData = {guard: state, dx: x1 - x0, dy: y1 - y0};
        phase = 'gesture';
      }
      if (warm) {
        const ready = await p.evaluate(() => {
          const tape = window.__p77DispatchTrace;
          if (!tape?.hasCurrentWarmHistory() || tape.pointer || tape.readBadge().state !== 'saved') return false;
          tape.armed = true;
          return true;
        });
        if (!ready || commits.size) throw new Error('Warm v30 installation or pre-gesture commit guard failed before pointerdown');
      }
      if (compiled) machineLoad.before_pointerdown = loadavg()[0];
      await p.mouse.down();
      if (compiled) {
        wireAtDown = network.snapshot();
        const pointer = await p.evaluate(() => window.__p77DispatchTrace?.pointer);
        const fetch = pointer?.initialFetch;
        if (!pointer?.initialAtDown || commits.size || wireAtDown.writes ||
            (freeSpace && !freeSpacePointsMatch(pointer.freeSpaceDown, freeSpaceGeometry.source)) ||
            (settled && (wireAtDown.pending !== 0 || wireAtDown.idle_ms < idleWindow ||
              fetch.requested !== fetch.responded + fetch.failed || pointer.down - fetch.lastActivity < idleWindow))) {
          throw new Error('Compiled pointerdown did not preserve the opening guard');
        }
      } else if (warm && !await p.evaluate(() => window.__p77DispatchTrace?.pointer?.warmAtDown)) {
        throw new Error('Trusted pointerdown for the exact warm v30 clip was not observed');
      }
      await p.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, {steps: 4});
      await p.mouse.move(x1, y1, {steps: 6});
      if (freeSpace) {
        const {pointer, destination} = await p.evaluate(({x1, y1}) => {
          const tape = window.__p77DispatchTrace;
          return {pointer: tape.pointer, destination: tape.freeSpacePoint(x1, y1)};
        }, {x1, y1});
        if (pointer.freeSpacePathInvalid || !freeSpacePointsMatch(pointer.freeSpaceMove, freeSpaceGeometry.destination) ||
            !freeSpacePointsMatch(destination, freeSpaceGeometry.destination)) {
          throw new Error('Rendered free-space drag left the verified source geometry');
        }
      }
      if (warm && !await p.evaluate(() => window.__p77DispatchTrace?.hasCurrentWarmHistory())) {
        throw new Error('Warm v30 installation was no longer current before pointerup');
      }
      if (!compiled || (!gestureExpired && performance.now() < gestureDeadline)) await p.mouse.up();
    }
    try {
      await bounded(phase, gestureTimeout, async () => {
        if (freeSpace) {
          if (settled) {
            phase = 'compiled_opening_settlement';
            const deadline = Math.min(performance.now() + openingTimeout, gestureDeadline - 5000);
            await compiledGestureGuard(page, {...compiledGuard, deadline, prepareOnly: true});
          }
          phase = 'free_space_projection';
          freeSpaceGeometry = await page.evaluate(() => window.__p77DispatchTrace.planFreeSpace({scroll: true}));
          if (freeSpaceGeometry.issue) {
            unsupported = freeSpaceGeometry.issue;
            throw new Error('Rendered timeline cannot prove the planned free-space interval');
          }
          const {x0, y, x1, desired_start_seconds} = freeSpaceGeometry;
          freeSpaceInterval = {...target, desired_start_seconds, duration_seconds: freeSpaceDocument.span.duration_seconds};
          if (expectedInterval && (expectedInterval.clip_id !== target.clip_id || expectedInterval.track_id !== target.track_id ||
              Math.abs(expectedInterval.desired_start_seconds - freeSpaceInterval.desired_start_seconds) > 1e-6 ||
              Math.abs(expectedInterval.duration_seconds - freeSpaceInterval.duration_seconds) > 1e-6)) {
            phase = 'free_space_interval';
            unsupported = 'The rendered interval does not reproduce the verified first-arm interval.';
            throw new Error('The settled geometry does not reproduce the first free-space interval');
          }
          await drag(page, x0, y, x1, y);
        } else if (collision) {
          const {x, y} = await page.locator(selector).evaluate(element => {
            element.scrollIntoView({block: 'nearest', inline: 'nearest'});
            const rect = element.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const hit = document.elementFromPoint(x, y);
            if (!(rect.width > 0 && rect.height > 0) || hit?.closest('.clip-action') !== element ||
                hit.closest('button, [data-no-clip-drag], [data-resize-edge]')) throw new Error('Exact video clip center is not hittable');
            return {x, y};
          });
          await drag(page, x, y, x + 18, y);
        } else {
          const gesture = (await editScenarios({fixture})).find(scenario => scenario.name === 'video-move-same-track');
          await gesture.gesture({page, fixture, iteration: 1, mark: () => {}, helpers: {
            rect: async p => p.locator(selector).evaluate(element => {
              element.scrollIntoView({block: 'nearest', inline: 'nearest'});
              const {x, y, width: w, height: h} = element.getBoundingClientRect();
              const hit = document.elementFromPoint(x + w / 2, y + h / 2);
              if (w <= 0 || h <= 0 || hit?.closest('.clip-action') !== element) throw new Error('Exact video clip center is not hittable');
              return {x, y, w, h};
            }),
            drag,
          }});
        }
      });
    } finally { gestureExpired = true; }
    phase = 'save_settlement';
    const pointer = await page.evaluate(() => window.__p77DispatchTrace.pointer);
    if (!Number.isFinite(pointer?.up) || (warm && !pointer.warmAtUp) || (compiled && !pointer.initialAtUp)) {
      throw new Error('Trusted pointerup for the exact fixture clip and initial head was not verified');
    }
    if (freeSpace && !freeSpacePointsMatch(pointer.freeSpaceUp, freeSpaceGeometry.destination)) {
      throw new Error('Trusted pointerup did not remain at the planned free-space destination');
    }
    if (compiled) {
      wireAfterGesture = network.snapshot();
      network.seal();
    }
    if (collision) {
      phase = 'collision_rollback_observation';
      await page.waitForFunction(() => Number.isFinite(window.__p77DispatchTrace?.collisionUi?.observed_through_ms),
        null, {timeout: refusalWindow + 15_000, polling: 100});
    } else await page.waitForFunction(() => {
      const tape = window.__p77DispatchTrace;
      const up = tape.pointer?.up;
      const responded = tape.rows.some(row => row.at >= up && row.phase === 'fetch-response' && row.endpoint === 'timeline_commit' && row.status >= 200 && row.status < 300);
      const badge = tape.readBadge();
      const settled = tape.rows.some(row => row.at >= up && row.phase === 'badge' && row.state === 'saved');
      return badge.kind === 'refused' || badge.state === 'error' || (responded && settled && badge.state === 'saved');
    }, null, {timeout: saveTimeout, polling: 100});
    phase = 'after_public_head';
    if (!warm && !compiled && [...commits.values()].some(commit => commit.status >= 200 && commit.status < 300)) {
      await page.evaluate(() => { window.__p77DispatchTrace.probe = true; });
      after = await bounded(phase, postTimeout, () => publicSnapshot(page, stack.origin, fixture));
      proofAt = await page.evaluate(() => {
        const tape = window.__p77DispatchTrace;
        tape.probe = false;
        const at = performance.now();
        tape.mark('independent-public-read-complete', {}, at);
        return at;
      });
      move = exactMove(before, after, target);
    }
  } catch (error) {
    failure = phase;
    failureKind = errorKind(error);
    if (error instanceof UnsupportedGesture) unsupported = error.message;
  } finally {
    if (compiled) {
      network?.seal();
      terminalPublicProof = {status: 'unavailable', reason: 'browser_unavailable'};
      if (context) {
        try {
          settlementBadge = await bounded('settlement badge', 5000, () => page.evaluate(() => window.__p77DispatchTrace?.readBadge()));
        } catch { /* The independent public read still runs when the editor is unavailable. */ }
        try {
          await bounded('after_public_head', postTimeout, async () => {
            const probe = await context.newPage();
            await probe.goto(`${stack.origin}/api/runtime${projectKey}`, {waitUntil: 'commit', timeout: postTimeout});
            after = await publicSnapshot(probe, stack.origin, fixture);
          });
          const pinned = after.headRevision === pin.revision_id && after.publicationId === pin.publication_id && after.content_digest === pin.content_digest;
          const unchanged = pinned && beforeVerified && before.payload_digest === after.payload_digest;
          terminalPublicProof = {
            status: beforeVerified ? (unchanged ? 'unchanged' : 'changed') : 'observed_without_verified_before',
            pinned_head: pinned,
            clip_ids_match: sameIds(after.clipIds, expected),
            media_refs_match: beforeVerified ? sameIds(before.mediaRefs, after.mediaRefs) : null,
            occurrence_ids_match: exactOccurrences(after, occurrences),
            other_clips_unchanged: beforeVerified && target ? otherClipsUnchanged(before, after, target) : null,
          };
          if (beforeVerified && target) move = exactMove(before, after, target);
          if (freeSpace && beforeVerified) {
            terminalPublicProof.only_target_start_changed = exactFreeSpaceDiff(before, after, move);
            terminalPublicProof.shot_ids_unchanged = Array.isArray(after.payload.occurrences) &&
              isDeepStrictEqual(before.payload.occurrences.map(item => item.shot_id), after.payload.occurrences.map(item => item?.shot_id));
          }
          try {
            proofAt = await bounded('public confirmation clock', 5000, () => page.evaluate(() => {
              const at = performance.now();
              window.__p77DispatchTrace?.mark('independent-public-read-complete', {}, at);
              return at;
            }));
          } catch { /* The exact terminal head remains observed without a page clock. */ }
        } catch (error) {
          terminalPublicProof = {status: 'unavailable', reason: errorKind(error)};
          failure ??= 'after_public_head';
          failureKind ??= errorKind(error);
        }
      }
    } else if (warm) {
      terminalPublicProof = {status: 'unavailable', reason: 'before_head_unverified'};
      if (beforeVerified) {
        try {
          if (!page || page.isClosed() || new URL(page.url()).origin !== stack.origin) throw new Error('Owned public page is unavailable');
          await bounded('after_public_head', postTimeout, async () => {
            settlementBadge = await page.evaluate(() => {
              const tape = window.__p77DispatchTrace;
              if (!tape) return null;
              tape.probe = true;
              return tape.readBadge();
            });
            try {
              after = await publicSnapshot(page, stack.origin, fixture);
              proofAt = await page.evaluate(() => {
                const at = performance.now();
                window.__p77DispatchTrace?.mark('independent-public-read-complete', {}, at);
                return at;
              });
            } finally {
              await page.evaluate(() => {
                const tape = window.__p77DispatchTrace;
                if (tape) tape.probe = false;
              });
            }
          });
          const unchanged = before.headRevision === after.headRevision && before.publicationId === after.publicationId &&
            before.content_digest === after.content_digest && before.payload_digest === after.payload_digest;
          terminalPublicProof = {
            status: unchanged ? 'unchanged' : 'changed',
            clip_ids_match: sameIds(before.clipIds, after.clipIds),
            media_refs_match: sameIds(before.mediaRefs, after.mediaRefs),
            occurrence_ids_match: sameIds(before.entities.occurrenceIds, after.entities.occurrenceIds),
          };
          move = exactMove(before, after, target);
        } catch (error) {
          terminalPublicProof = {status: 'unavailable', reason: errorKind(error)};
          failure ??= 'after_public_head';
          failureKind ??= errorKind(error);
        }
      }
    }
    if (page && !page.isClosed()) {
      try {
        trace = await bounded('final tape', 5000, () => page.evaluate(() => {
          const tape = window.__p77DispatchTrace;
          return tape ? {rows: tape.rows, omitted: tape.omitted, counts: tape.counts, pointer: tape.pointer,
            finalBadge: tape.readBadge(), executedModules: tape.modules, warmHistory: tape.warmHistory,
            compiledMarkers: tape.compiledMarkers, initialFetch: tape.initialFetch, initialBasis: tape.initialBasis,
            timeOrigin: tape.timeOrigin, collisionUi: tape.collisionUi} : null;
        }));
      } catch { failure ??= 'final_tape'; }
    }
    if (network) {
      try { readMeasurements = await bounded('network measurement', 5000, () => network.readMeasurements()); }
      catch { /* Native and event-receipt evidence remain available if timing metadata is missing. */ }
    }
    try { await cleanup(); } catch { failure ??= 'browser_cleanup'; }
    if (compiled) {
      profileRemoved = profile ? !fs.existsSync(profile) : null;
      try {
        await verifyCompiledArtifact(receiptFile, receiptSha, stack.product);
        artifactsReverified = true;
      } catch { failure ??= 'compiled_artifact_postcheck'; }
    }
    try { readProductHead(stack.product, stack.tuple.app); } catch { failure ??= 'product_checkout_postcheck'; }
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    const rows = trace?.rows ?? [];
    const up = trace?.pointer?.up;
    const scoped = rows.filter(row => row.source !== 'timeline:save-diagnostic' || row.timelineId === fixture.timeline_id || row.timelineId === 'UNKNOWN');
    const edit = Number.isFinite(up) ? scoped.filter(row => row.at >= up) : [];
    const request = edit.find(row => row.phase === 'fetch-request' && row.endpoint === 'timeline_commit');
    const response = edit.find(row => row.phase === 'fetch-response' && row.endpoint === 'timeline_commit' && row.request === request?.request);
    const saved = edit.find(row => row.phase === 'badge' && row.state === 'saved' && row.at >= (response?.at ?? Infinity));
    const adoption = edit.find(row => row.phase === 'adoption-complete' && row.timelineId === fixture.timeline_id && row.current === true && row.at >= (response?.at ?? Infinity));
    const wire = [...(commits?.values() ?? [])];
    const receipt = wire[0]?.receipt;
    const authoritative = edit.find(row => row.phase === 'canonical-adoption-verified' && receipt &&
      row.revision === receipt.revision && row.publication === receipt.publication && row.at >= (adoption?.at ?? Infinity));
    finalBadge = trace?.finalBadge ?? {state: 'unobserved'};
    const assetAudit = network?.assetAudit();
    const markerMatch = compiled && sameIds(trace?.compiledMarkers ?? [], stack.artifact.receipt.modules.map(module => module.marker));
    const postBeforeUp = compiled && Number.isFinite(up) && rows.some(row => row.phase === 'fetch-request' &&
      row.endpoint === 'timeline_commit' && row.at < up);
    const compiledGestureProven = compiled && Boolean(beforeVerified && gestureData && wireAtGesture && wireAtDown && assetAudit?.complete &&
      markerMatch && artifactsReverified && browserClosed && profileRemoved && !trace?.omitted && !postBeforeUp && Number.isFinite(up) &&
      trace.pointer.initialAtDown && trace.pointer.initialAtUp &&
      (!settled || (wireAtGesture.pending === 0 && wireAtDown.pending === 0 && wireAtGesture.idle_ms >= idleWindow && wireAtDown.idle_ms >= idleWindow &&
        trace.pointer.initialFetch.requested === trace.pointer.initialFetch.responded + trace.pointer.initialFetch.failed &&
        trace.pointer.down - trace.pointer.initialFetch.lastActivity >= idleWindow)) &&
      (!freeSpace || (!trace.pointer.freeSpacePathInvalid && freeSpacePointsMatch(trace.pointer.freeSpaceDown, freeSpaceGeometry.source) &&
        freeSpacePointsMatch(trace.pointer.freeSpaceMove, freeSpaceGeometry.destination) &&
        freeSpacePointsMatch(trace.pointer.freeSpaceUp, freeSpaceGeometry.destination))));
    const nativeFreeSpace = freeSpace ? freeSpaceNativeBasis(edit, target) : null;
    const collisionResult = collision ? collisionObservation(edit, trace?.pointer, trace?.collisionUi, target) : null;
    const qualifiedCollision = Boolean(!failure && collisionResult?.qualified && compiledGestureProven &&
      !wire.length && !request && terminalPublicProof.status === 'unchanged' && terminalPublicProof.clip_ids_match &&
      terminalPublicProof.media_refs_match && terminalPublicProof.occurrence_ids_match && terminalPublicProof.other_clips_unchanged);
    const actualFreeSpace = freeSpace && move && freeSpaceGeometry && !freeSpaceGeometry.issue ? {
      start_seconds: move.to_seconds,
      end_seconds: move.to_seconds + freeSpaceDocument.span.duration_seconds,
      delta_seconds: move.to_seconds - freeSpaceDocument.span.start_seconds,
      start_error_seconds: move.to_seconds - freeSpaceGeometry.desired_start_seconds,
    } : null;
    const actualInFreeSpace = Boolean(actualFreeSpace && actualFreeSpace.delta_seconds > 0 &&
      actualFreeSpace.end_seconds < freeSpaceGeometry.visible_time_bounds_seconds[1] &&
      Math.abs(actualFreeSpace.start_error_seconds) <= 2 / freeSpaceGeometry.pixels_per_second + 0.002);
    if (!failure && !collision && wire.length === 1 && wire[0].exactCas && request && response && receipt && adoption &&
        (mode === 'one' || authoritative) && saved &&
        finalBadge.state === 'saved' && after?.headRevision === receipt.revision && after?.publicationId === receipt.publication &&
        before.headRevision !== after.headRevision && before.publicationId !== after.publicationId && before.content_digest !== after.content_digest &&
        sameIds(before.clipIds, after.clipIds) && sameIds(before.mediaRefs, after.mediaRefs) &&
        sameIds(before.entities.occurrenceIds, after.entities.occurrenceIds) && move && Number.isFinite(proofAt) && !trace?.omitted &&
        (!compiled || (compiledGestureProven && terminalPublicProof.occurrence_ids_match && terminalPublicProof.other_clips_unchanged)) &&
        (!freeSpace || (nativeFreeSpace.qualified && wire[0].exactAcceptedCas && receipt.content_digest === after.content_digest && actualInFreeSpace &&
          terminalPublicProof.only_target_start_changed && terminalPublicProof.shot_ids_unchanged))) {
      confirmed = {gesture_to_saved_ms: saved.at - up, gesture_to_public_confirmation_ms: proofAt - up};
    }
    const savePhases = new Set(['pointerup', 'schedule', 'capture-called', 'capture-resolved', 'capture-rejected', 'owner-error',
      'adoption-start', 'adoption-complete', 'adopted-read', 'session-changed', 'handoff-ready', 'basis-ready', 'basis-error',
      'outbox-append-start', 'outbox-append-persisted', 'pump-enter', 'pump-record-read', 'pump-ready-for-dispatch',
      'outbox-dispatch-enter', 'outbox-reservation-persisted', 'outbox-transmit-start', 'outbox-transmit-returned',
      'commit-response-basis-verified', 'outbox-acceptance-applied', 'canonical-adoption-verified', 'post-adoption-history-start',
      'post-adoption-history-complete']);
    const latest = (edit.length ? edit : scoped).filter(row => savePhases.has(row.phase) || row.endpoint === 'timeline_commit').at(-1);
    const saw = name => edit.some(row => row.phase === name);
    const deferred = scoped.filter(row => row.observer === 'app' && row.endpoint === 'deferred_history_limit_2');
    const getCountsAt = (events, at) => {
      if (!Number.isFinite(at)) return null;
      const observed = events.filter(row => row.at <= at);
      const requested = observed.filter(row => row.phase === 'fetch-request').length;
      const settledGets = observed.filter(row => ['fetch-response', 'fetch-failed'].includes(row.phase)).length;
      return {requested, settled: settledGets, in_flight: requested - settledGets};
    };
    const deferredGetsAt = at => getCountsAt(deferred, at);
    const handoff = scoped.filter(row => row.phase === 'handoff-ready' && row.timelineId === fixture.timeline_id && row.current === true).at(0);
    const verified = handoff?.originalHead?.revisionId === pin.revision_id && handoff?.originalHead?.publicationId === pin.publication_id;
    const deferredOption = scoped.find(row => row.phase === 'handoff-deferred-history-option');
    const deferredWalksAt = at => (modules || compiled) && Number.isFinite(at) ? scoped.filter(row => row.at <= at).reduce((count, row) =>
      count + Number(row.phase === 'deferred-history-scheduled') - Number(row.phase === 'deferred-history-finished'), 0) : null;
    const readEndpoints = ['history_head_limit_1', 'deferred_history_limit_2', 'history_full_limit_50', 'other_history', 'timeline_metadata', 'revision_index',
      'immutable_parent_revision', 'immutable_shot_revision', 'immutable_internal_revision'];
    const readsAt = at => Number.isFinite(at) ? Object.fromEntries(readEndpoints.map(endpoint => [endpoint,
      getCountsAt(scoped.filter(row => row.observer === 'app' && row.endpoint === endpoint), at)])) : null;
    const priorToWritable = at => Number.isFinite(readinessAt) && Number.isFinite(at) ? readinessAt - at : null;
    const initialBasis = trace?.initialBasis;
    const outcome = confirmed ? 'confirmed_saved' : collisionResult?.pointerup_to_visible_rollback_toast_ms != null &&
      collisionResult.clip_ended_at_original_pose ? 'refused_and_rolled_back' : finalBadge.kind === 'refused' ? 'refused' : 'unconfirmed';
    if (compiled) machineLoad.at_terminal = loadavg()[0];
    for (const row of rows) record({type: 'event', ...row});
    const summary = {type: 'summary', mode, outcome, failure: failure ?? null, failure_kind: failureKind ?? null, latest_observed_phase: latest?.phase ?? 'unobserved',
      latest_observed_event: latest ?? null, ...(unsupported ? {unsupported_condition: unsupported} : {}),
      user_visible_state: finalBadge, request_observed: wire.length > 0, commits: wire, before: safeSnapshot(before), after: safeSnapshot(after), move: move ?? null,
      ...(warm || compiled ? {terminal_public_proof: terminalPublicProof, settlement_user_visible_state: settlementBadge ?? null} : {}),
      ...(warm ? {
        deferred_history_install: trace?.warmHistory ?? null,
        deferred_history_current_at_pointerdown: trace?.pointer?.warmAtDown ?? null,
        deferred_history_current_at_pointerup: trace?.pointer?.warmAtUp ?? null} : {}),
      ui_writable_ms: readinessAt ?? null, pointerup_ms: Number.isFinite(up) ? up : null,
      handoff_ready_before_gesture: Number.isFinite(up) ? Boolean(handoff && handoff.at <= up) : null,
      handoff_ready_ms: handoff?.at ?? null, handoff_verified_fixture_head: handoff ? verified : null,
      ...(!compiled ? {deferred_history_configured_at_handoff: deferredOption?.configured ?? null,
        deferred_history_at_pointerup: Number.isFinite(up) ? {...deferredGetsAt(up), walks_in_flight: deferredWalksAt(up)} : null} : {}),
      module_audit: modules ? {...modules.audit(), executed: trace?.executedModules ?? []} : null,
      gesture_to_post_ms: request ? request.at - up : null, post_to_fetch_response_ms: response ? response.at - request.at : null,
      gesture_to_saved_ms: confirmed?.gesture_to_saved_ms ?? null,
      gesture_to_public_confirmation_ms: confirmed?.gesture_to_public_confirmation_ms ?? null,
      ...(compiled ? {
        compiled_artifact: {receipt_sha256: receiptSha, inputs_sha256: stack.artifact.receipt.inputs_sha256,
          output_sha256: stack.artifact.receipt.output_sha256, modules: stack.artifact.receipt.modules,
          executed_markers: trace?.compiledMarkers ?? [], markers_match: markerMatch, served: assetAudit ?? null,
          files_reverified: Boolean(artifactsReverified)},
        qualified_gesture: compiledGestureProven && (!freeSpace || nativeFreeSpace.same_track),
        timeline_post_before_pointerup: postBeforeUp,
        trusted_pointerdown_ms: trace?.pointer?.down ?? null,
        writable_to_pointerdown_ms: trace?.pointer && Number.isFinite(readinessAt) ? trace.pointer.down - readinessAt : null,
        fetch_response_to_saved_ms: saved && response && (!freeSpace || confirmed) ? saved.at - response.at : null,
        saved_to_public_confirmation_ms: confirmed ? proofAt - saved.at : null,
        gesture_guard: gestureData ?? null,
        initial_verified_history: initialBasis ?? null,
        initial_history_end_to_full_writable_ms: priorToWritable(initialBasis?.history?.end_ms),
        initial_loader_end_to_full_writable_ms: priorToWritable(initialBasis?.loader?.end_ms),
        initial_basis_end_to_full_writable_ms: priorToWritable(initialBasis?.basis?.end_ms),
        initial_history_current_at_writable: exactHistoryAtReady ?? null,
        initial_history_current_at_pointerdown: trace?.pointer?.initialAtDown ?? null,
        initial_history_current_at_pointerup: trace?.pointer?.initialAtUp ?? null,
        runtime_cpu_opening: openingCpu ?? null,
        machine_load_one_minute: machineLoad,
        history_verification_gets: {wire: compiledReadReport(readMeasurements, trace, readinessAt),
          browser_headers_at_writable: readsAt(readinessAt), browser_headers_at_pointerdown: readsAt(trace?.pointer?.down),
          browser_headers_at_pointerup: readsAt(up)},
        initial_gets: {idle_window_required_ms: settled ? idleWindow : null,
          playwright_at_writable: wireAtReady ?? null, playwright_before_pointerdown: wireAtGesture ?? null,
          playwright_after_pointerdown: wireAtDown ?? null, playwright_after_pointerup: wireAfterGesture ?? null,
          playwright_terminal: network?.snapshot() ?? null,
          browser_fetch_at_writable: browserFetchAtReady ?? null, browser_fetch_at_pointerdown: trace?.pointer?.initialFetch ?? null,
          browser_fetch_at_pointerup: trace?.pointer?.fetchAtUp ?? null},
        browser_closed: Boolean(browserClosed),
        profile_removed: profileRemoved ?? null,
      } : {}),
      ...(collision ? {collision: {...collisionResult, qualified_refusal_no_post: qualifiedCollision}} : {}),
      ...(freeSpace ? {free_space: {document: freeSpaceDocument ?? null, geometry: freeSpaceGeometry ?? null,
        interval: freeSpaceInterval ?? null, ...(expectedInterval ? {expected_interval: expectedInterval} : {}),
        actual: actualFreeSpace, actual_in_verified_interval: actualInFreeSpace, native_basis: nativeFreeSpace,
        qualified_refusal_no_post: Boolean(!failure && compiledGestureProven && nativeFreeSpace.qualified && !wire.length &&
          !request && outcome === 'refused' && terminalPublicProof.status === 'unchanged')}} : {}),
      endpoint_counts: trace?.counts ?? null, omitted_events: trace?.omitted ?? null,
      elapsed_ms: performance.now() - started,
      native_stages: {outbox_append: saw('outbox-append-persisted') ? 'persisted' : saw('outbox-append-start') ? 'entered' : 'unobserved',
        pump: saw('pump-record-read') ? 'read' : saw('pump-enter') ? 'entered' : 'unobserved',
        pending_reservation: saw('outbox-reservation-persisted') ? 'persisted' : 'unobserved',
        dispatch: saw('outbox-transmit-start') ? 'transmit entered' : saw('outbox-dispatch-enter') ? 'entered' : 'unobserved',
        authoritative_adoption: authoritative ? 'verified head and publication' : adoption ? 'app diagnostic observed' : 'unobserved'},
      time_basis: 'Event at values are monotonic milliseconds since editor navigation. Timing uses browser pointerup, app fetch and badge events. Playwright supplies the independent HTTP receipt.'};
    record(summary);
    fs.closeSync(out);
    console.log(JSON.stringify(summary));
    if ((!confirmed && !qualifiedCollision) || failure) process.exitCode = 1;
  }
}

if (process.argv.slice(2).some(value => value === '--help' || value === '-h')) {
  console.log(usage);
} else {
  try { await run(options(process.argv.slice(2))); }
  catch (error) {
    const message = error instanceof Error && /^(?:Usage:|SAVE_LOOP_|Modes? (?:one|on\/off|warm) |Compiled (?:modes|trace requires|receipt|output files|artifact must)|Fixture manifest |Stack, data |Runtime data |Versions and |Editor origin |The owned stack |Editor PID |Owned (?:proxy|launcher)|Product App )/.test(error.message)
      ? error.message : 'Trace setup failed before the browser was launched. Check required paths, ports and file access.';
    console.error(message);
    process.exitCode = 1;
  }
}
