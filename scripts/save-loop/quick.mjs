// Truthful Plan 77 indicator classification. Missing observations stay unknown.
export function trafficLight(value, {works, slow, broken = Infinity, refused = false} = {}) {
  if (refused || value?.refused === true) return {light:'broken', seconds:null, reason:'refused'};
  const seconds = typeof value === 'number' ? value : value?.seconds;
  if (!Number.isFinite(seconds) || seconds < 0) return {light:'unobserved', seconds:null, reason:value?.reason ?? 'not observed'};
  return {light:seconds <= works ? 'works' : seconds <= slow ? 'slow' : 'broken', seconds, reason:null};
}

export function quickIndicatorRow({size, label, usableSeconds, blockedSeconds, immediateSave, quietSave}) {
  const timing=value=>value?.timing?{...value.timing,...(value.timing.reason||value.reason?{reason:value.timing.reason??value.reason}:{})}:{request_observed:false,gesture_to_post_ms:null,post_to_response_ms:null,outcome:'unobserved',reason:value?.reason??'not observed'};
  return {
    type:'quick_indicator', size, label,
    usable:trafficLight(usableSeconds, {works:5, slow:15}),
    blocked:trafficLight(blockedSeconds, {works:2, slow:30}),
    immediate_save:trafficLight(immediateSave, {works:2, slow:10}),
    quiet_save:trafficLight(quietSave, {works:2, slow:10}),
    immediate_save_timing:timing(immediateSave),
    quiet_save_timing:timing(quietSave),
    thresholds_seconds:{usable:{works:5, slow:15, broken:'>15'}, save:{works:2, slow:10, broken:'refused or no Saved within 60'}, blocked:{works:2, slow:30, broken:'>30'}},
  };
}

export function quickSaveTiming(events, gestureEndedAt) {
  const request=Array.isArray(events)?events[0]:null;
  if (!request) return {request_observed:false,gesture_to_post_ms:null,post_to_response_ms:null,outcome:'unobserved',reason:'no scoped commit request observed'};
  const requestAt=request.requestAt;
  const responseAt=request.responseAt;
  const gestureValid=Number.isFinite(gestureEndedAt)&&Number.isFinite(requestAt);
  const postValid=Number.isFinite(requestAt)&&Number.isFinite(responseAt)&&responseAt>=requestAt;
  const beforeGesture=gestureValid&&requestAt<gestureEndedAt;
  const status=Number.isFinite(request.status)?request.status:null;
  return {
    request_observed:true,
    request_method:request.method,
    request_status:status,
    gesture_to_post_ms:gestureValid&&!beforeGesture?requestAt-gestureEndedAt:null,
    post_to_response_ms:postValid?responseAt-requestAt:null,
    outcome:request.error?'request_failed':status===null?'response_unconfirmed':status>=200&&status<300?'accepted':status===409?'refused':'http_failure',
    reason:beforeGesture?'commit request preceded the measured gesture end':!gestureValid?'gesture or request clock was unavailable':!postValid?(request.error??'matching response was not observed'):null,
  };
}

export function quickSaveValue(row, cleanupVerified=true) {
  const timing=row?.quick_save_timing??{request_observed:false,gesture_to_post_ms:null,post_to_response_ms:null,outcome:'unobserved',reason:'quick save timing was not recorded'};
  if (row?.settlement_outcome==='refusal' || timing.outcome==='refused') return {refused:true,reason:row.final_badge?.text||row.reason||'Runtime refused the save',timing};
  if (row?.settlement_outcome==='deadline' && Number.isFinite(row.settlement_timeout_ms) && row.settlement_timeout_ms>=60000 && Number.isFinite(row.settlement_elapsed_ms) && row.settlement_elapsed_ms>=60000)
    return {refused:true,reason:`no Saved after ${Math.round(row.settlement_elapsed_ms/1000)} seconds`,timing};
  if (row?.pass !== true || !cleanupVerified || !Number.isFinite(row.ms)) return {reason:!cleanupVerified?'cleanup was not verified':row?.reason??'save outcome not confirmed',timing};
  return {seconds:row.ms/1000,timing};
}

export function formatQuickTable(rows) {
  const cell = value => value.seconds === null ? value.light : `${value.light} ${value.seconds.toFixed(1)}s`;
  const duration=value=>Number.isFinite(value)?`${value.toFixed(0)} ms`:'unobserved';
  const lines = ['Size | Usable | Blocked | Save after open | Open gesture→POST | Open POST→response | Save after quiet | Quiet gesture→POST | Quiet POST→response', '--- | --- | --- | --- | --- | --- | --- | --- | ---'];
  for (const row of rows) lines.push(`${row.label || row.size} | ${cell(row.usable)} | ${cell(row.blocked)} | ${cell(row.immediate_save)} | ${duration(row.immediate_save_timing.gesture_to_post_ms)} | ${duration(row.immediate_save_timing.post_to_response_ms)} | ${cell(row.quiet_save)} | ${duration(row.quiet_save_timing.gesture_to_post_ms)} | ${duration(row.quiet_save_timing.post_to_response_ms)}`);
  return lines.join('\n');
}
