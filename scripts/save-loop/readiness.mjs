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
