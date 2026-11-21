const SAVE_BAR = 'div[role="alert"][data-save-bar]';

function unwrap(value) {
  return value?.data && typeof value.data === 'object' ? value.data : value;
}

function requestBody(request) {
  try { return request.postDataJSON(); } catch { return null; }
}

function requestUsesClip(body, clipId) {
  return typeof body === 'object' && body !== null && JSON.stringify(body).includes(clipId);
}

function cssEscape(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function waitWithTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function dragTrim(page, helpers, clip, deltaX) {
  const selector = `[data-resize-edge="right"][data-clip-id="${cssEscape(clip.clip_id)}"][data-row-id="${cssEscape(clip.track_id)}"]`;
  const handle = page.locator(selector).first();
  await handle.waitFor({state: 'visible', timeout: 30000});
  const box = await handle.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) throw new Error(`visible trim handle missing for ${clip.clip_id}`);
  const start = {x: box.x + box.width / 2, y: box.y + box.height / 2};
  await helpers.drag(page, start.x, start.y, start.x + deltaX, start.y);
  return {clipId: clip.clip_id, trackId: clip.track_id, input: 'right-edge trim', deltaPixels: deltaX};
}

async function publicHeadState(page, fixture) {
  const project = encodeURIComponent(fixture.project_id);
  const timeline = encodeURIComponent(fixture.timeline_id);
  const response = await page.evaluate(async ({project, timeline}) => {
    async function get(path) {
      const result = await fetch(`/api/runtime/v1/projects/${project}/timelines/${timeline}${path}`, {
        method: 'GET', credentials: 'same-origin', cache: 'no-store',
      });
      const text = await result.text();
      let body;
      try { body = JSON.parse(text); } catch { body = null; }
      if (result.status < 200 || result.status >= 300 || !body) {
        throw new Error(`public timeline GET ${path || '/'} failed (${result.status})`);
      }
      return body;
    }
    const metadata = get('');
    return metadata;
  }, {project, timeline});
  const metadata = unwrap(response);
  const headRevision = metadata?.head_revision_id ?? metadata?.headRevisionId;
  const publicationId = metadata?.head_publication_id ?? metadata?.headPublicationId ?? null;
  if (typeof headRevision !== 'string' || !headRevision) throw new Error('public timeline metadata omitted the current head revision');

  const details = await page.evaluate(async ({project, timeline, headRevision}) => {
    async function get(path) {
      const result = await fetch(`/api/runtime/v1/projects/${project}/timelines/${timeline}${path}`, {
        method: 'GET', credentials: 'same-origin', cache: 'no-store',
      });
      const text = await result.text();
      let body;
      try { body = JSON.parse(text); } catch { body = null; }
      if (result.status < 200 || result.status >= 300 || !body) throw new Error(`public revision GET failed (${result.status})`);
      return body;
    }
    const revision = get(`/composition-revisions/${encodeURIComponent(headRevision)}`);
    const items = [];
    let cursor = null;
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const query = new URLSearchParams({limit: '100'});
      if (cursor) query.set('cursor', cursor);
      const indexBody = await get(`/composition-revisions?${query}`);
      const index = indexBody?.data && typeof indexBody.data === 'object' ? indexBody.data : indexBody;
      if (!Array.isArray(index?.items)) throw new Error('public revision index omitted items');
      items.push(...index.items);
      cursor = index.next_cursor;
      if (!cursor) break;
      if (pageNumber === 99) throw new Error('public revision index exceeded 100 pages');
    }
    return {revision: await revision, items};
  }, {project, timeline, headRevision});
  const revision = unwrap(details.revision);
  const index = details;
  if (revision?.revision_id !== headRevision || !revision?.payload) throw new Error('public revision did not match the current head');
  const headCount = index.items.filter(item => item?.is_current_head === true).length;
  const clipIds = new Set();
  const seen = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'clips' && Array.isArray(child)) {
        for (const clip of child) {
          if (typeof clip?.id === 'string') clipIds.add(clip.id);
          visit(clip);
        }
      } else visit(child);
    }
  };
  visit(revision.payload);
  return {headRevision, publicationId, revision, clipIds: [...clipIds].sort(), headCount};
}

function statusOf(record) {
  return Number.isInteger(record?.status) ? record.status : null;
}

export async function clashScenario({page, secondPage, fixture, helpers}) {
  if (!page || !secondPage || !fixture?.clips?.video?.primary || !helpers?.drag || !helpers?.restoreScenario) {
    throw new Error('same-clip clash requires two pages, a primary video fixture clip, drag and restoreScenario helpers');
  }
  const clip = fixture.clips.video.primary;
  if (!clip.clip_id || !clip.track_id) throw new Error('fixture video primary needs clip_id and track_id');

  let releaseHeld = () => {};
  let routeHandler;
  let observedRequest;
  let secondActor = null;
  let secondAcceptedHead = null;
  let routeFailure = null;
  const targetPath = `/api/runtime/v1/projects/${encodeURIComponent(fixture.project_id)}/timelines/${encodeURIComponent(fixture.timeline_id)}/commit`;
  const isTargetCommit = request => request.method() === 'POST' && new URL(request.url()).pathname.endsWith(targetPath);

  return {
    name: 'two-tab same-clip clash',
    expected: 'clash',
    gesture: async ({before}) => {
      observedRequest = null;
      secondActor = null;
      secondAcceptedHead = null;
      routeFailure = null;
      let releaseGate;
      const releaseGatePromise = new Promise(resolve => { releaseGate = resolve; });
      releaseHeld = () => releaseGate();
      let signalIntercept;
      const intercepted = new Promise(resolve => { signalIntercept = resolve; });
      let secondResponse;
      let firstResponse;
      let gestureEndedAt = null;
      routeHandler = async route => {
        if (!isTargetCommit(route.request())) return route.continue();
        observedRequest = {body: requestBody(route.request()), url: new URL(route.request().url()).pathname};
        signalIntercept(observedRequest);
        await releaseGatePromise;
        try { await route.continue(); }
        catch (error) { routeFailure = String(error?.message ?? error); throw error; }
      };
      await page.route('**/api/runtime/v1/projects/**/timelines/**/commit', routeHandler);
      const firstResponsePromise = page.waitForResponse(response => isTargetCommit(response.request()), {timeout: 90000});
      try {
        const firstInput = dragTrim(page, helpers, clip, 5);
        const held = await waitWithTimeout(intercepted, 45000, 'first actor commit interception');
        const firstBody = held.body;
        const secondResponsePromise = secondPage.waitForResponse(response => isTargetCommit(response.request()), {timeout: 90000});
        const secondInput = await dragTrim(secondPage, helpers, clip, -8);
        gestureEndedAt = await page.evaluate(() => performance.timeOrigin + performance.now());
        secondResponse = await waitWithTimeout(secondResponsePromise, 90000, 'second actor commit response');
        const secondBody = requestBody(secondResponse.request());
        await secondPage.waitForFunction(() => {
          const leaves = [...document.querySelectorAll('div,span,button')].filter(element => element.children.length === 0);
          return leaves.some(element => /^saved$/i.test((element.textContent || '').trim()));
        }, null, {timeout: 30000});
        secondAcceptedHead = await publicHeadState(secondPage, fixture);
        secondActor = {
          status: secondResponse.status(),
          requestBasis: {revision: secondBody?.base_revision_id ?? null, publication: secondBody?.base_publication_id ?? null},
          requestTargetsClip: requestUsesClip(secondBody, clip.clip_id),
          acceptedHead: secondAcceptedHead,
          input: secondInput,
        };
        if (secondResponse.status() < 200 || secondResponse.status() >= 300) {
          throw new Error(`second actor did not save (commit status ${secondResponse.status()})`);
        }
        releaseHeld();
        firstResponse = await waitWithTimeout(firstResponsePromise, 90000, 'first actor conflict response');
        await page.waitForFunction(selector => {
          const bar = document.querySelector(selector);
          return !!bar && /Try again/.test(bar.innerText) && /Discard/.test(bar.innerText);
        }, SAVE_BAR, {timeout: 30000});
        const actualFirstStatus = firstResponse.status();
        return {
          gesture_ended_at: gestureEndedAt,
          actualInput: {
            first: await firstInput,
            second: secondInput,
            sameClipId: clip.clip_id,
            firstRequestBasis: {revision: firstBody?.base_revision_id ?? null, publication: firstBody?.base_publication_id ?? null},
            secondRequestBasis: secondActor.requestBasis,
            firstResponseStatus: actualFirstStatus,
            secondResponseStatus: secondActor.status,
            secondAcceptedHead: {
              headRevision: secondAcceptedHead.headRevision,
              publicationId: secondAcceptedHead.publicationId,
              clipIds: secondAcceptedHead.clipIds,
              headCount: secondAcceptedHead.headCount,
            },
            routeFailure,
          },
        };
      } finally {
        releaseHeld();
      }
    },
    verify: async ({before, after, result}) => {
      const firstConflict = (result?.commit_requests ?? []).some(entry => statusOf(entry) === 409);
      const refusal = result?.final_badge?.state === 'not saved' && result.final_badge.barCount > 0;
      const visibleReason = String(result?.final_badge?.text ?? '').replace(/Try again|Discard/g, '').trim();
      const sameInitialBasis = observedRequest?.body?.base_revision_id === before?.headRevision
        && observedRequest?.body?.base_publication_id === before?.publicationId
        && secondActor?.requestBasis?.revision === before?.headRevision
        && secondActor?.requestBasis?.publication === before?.publicationId;
      const secondSaved = secondActor?.status >= 200 && secondActor?.status < 300
        && secondAcceptedHead?.headRevision && secondAcceptedHead.headRevision !== before?.headRevision
        && secondAcceptedHead?.revision?.content_digest !== before?.revision?.content_digest;
      const acceptedStateStillCurrent = secondAcceptedHead?.headRevision === after?.headRevision
        && secondAcceptedHead?.publicationId === after?.publicationId
        && secondAcceptedHead?.revision?.content_digest === after?.revision?.content_digest
        && secondAcceptedHead?.headCount === 1 && after?.headCount === 1;
      const noClipLost = Array.isArray(before?.clipIds) && Array.isArray(after?.clipIds)
        && before.clipIds.every(id => after.clipIds.includes(id));
      const noOccurrenceLost = Array.isArray(before?.entities?.occurrenceIds) && Array.isArray(after?.entities?.occurrenceIds)
        && before.entities.occurrenceIds.every(id => after.entities.occurrenceIds.includes(id));
      const targetRemains = after?.clipIds?.includes(clip.clip_id) === true;
      const allInputsTargetSameClip = requestUsesClip(observedRequest?.body, clip.clip_id)
        && secondActor?.requestTargetsClip === true;
      const pass = firstConflict && refusal && !!visibleReason && result?.try_again_visible === true
        && result?.discard_visible === true && sameInitialBasis && secondSaved
        && acceptedStateStillCurrent && noClipLost && noOccurrenceLost && targetRemains && allInputsTargetSameClip && !routeFailure;
      return {
        pass,
        reason: pass ? 'second actor save remained current; first actor received a real 409 with the visible recovery reason and actions'
          : 'same-clip clash evidence incomplete; inspect public head, request bases, response statuses and visible recovery controls',
        evidence: {
          before: {headRevision: before?.headRevision, publicationId: before?.publicationId, headCount: before?.headCount},
          after: {headRevision: after?.headRevision, publicationId: after?.publicationId, headCount: after?.headCount},
          secondActor: secondActor ? {
            status: secondActor.status,
            requestBasis: secondActor.requestBasis,
            acceptedHead: {
              headRevision: secondActor.acceptedHead.headRevision,
              publicationId: secondActor.acceptedHead.publicationId,
              revision: secondActor.acceptedHead.revision,
              clipIds: secondActor.acceptedHead.clipIds,
              headCount: secondActor.acceptedHead.headCount,
            },
          } : null,
          firstActor: {requestBasis: observedRequest?.body ? {
            revision: observedRequest.body.base_revision_id ?? null,
            publication: observedRequest.body.base_publication_id ?? null,
          } : null, commitStatuses: (result?.commit_requests ?? []).map(statusOf),
            visibleReason, tryAgain: result?.try_again_visible === true, discard: result?.discard_visible === true},
          sameClipId: clip.clip_id,
          noClipLost, noOccurrenceLost,
          routeFailure,
        },
      };
    },
    cleanup: async context => {
      releaseHeld();
      if (routeHandler) await context.page.unroute('**/api/runtime/v1/projects/**/timelines/**/commit', routeHandler).catch(() => {});
      await context.helpers.restoreScenario({
        page: context.page,
        secondPage: context.secondPage,
        fixture: context.fixture,
        helpers: context.helpers,
        result: context.result,
      });
    },
  };
}
