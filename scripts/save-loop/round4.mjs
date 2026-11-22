// Opt-in Round 4 observations and guarded Undo. No scenario or fixture changes.
import {performance} from 'node:perf_hooks';
import {isDeepStrictEqual} from 'node:util';
import {publicSnapshot} from './assert.mjs';
import {sameIds} from './readiness.mjs';

export async function postOpenProbe({page, fixture, startup, marker, record}) {
  const url = `/api/runtime/v1/projects/${encodeURIComponent(fixture.project_id)}/timelines/${encodeURIComponent(fixture.timeline_id)}`;
  let attempts=0;
  try {
    for (;;) {
      const began=performance.now();
      const timeout=Math.min(10000, startup.remaining());
      let result;
      try { result=await startup.bounded('post_open_read', () => page.evaluate(async ({url, timeout, project, timeline}) => {
        const controller=new AbortController();
        const timer=setTimeout(()=>controller.abort(), timeout);
        try {
          const response=await fetch(url, {method:'GET', credentials:'same-origin', cache:'no-store', redirect:'manual', signal:controller.signal});
          if (response.redirected || response.type==='opaqueredirect') return {status:response.status, invalid:true};
          if (response.status<200 || response.status>=300) return {status:response.status};
          let body;
          try { body=await response.json(); }
          catch (error) { if (error instanceof SyntaxError) return {status:response.status, invalid:true}; throw error; }
          const data=body?.data ?? body;
          const valid=data && typeof data==='object' && !Array.isArray(data) && data.project_id===project && data.timeline_id===timeline && typeof data.head_revision_id==='string' && data.head_revision_id.length>0 && typeof data.head_publication_id==='string' && data.head_publication_id.length>0;
          return {status:response.status, valid:Boolean(valid)};
        } catch (error) {
          if (error?.name==='AbortError') return {error:'timeout'};
          if (error instanceof TypeError && error.message==='Failed to fetch') return {error:'fetch'};
          throw error;
        } finally { clearTimeout(timer); }
      }, {url, timeout, project:fixture.project_id, timeline:fixture.timeline_id})); } catch (error) {
        record({type:'post_open_read_attempt', attempt:++attempts, start_ms:began-marker, duration_ms:performance.now()-began, status:null, error:performance.now()>=startup.deadline ? 'deadline' : 'evaluation'});
        throw error;
      }
      const elapsed=performance.now()-began;
      const event={type:'post_open_read_attempt', attempt:++attempts, start_ms:began-marker, duration_ms:elapsed, status:result.status ?? null, error:result.error ?? null};
      record(event);
      if (result.invalid || (result.status>=200 && result.status<300 && result.valid!==true)) throw new Error('post-open timeline GET returned invalid or unscoped metadata');
      if (result.status>=200 && result.status<300 && elapsed<1000) {
        const done={type:'post_open_blocked', post_open_blocked_s:(performance.now()-marker)/1000, attempts, outcome:'available', limitation:'Timeline metadata availability only; not head or content verification.'};
        record(done); return done;
      }
      if (result.status && !(result.status>=200 && result.status<300) && ![502,503,504].includes(result.status)) throw new Error(`post-open timeline GET failed (${result.status})`);
      await startup.bounded('post_open_read', () => new Promise(resolve=>setTimeout(resolve, Math.min(1000,startup.remaining()))));
    }
  } catch (error) {
    record({type:'post_open_blocked', post_open_blocked_s:null, attempts, outcome:performance.now()>=startup.deadline ? 'timeout' : 'error', limitation:'No qualifying metadata response observed.'});
    throw error;
  }
}

export async function undoCleanup({page, fixture, baseUrl, result, allowEmpty = false}) {
  if (result?.pass !== true || !result.before?.headRevision || !result.after?.headRevision || !result.after?.publicationId || !result.public_snapshot?.before?.content_digest || !result.public_snapshot?.before?.payload_digest)
    throw new Error('undo refused: row lacks a successful and complete before/after witness');
  const before=await publicSnapshot(page, baseUrl, fixture, {allowEmpty});
  if (before.headRevision!==result.after.headRevision || before.publicationId!==result.after.publicationId || before.headRevision===result.before.headRevision || before.publicationId===result.before.publicationId)
    throw new Error('undo refused: public head or publication changed or did not advance');
  const timelineKey=`/v1/projects/${encodeURIComponent(fixture.project_id)}/timelines/${encodeURIComponent(fixture.timeline_id)}/commit`;
  const requests=[], responses=[];
  const isCommit=request=>request.method()==='POST' && new URL(request.url()).pathname.endsWith(timelineKey);
  const onRequest=request=>{ if (isCommit(request)) requests.push(request); };
  const onResponse=response=>{
    const request=response.request();
    if (isCommit(request)) {
      responses.push(response.json().then(body=>({request, status:response.status(), body})).catch(()=>({request, status:response.status(), body:null})));
    }
  };
  page.on('request',onRequest);
  page.on('response',onResponse);
  try {
    await page.evaluate(() => {
      const state=window.__saveLoopState;
      if (!state?.readBadge || !Array.isArray(state.transitions)) throw new Error('undo refused: badge observer missing');
      window.__saveLoopUndoTransitionStart=state.transitions.length;
    });
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => {
      const state=window.__saveLoopState;
      return state?.readBadge?.().state==='saved' && state.transitions.slice(window.__saveLoopUndoTransitionStart).some(entry=>entry.state==='saved');
    }, null, {timeout:90000});
    const end=performance.now()+1000;
    while (!responses.length && performance.now()<end) await page.waitForTimeout(20);
    const completed=await Promise.all(responses);
    const response=completed[0], data=response?.body?.data, receipt=response?.body?.receipt;
    const accepted=requests.length===1 && completed.length===1 && response.request===requests[0] && response.status>=200 && response.status<300 && ['accepted','rebased','merged'].includes(data?.status) && typeof data.accepted_revision_id==='string' && data.accepted_revision_id.length>0 && receipt?.command_kind==='timeline.commit' && receipt.project_id===fixture.project_id && typeof receipt.receipt_id==='string' && receipt.receipt_id.length>0 && isDeepStrictEqual(receipt.result,data);
    if (!accepted) throw new Error('undo did not produce a valid, unambiguous accepted commit receipt');
    const restored=await publicSnapshot(page, baseUrl, fixture, {allowEmpty});
    if (requests.length!==1 || responses.length!==1 || restored.headRevision!==data.accepted_revision_id || restored.publicationId!==receipt.receipt_id || restored.headCount!==1 || restored.headRevision===before.headRevision || restored.publicationId===before.publicationId || restored.content_digest!==result.public_snapshot.before.content_digest || restored.payload_digest!==result.public_snapshot.before.payload_digest || !sameIds(restored.clipIds,result.before.clipIds) || !sameIds(restored.mediaRefs,result.before.mediaRefs))
      throw new Error('undo did not reproduce the original public content and inventory in a distinct publication');
    return {changed:true, headRevision:restored.headRevision, publicationId:restored.publicationId, accepted_receipt:true};
  } finally { page.off('request',onRequest); page.off('response',onResponse); }
}
