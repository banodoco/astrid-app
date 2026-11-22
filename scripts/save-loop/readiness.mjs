// The standard fixture generator assigns global indices in image/video/audio order.
export function expectedFixtureIds(fixture) {
  const counts = fixture.measurement?.accepted_prefix_asset_counts ?? fixture.media?.asset_counts;
  const count = fixture.measurement?.clip_count;
  if (!Number.isInteger(count) || count <= 0 || !counts || !['image','video','audio'].every(k=>Number.isInteger(counts[k]) && counts[k]>=0)) throw new Error('fixture lacks exact standard clip inventory');
  const ids=[];
  for (const kind of ['image','video','audio']) for (let i=0;i<counts[kind] && ids.length<count;i++) ids.push(`fixture-${kind}-${String(ids.length).padStart(4,'0')}`);
  if (ids.length!==count) throw new Error('fixture clip inventory does not cover expected count');
  return ids;
}
export function sameIds(actual, expected) {
  return actual.length===expected.length && new Set(actual).size===expected.length && new Set(expected).size===expected.length && expected.every(id=>actual.includes(id));
}

// Standard builder placement: image lanes every 6s, video every 5.2s,
// and three audio lanes every 1.4s. Clips all start at or after zero.
export function first15FixtureIds(fixture) {
  const ids=expectedFixtureIds(fixture);
  const counts=fixture.measurement?.accepted_prefix_asset_counts ?? fixture.media?.asset_counts;
  const images=counts.image, videos=counts.video;
  return ids.filter((id, i) => i < images ? Math.floor(i/4)*6 < 15
    : i < images+videos ? (i-images)*5.2 < 15
      : Math.floor((i-images-videos)/3)*1.4 < 15);
}

// Serialized into the page by Playwright; keep this function self-contained.
// A writable TrackLabel input shares the timeline editability policy with the
// clip surface. Selection is independently exercised before this predicate.
export function first15WritableCondition({expectedIds, project, timeline, targetClipId, targetTrackId}) {
  const url=new URL(location.href);
  if (url.searchParams.get('project')!==project || url.searchParams.get('timeline')!==timeline) return false;
  const visible=e=>{
    if (!e) return false;
    let r=e.getBoundingClientRect();
    if (r.width<=0 || r.height<=0) return false;
    let left=Math.max(0,r.left), right=Math.min(innerWidth,r.right), top=Math.max(0,r.top), bottom=Math.min(innerHeight,r.bottom);
    for (let parent=e;parent;parent=parent.parentElement) {
      const style=getComputedStyle(parent);
      if (style.display==='none' || style.visibility==='hidden') return false;
      if (parent!==e && /(auto|scroll|hidden|clip)/.test(style.overflowX+' '+style.overflowY)) {
        r=parent.getBoundingClientRect(); left=Math.max(left,r.left); right=Math.min(right,r.right); top=Math.max(top,r.top); bottom=Math.min(bottom,r.bottom);
      }
    }
    return right>left && bottom>top;
  };
  const actions=[...document.querySelectorAll('.clip-action[data-clip-id][data-row-id]')];
  if (!expectedIds.length || !expectedIds.every(id=>actions.some(e=>e.getAttribute('data-clip-id')===id && visible(e)))) return false;
  const target=actions.find(e=>e.getAttribute('data-clip-id')===targetClipId && e.getAttribute('data-row-id')===targetTrackId);
  if (!target || !visible(target) || target.getAttribute('role')!=='button' || target.tabIndex<0 || target.getAttribute('aria-disabled')==='true' || target.getAttribute('data-selected')!=='true') return false;
  const label=[...document.querySelectorAll('[data-track-label][data-track-id]')].find(e=>e.getAttribute('data-track-id')===targetTrackId);
  const input=label?.querySelector('input[aria-label="Track name"]');
  if (!input || input.readOnly || input.disabled || input.matches(':disabled') || input.getAttribute('aria-disabled')==='true' || !visible(input)) return false;
  return {track_id:targetTrackId, clip_id:targetClipId, clip_count:expectedIds.length, input:'Track name', selected:true};
}
