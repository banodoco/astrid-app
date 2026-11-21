/*
 * Public, browser-observable assertions for the Plan 77 save loop.
 * This deliberately observes only the sandbox editor page and Runtime public
 * routes. It never repairs, retries, reloads, or discards a user's draft.
 */

const SAVE_BADGE_SELECTOR = 'div[role="alert"][data-save-bar]';
const COMMIT_PATH = /\/commit(?:\?|$)/;
const DEFAULT_TIMEOUT_MS = 90_000;

function decodeResponse(value) {
  return value?.data && typeof value.data === 'object' ? value.data : value;
}

function normalizedText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function reasonOf(error) {
  return String(error?.message ?? error ?? 'unknown recorder failure').slice(0, 1000);
}

async function installBadgeObserver(page) {
  await page.evaluate((saveBarSelector) => {
    const state = window.__saveLoopState ??= {transitions: []};
    const read = () => {
      const bars = [...document.querySelectorAll(saveBarSelector)];
      if (bars.length) {
        const text = bars.map((element) => element.innerText).join(' ');
        return {state: 'not saved', text: text.replace(/\s+/g, ' ').trim(), barCount: bars.length};
      }
      const leaves = [...document.querySelectorAll('div,span,button')]
        .filter((element) => element.children.length === 0)
        .map((element) => (element.textContent ?? '').trim().toLowerCase());
      const state = leaves.find((value) => /^(saved|saving\.*|not saved|error|unsaved\.*|save failed)$/.test(value));
      return {state: state ?? 'unknown', text: state ?? '', barCount: 0};
    };
    state.readBadge = read;
    state.lastBadge = read();
    state.observer?.disconnect();
    state.observer = new MutationObserver(() => {
      const current = read();
      if (current.state !== state.lastBadge.state || current.text !== state.lastBadge.text) {
        state.transitions.push({
          at: performance.timeOrigin + performance.now(),
          state: current.state,
          text: current.text,
          barCount: current.barCount,
        });
        state.lastBadge = current;
      }
    });
    state.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-save-bar', 'aria-label', 'aria-live'],
    });
  }, SAVE_BADGE_SELECTOR);
}

async function readObserverState(page) {
  return page.evaluate(() => {
    const recorder = window.__saveLoopState;
    return {
      badge: recorder?.readBadge?.() ?? {state: 'unknown', text: '', barCount: 0},
      transitions: [...(recorder?.transitions ?? [])],
      now: performance.timeOrigin + performance.now(),
    };
  });
}

function idsInPayload(payload) {
  const clips = new Set();
  const occurrences = new Set();
  const seen = new Set();
  const visit = (value, parentKey = '') => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, parentKey);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (Array.isArray(item) && key === 'clips') {
        for (const clip of item) {
          if (clip && typeof clip.id === 'string') clips.add(clip.id);
          visit(clip, 'clips');
        }
        continue;
      }
      if (Array.isArray(item) && /occurrences/i.test(key)) {
        for (const occurrence of item) {
          if (occurrence && typeof occurrence.id === 'string') occurrences.add(occurrence.id);
          visit(occurrence, key);
        }
        continue;
      }
      if (parentKey === 'clips' && key === 'id' && typeof item === 'string') clips.add(item);
      if (/occurrences/i.test(parentKey) && key === 'id' && typeof item === 'string') occurrences.add(item);
      visit(item, key);
    }
  };
  visit(payload);
  return {clipIds: [...clips].sort(), occurrenceIds: [...occurrences].sort()};
}

function fixtureMediaTokens(media) {
  const tokens = new Set();
  const visit = (value) => {
    if (typeof value === 'string') {
      tokens.add(value);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(media);
  return [...tokens].filter(Boolean);
}

async function publicSnapshot(page, baseUrl, fixture) {
  const encodedProject = encodeURIComponent(fixture.project_id);
  const encodedTimeline = encodeURIComponent(fixture.timeline_id);
  const timelineUrl = new URL(
    `/api/runtime/v1/projects/${encodedProject}/timelines/${encodedTimeline}`,
    baseUrl,
  ).href;
  const response = await page.evaluate(async (url) => {
    const result = await fetch(url, {method: 'GET', credentials: 'same-origin', cache: 'no-store'});
    const text = await result.text();
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    return {status: result.status, body};
  }, timelineUrl);
  if (response.status < 200 || response.status >= 300 || !response.body) {
    throw new Error(`public timeline metadata GET failed (${response.status})`);
  }
  const timeline = decodeResponse(response.body);
  const headId = timeline?.head_revision_id ?? timeline?.headRevisionId;
  if (typeof headId !== 'string' || !headId) {
    throw new Error('public timeline metadata did not expose an active head_revision_id');
  }
  const revisionUrl = new URL(
    `/api/runtime/v1/projects/${encodedProject}/timelines/${encodedTimeline}/composition-revisions/${encodeURIComponent(headId)}`,
    baseUrl,
  ).href;
  const revisionResponse = await page.evaluate(async (url) => {
    const result = await fetch(url, {method: 'GET', credentials: 'same-origin', cache: 'no-store'});
    const text = await result.text();
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    return {status: result.status, body};
  }, revisionUrl);
  if (revisionResponse.status < 200 || revisionResponse.status >= 300 || !revisionResponse.body) {
    throw new Error(`public composition revision GET failed (${revisionResponse.status})`);
  }
  const revision = decodeResponse(revisionResponse.body);
  if (revision?.revision_id !== headId || !revision?.payload || typeof revision.content_digest !== 'string') {
    throw new Error('public composition revision did not match the active head or expose payload/content_digest');
  }
  const payload = revision.payload;
  const payloadText = JSON.stringify(payload);
  const payloadDigest = await page.evaluate(async (text) => {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }, payloadText);
  // Count heads from the public revision index. If pagination or the index
  // response is incomplete, fail the snapshot rather than inventing a count.
  const revisionsUrl = new URL(
    `/api/runtime/v1/projects/${encodedProject}/timelines/${encodedTimeline}/composition-revisions?limit=100`,
    baseUrl,
  ).href;
  const listed = [];
  let nextUrl = revisionsUrl;
  for (let pageNumber = 0; nextUrl && pageNumber < 100; pageNumber += 1) {
    const listing = await page.evaluate(async (requestUrl) => {
      const result = await fetch(requestUrl, {method: 'GET', credentials: 'same-origin', cache: 'no-store'});
      const text = await result.text();
      let body;
      try { body = JSON.parse(text); } catch { body = null; }
      return {status: result.status, body};
    }, nextUrl);
    if (listing.status < 200 || listing.status >= 300 || !listing.body) {
      throw new Error(`public composition revision index GET failed (${listing.status})`);
    }
    const index = decodeResponse(listing.body);
    if (!Array.isArray(index?.items)) throw new Error('public composition revision index omitted items');
    listed.push(...index.items);
    const cursor = index.next_cursor;
    nextUrl = cursor ? `${revisionsUrl}&cursor=${encodeURIComponent(cursor)}` : null;
  }
  if (nextUrl) throw new Error('public composition revision index exceeded 100 pages');
  const headCount = listed.filter((item) => item?.is_current_head === true).length;
  if (headCount !== 1 || !listed.some((item) => item?.revision_id === headId && item?.is_current_head === true)) {
    throw new Error(`public revision index reports ${headCount} active heads (expected exactly one)`);
  }
  const publicationId = timeline?.head_publication_id ?? timeline?.headPublicationId ?? null;
  const entities = idsInPayload(payload);
  const mediaRefs = fixtureMediaTokens(fixture.media).filter((token) => payloadText.includes(token)).sort();
  return {
    project_id: fixture.project_id,
    timeline_id: fixture.timeline_id,
    headRevision: headId,
    publicationId,
    revision,
    clipIds: entities.clipIds,
    mediaRefs,
    headCount,
    // Compatibility names used internally by the recorder.
    head_revision_id: headId,
    content_digest: revision.content_digest,
    payload_digest: payloadDigest,
    entities,
    payload,
    metadata: timeline,
  };
}

function idsRemoved(before = [], after = []) {
  const later = new Set(after);
  return before.filter((id) => !later.has(id));
}

function setDifference(left = [], right = []) {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item));
}

function reasonText(bar) {
  return normalizedText(bar?.text).replace(/Try again|Discard/g, '').trim();
}

function toRecordTimes(events) {
  return events.map((event) => ({
    method: event.method,
    url: event.url,
    request_at: event.requestAt,
    response_at: event.responseAt ?? null,
    status: event.status ?? null,
    response_error: event.error ?? null,
  }));
}

function defaultAssertion(expected, before, after, result, hasScenarioVerify) {
  const commit = result.commit_requests;
  const changedHead = before.head_revision_id !== after.head_revision_id;
  const changedContent = before.content_digest !== after.content_digest || before.payload_digest !== after.payload_digest;
  const disappearedClips = idsRemoved(before.entities.clipIds, after.entities.clipIds);
  const disappearedOccurrences = idsRemoved(before.entities.occurrenceIds, after.entities.occurrenceIds);
  const addedClips = setDifference(after.entities.clipIds, before.entities.clipIds);
  const addedOccurrences = setDifference(after.entities.occurrenceIds, before.entities.occurrenceIds);
  const removedMediaRefs = idsRemoved(before.mediaRefs, after.mediaRefs);
  result.head_change = {
    before: before.head_revision_id,
    after: after.head_revision_id,
    changed: changedHead,
    content_changed: changedContent,
  };
  result.entity_delta = {added_clips: addedClips, removed_clips: disappearedClips,
    added_occurrences: addedOccurrences, removed_occurrences: disappearedOccurrences,
    removed_media_refs: removedMediaRefs};

  if (expected === 'saved') {
    const acceptedCommit = commit.some((entry) => entry.status >= 200 && entry.status < 300);
    const savedAt = result.badge_transitions
      .filter((entry) => entry.state === 'saved' && entry.at >= result.row_started_at)
      .at(-1)?.at;
    const observedIntermediate = result.badge_transitions.some((entry) =>
      entry.state === 'saving' || entry.state === 'not saved' || entry.state === 'error');
    result.saved_at = Number.isFinite(savedAt) ? savedAt : null;
    result.ms = Number.isFinite(savedAt) ? Math.max(0, savedAt - result.gesture_ended_at) : null;
    if (!acceptedCommit) return {pass: false, reason: 'no successful public timeline commit response was observed'};
    if (!changedHead || !changedContent) return {pass: false, reason: 'public head and immutable content did not both change'};
    if (!Number.isFinite(result.ms)) return {pass: false, reason: 'no post-gesture Saved badge transition was observed'};
    if (!observedIntermediate && savedAt < result.gesture_ended_at) {
      return {pass: false, reason: 'Saved was already present without a row-specific save-state transition'};
    }
    if ((disappearedClips.length || disappearedOccurrences.length || removedMediaRefs.length) && !hasScenarioVerify) {
      return {pass: false, reason: 'clip, occurrence or fixture media references disappeared; scenario verify must account for intended split/delete deltas'};
    }
    return {pass: true, reason: disappearedClips.length || disappearedOccurrences.length || removedMediaRefs.length
      ? 'commit accepted, public head/content changed, Saved observed; scenario verify owns intended media/entity delta'
      : 'commit accepted, public head/content changed, and Saved was observed'};
  }

  const refusedBar = result.final_badge?.state === 'not saved' && result.final_badge.barCount > 0;
  const hasActions = result.try_again_visible && result.discard_visible;
  const reason = reasonText(result.final_badge);
  const conflictResponse = commit.some((entry) => entry.status === 409);
  if ((changedHead || changedContent) && !hasScenarioVerify) {
    return {pass: false, reason: 'head/content changed during refusal without a scenario witness'};
  }
  if (!conflictResponse) return {pass: false, reason: 'no HTTP 409 commit response proved a real clash'};
  if (!refusedBar || !hasActions || !reason) return {pass: false, reason: 'refusal reason or Try again/Discard controls were not visible'};
  return {pass: true, reason: `HTTP 409 clash refused with recovery actions${changedHead || changedContent ? '; scenario verify must prove same-clip witness' : ''}: ${reason}`};
}

/** Create an observable row recorder for the current fixture page. */
export async function createRecorder(page, {fixture, baseUrl, resultsPath} = {}) {
  if (!page || typeof page.evaluate !== 'function') throw new TypeError('createRecorder requires a Playwright page');
  if (!fixture?.project_id || !fixture?.timeline_id) throw new Error('fixture must include project_id and timeline_id');
  if (typeof baseUrl !== 'string' || !baseUrl) throw new Error('baseUrl is required');
  if (typeof resultsPath !== 'string' || !resultsPath) throw new Error('resultsPath is required');
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('baseUrl must use http or https');
  await installBadgeObserver(page);

  const timelineKey = `/v1/projects/${encodeURIComponent(fixture.project_id)}/timelines/${encodeURIComponent(fixture.timeline_id)}`;
  const networkEvents = [];
  const clock = await page.evaluate(() => ({wall: Date.now(), page: performance.timeOrigin + performance.now()}));
  const toPageTime = (wallTime) => clock.page + (wallTime - clock.wall);
  const onRequest = (request) => {
    if (request.method() !== 'POST' || !request.url().includes(timelineKey) || !COMMIT_PATH.test(request.url())) return;
    networkEvents.push({method: request.method(), url: request.url(), requestAt: toPageTime(Date.now()), status: null});
  };
  const onResponse = (response) => {
    const request = response.request();
    if (request.method() !== 'POST' || !request.url().includes(timelineKey) || !COMMIT_PATH.test(request.url())) return;
    const matched = [...networkEvents].reverse().find((event) => event.url === request.url() && event.status === null);
    if (matched) {
      matched.responseAt = toPageTime(Date.now());
      matched.status = response.status();
    }
  };
  const onRequestFailed = (request) => {
    if (request.method() !== 'POST' || !request.url().includes(timelineKey) || !COMMIT_PATH.test(request.url())) return;
    const matched = [...networkEvents].reverse().find((event) => event.url === request.url() && event.status === null);
    if (matched) matched.error = request.failure()?.errorText ?? 'request failed';
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);

  async function runRow(descriptor) {
    const rowStartedAt = await page.evaluate(() => performance.timeOrigin + performance.now());
    const eventStart = networkEvents.length;
    let before;
    let after;
    let gestureOutput;
    let gestureEndedAt;
    let verifierCalled = false;
    const result = {
      name: descriptor?.name ?? 'unnamed scenario',
      iteration: descriptor?.iteration ?? null,
      expected: descriptor?.expected ?? null,
      pass: false,
      reason: 'row did not complete',
      ms: null,
      row_started_at: rowStartedAt,
    };
    try {
      if (!descriptor || typeof descriptor.gesture !== 'function' || !['saved', 'clash'].includes(descriptor.expected)) {
        throw new TypeError('descriptor requires name, gesture, and expected saved|clash');
      }
      before = await publicSnapshot(page, baseUrl, fixture);
      result.before_head = before.headRevision;
      result.before = {headRevision: before.headRevision, publicationId: before.publicationId,
        clipIds: before.clipIds, mediaRefs: before.mediaRefs, headCount: before.headCount};
      const observerStart = await readObserverState(page);
      result.badge_before = observerStart.badge;
      const transitionCount = observerStart.transitions.length;

      gestureOutput = await descriptor.gesture({page, fixture, before});
      const gestureClock = await page.evaluate(() => ({at: performance.timeOrigin + performance.now()}));
      gestureEndedAt = Number.isFinite(gestureOutput?.gesture_ended_at)
        ? gestureOutput.gesture_ended_at
        : gestureClock.at;
      result.gesture_ended_at = gestureEndedAt;
      result.gesture_result = gestureOutput && typeof gestureOutput === 'object'
        ? (gestureOutput.actualInput ?? gestureOutput.input ?? null)
        : null;

      const deadline = Date.now() + (Number.isFinite(descriptor.timeoutMs) ? descriptor.timeoutMs : DEFAULT_TIMEOUT_MS);
      let finalState;
      while (Date.now() < deadline) {
        finalState = await readObserverState(page);
        const changedTransitions = finalState.transitions.slice(transitionCount);
        const hasSavedTransition = changedTransitions.some((entry) => entry.state === 'saved');
        const hasRefusal = finalState.badge.state === 'not saved' && finalState.badge.barCount > 0;
        if (descriptor.expected === 'saved' ? hasSavedTransition : hasRefusal) break;
        await page.waitForTimeout(50);
      }
      finalState ??= await readObserverState(page);
      result.final_badge = finalState.badge;
      result.badge_transitions = finalState.transitions.slice(transitionCount);
      result.try_again_visible = await page.getByRole('button', {name: 'Try again', exact: true}).isVisible().catch(() => false);
      result.discard_visible = await page.getByRole('button', {name: 'Discard', exact: true}).isVisible().catch(() => false);

      const scopedEvents = networkEvents.slice(eventStart);
      // A short grace period lets the Runtime response event settle after the badge changes.
      if (scopedEvents.some((entry) => entry.status === null)) {
        const graceDeadline = Date.now() + 1000;
        while (Date.now() < graceDeadline && scopedEvents.some((entry) => entry.status === null)) await page.waitForTimeout(20);
      }
      result.commit_requests = toRecordTimes(scopedEvents);
      after = await publicSnapshot(page, baseUrl, fixture);
      result.after_head = after.headRevision;
      result.public_snapshot = {
        before: {head_revision_id: before.head_revision_id, content_digest: before.content_digest, payload_digest: before.payload_digest},
        after: {head_revision_id: after.head_revision_id, content_digest: after.content_digest, payload_digest: after.payload_digest},
      };
      result.after = {headRevision: after.headRevision, publicationId: after.publicationId,
        clipIds: after.clipIds, mediaRefs: after.mediaRefs, headCount: after.headCount};
      const assertion = defaultAssertion(descriptor.expected, before, after, result, typeof descriptor.verify === 'function');
      let custom = {pass: true};
      if (typeof descriptor.verify === 'function') {
        verifierCalled = true;
        const value = await descriptor.verify({before, after, result});
        custom = typeof value === 'boolean' ? {pass: value, reason: value ? undefined : 'scenario-specific verification failed'}
          : value && typeof value === 'object' ? value : {pass: false, reason: 'scenario verify returned no assertion'};
      }
      result.pass = assertion.pass && custom.pass === true;
      result.reason = [assertion.reason, custom.reason].filter(Boolean).join('; ');
      if (custom.evidence !== undefined) result.verify_evidence = custom.evidence;
      if (descriptor.expected === 'saved' && !Number.isFinite(result.ms)) result.ms = null;
    } catch (error) {
      result.pass = false;
      result.reason = reasonOf(error);
      result.error = reasonOf(error);
      result.ms = null;
      // A failed public read is evidence of a failed row, never a synthetic head/count.
      if (before && !result.commit_requests) result.commit_requests = toRecordTimes(networkEvents.slice(eventStart));
    }
    // Verify hooks also inspect failed/refused rows (for example, to prove a
    // failed drop left its placeholder). Keep this callback observational.
    if (typeof descriptor?.verify === 'function' && !verifierCalled) {
      try {
        verifierCalled = true;
        const value = await descriptor.verify({before, after, result});
        const custom = typeof value === 'boolean' ? {pass: value, reason: value ? undefined : 'scenario-specific verification failed'}
          : value && typeof value === 'object' ? value : {pass: false, reason: 'scenario verify returned no assertion'};
        result.verify_evidence = custom.evidence;
        if (custom.pass !== true) result.pass = false;
        if (custom.reason) result.reason = `${result.reason}; ${custom.reason}`;
      } catch (error) {
        result.pass = false;
        result.reason = `${result.reason}; scenario verification failed: ${reasonOf(error)}`;
      }
    }
    result.recorded_at = new Date().toISOString();
    const fs = await import('node:fs');
    fs.appendFileSync(resultsPath, JSON.stringify({type: 'row', ...result}) + '\n');
    return result;
  }

  function finish() {
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('requestfailed', onRequestFailed);
    return page.evaluate(() => window.__saveLoopState?.observer?.disconnect());
  }

  return {runRow, finish};
}
