import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import manifest from './asset-manifest.json';
import { EDITOR_TOUR_MEDIA, tourPlaybackUrl } from './tourMedia.ts';

const release = `public/astrid/onboarding/${manifest.version}/`;
const assets = manifest.assets as Record<string, { filename: string; sha256: string; size: number; derivedFrom?: string }>;
const bytesOf = (url: string) => readFileSync(`${release}${url.split('/').pop()}`);

/** Top-level MP4 box types, in file order. */
function boxes(bytes: Buffer): string[] {
  const types: string[] = [];
  for (let offset = 0; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    types.push(bytes.toString('latin1', offset + 4, offset + 8));
    offset += size === 1 ? Number(bytes.readBigUInt64BE(offset + 8)) : size || bytes.length;
  }
  return types;
}

it('matches the distributed manifest, with every file named by its SHA-256', () => {
  expect(JSON.parse(readFileSync(`${release}manifest.json`, 'utf8'))).toEqual(manifest);
  for (const [name, asset] of Object.entries(assets)) {
    const bytes = readFileSync(`${release}${asset.filename}`);
    expect(bytes.length, name).toBe(asset.size);
    expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(asset.sha256);
    expect(asset.filename.startsWith(asset.sha256), name).toBe(true);
    if (asset.derivedFrom) expect(assets[asset.derivedFrom]?.derivedFrom, name).toBeUndefined();
  }
});

it('keeps the originals as the timeline\'s files and adds small pictures for everything the tour shows', () => {
  for (const slot of [EDITOR_TOUR_MEDIA.frames[0], ...EDITOR_TOUR_MEDIA.stills, EDITOR_TOUR_MEDIA.guide, EDITOR_TOUR_MEDIA.video]) {
    expect(slot.url).toMatch(/\.(png|mp4)$/);
    expect(slot.displayUrl).toMatch(/\.webp$/);
    expect(slot.thumbUrl).toMatch(/\.webp$/);
    expect(bytesOf(slot.thumbUrl!).length).toBeLessThan(8 * 1024);
    expect(bytesOf(slot.displayUrl!).length).toBeLessThan(200 * 1024);
  }
});

it('plays renditions a plain muted <video> can start at once: index first, video only, phones get 540p', () => {
  for (const slot of [EDITOR_TOUR_MEDIA.guide, EDITOR_TOUR_MEDIA.video]) {
    for (const small of [true, false]) {
      const bytes = bytesOf(tourPlaybackUrl(slot, small));
      const order = boxes(bytes);
      // `moov` before `mdat`: the first frame needs only the head of the file, not a second request for its tail.
      expect(order.indexOf('moov')).toBeGreaterThan(-1);
      expect(order.indexOf('moov')).toBeLessThan(order.indexOf('mdat'));
      // One track (no audio): nothing for an autoplay policy or an audio decoder to object to.
      expect(bytes.toString('latin1').split('trak').length - 1).toBe(1);
      expect(bytes.includes(Buffer.from('mp4a'))).toBe(false);
    }
    expect(bytesOf(tourPlaybackUrl(slot, true)).length).toBeLessThan(1.2 * 1024 * 1024);
    expect(bytesOf(tourPlaybackUrl(slot, true)).length).toBeLessThan(bytesOf(slot.url).length / 3);
  }
  expect(tourPlaybackUrl({ url: '/plain.mp4', width: 1, height: 1 }, true)).toBe('/plain.mp4');
});
