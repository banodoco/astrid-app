// Truthful Plan 77 indicator classification. Missing observations stay unknown.
export function trafficLight(value, {works, slow, broken = Infinity, refused = false} = {}) {
  if (refused || value?.refused === true) return {light:'broken', seconds:null, reason:'refused'};
  const seconds = typeof value === 'number' ? value : value?.seconds;
  if (!Number.isFinite(seconds) || seconds < 0) return {light:'unobserved', seconds:null, reason:value?.reason ?? 'not observed'};
  return {light:seconds <= works ? 'works' : seconds <= slow ? 'slow' : 'broken', seconds, reason:null};
}

export function quickIndicatorRow({size, label, usableSeconds, blockedSeconds, immediateSave, quietSave}) {
  return {
    type:'quick_indicator', size, label,
    usable:trafficLight(usableSeconds, {works:5, slow:15}),
    blocked:trafficLight(blockedSeconds, {works:2, slow:30}),
    immediate_save:trafficLight(immediateSave, {works:2, slow:10}),
    quiet_save:trafficLight(quietSave, {works:2, slow:10}),
    thresholds_seconds:{usable:{works:5, slow:15, broken:'>15'}, save:{works:2, slow:10, broken:'refused or no Saved within 60'}, blocked:{works:2, slow:30, broken:'>30'}},
  };
}

export function formatQuickTable(rows) {
  const cell = value => value.seconds === null ? value.light : `${value.light} ${value.seconds.toFixed(1)}s`;
  const lines = ['Size | Usable | Blocked | Save after open | Save after quiet', '--- | --- | --- | --- | ---'];
  for (const row of rows) lines.push(`${row.label || row.size} | ${cell(row.usable)} | ${cell(row.blocked)} | ${cell(row.immediate_save)} | ${cell(row.quiet_save)}`);
  return lines.join('\n');
}
