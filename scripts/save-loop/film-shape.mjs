// Pure configuration and geometry for the generated film-shaped fixture.
export function parseFixtureOptions(args = [], env = {}) {
  const options = {};
  let prepareMedia = false;
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--prepare-media') {
      if (prepareMedia) throw new Error('duplicate option: --prepare-media');
      prepareMedia = true;
      continue;
    }
    if (!['--variant', '--clips', '--media-size'].includes(name)) throw new Error(`unknown option: ${name}`);
    if (options[name] !== undefined || i + 1 >= args.length || args[i + 1].startsWith('--'))
      throw new Error(`expected one value for ${name}`);
    options[name] = args[++i];
  }
  const variant = options['--variant'] ?? env.SAVE_LOOP_VARIANT ?? 'standard';
  if (!['standard', 'large-shots', 'film-shaped'].includes(variant)) throw new Error(`invalid variant: ${variant}`);
  if (prepareMedia && variant !== 'film-shaped') throw new Error('--prepare-media requires --variant film-shaped');
  const count = Number(options['--clips'] ?? env.SAVE_LOOP_CLIPS ?? (variant === 'film-shaped' ? 621 : 616));
  const minimum = variant === 'film-shaped' ? 23 : 616;
  if (!Number.isSafeInteger(count) || count < minimum)
    throw new Error(`invalid clip count: ${count}; minimum is ${minimum}`);
  const size = options['--media-size'] ?? env.SAVE_LOOP_MEDIA_SIZE ?? '1280x720';
  const match = /^(\d+)x(\d+)$/.exec(size);
  const width = Number(match?.[1]), height = Number(match?.[2]);
  if (!match || width < 2 || height < 2 || width > 7680 || height > 4320 || width % 2 || height % 2)
    throw new Error(`invalid media size: ${size}`);
  return {variant, clipCount: count, mediaSize: {width, height}, ...(prepareMedia ? {prepareMedia} : {})};
}

// Use the same generated sources and encoding as the standard large-shots
// fixture. The source is longer than any single shot in filmShape.
export function filmMediaCommands({width, height}, video, audio, image, video2, image2, audioDuration = 90, videoDuration = 90) {
  return [
    ['-f', 'lavfi', '-i', `testsrc2=s=${width}x${height}:r=15:d=${videoDuration}`, '-c:v', 'libx264',
      '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', video],
    ['-f', 'lavfi', '-i', `sine=frequency=317:sample_rate=44100:duration=${audioDuration}`, '-y', audio],
    ['-f', 'lavfi', '-i', `testsrc2=s=${width}x${height}:r=1`, '-frames:v', '1',
      '-threads', '1', '-y', image],
    ...(video2 ? [['-f', 'lavfi', '-i', `color=c=blue:s=${width}x${height}:r=15:d=${videoDuration}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', video2]] : []),
    ...(image2 ? [['-f', 'lavfi', '-i', `color=c=blue:s=${width}x${height}:r=1`, '-frames:v', '1', '-threads', '1', '-y', image2]] : []),
  ];
}

// Counts include two parent overlays and three parent elements. Coordinates use exact 30 fps frames;
// each overlay covers its referenced shot-owned original in parent time.
export function filmShape({clipCount = 621, shotCount = 46, ripple = false} = {}) {
  if (!Number.isSafeInteger(clipCount) || clipCount < 8) throw new Error('clipCount must be an integer >= 8');
  if (!Number.isSafeInteger(shotCount) || shotCount < 1) throw new Error('shotCount must be a positive integer');
  const frames = 196 * 30;
  const n = Math.min(shotCount, clipCount - 5, frames);
  const children = clipCount - 5;
  const shots = Array.from({length: n}, (_, index) => {
    const boundary = i => ripple && n > 1 && i > 0
      ? 127 + Math.floor((i - 1) * (frames - 127) / (n - 1)) : Math.floor(i * frames / n);
    const startFrame = boundary(index);
    const endFrame = boundary(index + 1);
    const count = ripple && n > 1 && children < 12 * n
      ? (index === 0 ? 12 : Math.floor(index * (children - 12) / (n - 1)) - Math.floor((index - 1) * (children - 12) / (n - 1)))
      : Math.floor((index + 1) * children / n) - Math.floor(index * children / n);
    const slots = Math.ceil(count / 4);
    const rows = Array.from({length: count}, (_, childIndex) => {
      const start = Math.floor(Math.floor(childIndex / 4) * (endFrame - startFrame) / slots);
      const end = Math.floor((Math.floor(childIndex / 4) + 1) * (endFrame - startFrame) / slots);
      return {index: childIndex, track: childIndex % 4, at: start / 30, hold: (end - start) / 30};
    });
    return {index, on: startFrame / 30, duration: (endFrame - startFrame) / 30, children: rows};
  });
  if (shots.some(shot => shot.children.some(child => child.hold <= 0)))
    throw new Error('too many clips for the fixture duration and track count');
  if (ripple) {
    if (shots.length < 2 || shots[0].children.length < 12) throw new Error('ripple fixture needs two populated shots');
    shots[0].duration = 4.2;
    for (const child of shots[0].children) {
      if (child.at + child.hold > shots[0].duration) child.hold = shots[0].duration - child.at;
    }
    shots[0].children.splice(11, 1);
    shots.slice(1).forEach(shot => shot.on -= 1 / 30);
  }
  const originals = (ripple ? shots.slice(1) : shots).flatMap(shot => shot.children.map(child => ({shot, child}))).slice(0, 2);
  const overlays = originals.map(({shot, child}) => ({shotIndex: shot.index, childIndex: child.index,
    at: shot.on + child.at, hold: child.hold}));
  const elements = ['built-in', 'collection-pack', 'project-pack'].map((kind, index) =>
    ({kind, at: 10 + index * 3, hold: 2}));
  return {durationSeconds: frames / 30, shots, overlays, elements, ...(ripple ? {ripple: true} : {})};
}

// The builder adds two narration clips after constructing the base shape.
export function filmFixtureShape(clipTarget) {
  if (!Number.isSafeInteger(clipTarget) || clipTarget < 23)
    throw new Error('film fixture minimum clip count is 23');
  const clipCount = clipTarget - 2;
  const shotCount = Math.min(46, Math.floor((clipTarget - 4) / 8), 1 + Math.floor((clipCount - 17) / 4));
  return filmShape({ripple: true, clipCount, shotCount});
}
