// Pure configuration and geometry for the generated film-shaped fixture.
export function parseFixtureOptions(args = [], env = {}) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (!['--variant', '--clips', '--media-size'].includes(name)) throw new Error(`unknown option: ${name}`);
    if (options[name] !== undefined || i + 1 >= args.length || args[i + 1].startsWith('--'))
      throw new Error(`expected one value for ${name}`);
    options[name] = args[++i];
  }
  const variant = options['--variant'] ?? env.SAVE_LOOP_VARIANT ?? 'standard';
  if (!['standard', 'large-shots', 'film-shaped'].includes(variant)) throw new Error(`invalid variant: ${variant}`);
  const count = Number(options['--clips'] ?? env.SAVE_LOOP_CLIPS ?? (variant === 'film-shaped' ? 621 : 616));
  if (!Number.isSafeInteger(count) || count < (variant === 'film-shaped' ? 8 : 616))
    throw new Error(`invalid clip count: ${count}`);
  const size = options['--media-size'] ?? env.SAVE_LOOP_MEDIA_SIZE ?? '1280x720';
  const match = /^(\d+)x(\d+)$/.exec(size);
  const width = Number(match?.[1]), height = Number(match?.[2]);
  if (!match || width < 2 || height < 2 || width > 7680 || height > 4320 || width % 2 || height % 2)
    throw new Error(`invalid media size: ${size}`);
  return {variant, clipCount: count, mediaSize: {width, height}};
}

// Counts include two parent overlays and three parent elements. Coordinates use exact 30 fps frames;
// each overlay covers its referenced shot-owned original in parent time.
export function filmShape({clipCount = 621, shotCount = 46} = {}) {
  if (!Number.isSafeInteger(clipCount) || clipCount < 8) throw new Error('clipCount must be an integer >= 8');
  if (!Number.isSafeInteger(shotCount) || shotCount < 1) throw new Error('shotCount must be a positive integer');
  const frames = 196 * 30;
  const n = Math.min(shotCount, clipCount - 5, frames);
  const children = clipCount - 5;
  const shots = Array.from({length: n}, (_, index) => {
    const startFrame = Math.floor(index * frames / n);
    const endFrame = Math.floor((index + 1) * frames / n);
    const count = Math.floor((index + 1) * children / n) - Math.floor(index * children / n);
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
  const originals = shots.flatMap(shot => shot.children.map(child => ({shot, child}))).slice(0, 2);
  const overlays = originals.map(({shot, child}) => ({shotIndex: shot.index, childIndex: child.index,
    at: shot.on + child.at, hold: child.hold}));
  const elements = ['built-in', 'collection-pack', 'project-pack'].map((kind, index) =>
    ({kind, at: 10 + index * 3, hold: 2}));
  return {durationSeconds: frames / 30, shots, overlays, elements};
}
