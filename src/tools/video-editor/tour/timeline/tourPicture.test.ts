// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTourVideoEngine, type TourVideoEngine } from './tourPicture.ts';
import { installFakeMedia } from './tourPictureTestMedia.ts';

describe('the tour video engine', () => {
  let media: ReturnType<typeof installFakeMedia>;
  let engine: TourVideoEngine;
  const settle = () => Promise.resolve().then(() => Promise.resolve());

  beforeEach(() => {
    media = installFakeMedia();
    engine = createTourVideoEngine();
  });
  afterEach(() => {
    engine.dispose();
    media.restore();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('is a muted inline video with no autoplay attribute and no cross-origin mode', () => {
    const video = engine.element;
    expect(video.muted).toBe(true);
    expect(video.hasAttribute('muted')).toBe(true);
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.hasAttribute('autoplay')).toBe(false);
    expect(video.hasAttribute('crossorigin')).toBe(false);
    expect(video.preload).toBe('auto');
  });

  it('loads a source once and resets what it presented when the source changes', async () => {
    engine.load('/a.mp4');
    engine.load('/a.mp4');
    expect(media.load).toHaveBeenCalledTimes(1);
    const started = engine.start(1000);
    media.frame(engine.element, 0.1);
    await expect(started).resolves.toBe('playing');
    expect(engine.presenting()).toBe(true);
    engine.load('/b.mp4', 'metadata');
    expect(engine.presenting()).toBe(false);
    expect(engine.element.getAttribute('src')).toBe('/b.mp4');
    expect(engine.element.preload).toBe('metadata');
  });

  it('reports playing only once a frame of the playing video is presented, and then its time', async () => {
    engine.load('/a.mp4');
    const times: number[] = [];
    engine.onTime = (seconds) => times.push(seconds);
    const changed = vi.fn();
    engine.subscribe(changed);
    let result: string | undefined;
    void engine.start(5000).then((value) => { result = value; });
    await settle();
    expect(media.play).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
    expect(engine.presenting()).toBe(false);
    media.frame(engine.element, 0.04);
    await settle();
    expect(result).toBe('playing');
    expect(engine.presenting()).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(times).toEqual([0.04]);
  });

  it('gives up after the deadline but still shows a first frame that arrives late', async () => {
    vi.useFakeTimers();
    engine.load('/a.mp4');
    const started = engine.start(2500);
    vi.advanceTimersByTime(2500);
    await expect(started).resolves.toBe('timeout');
    expect(engine.presenting()).toBe(false);
    media.frame(engine.element, 0.2);
    expect(engine.presenting()).toBe(true);
  });

  it('says so when play() is refused, and retries inside the next user gesture', async () => {
    engine.load('/a.mp4');
    media.refuse = true;
    await expect(engine.start(5000)).resolves.toBe('rejected');
    expect(engine.presenting()).toBe(false);
    media.refuse = false;
    engine.prime();
    expect(media.play).toHaveBeenCalledTimes(2);
    media.frame(engine.element, 0.1);
    expect(engine.presenting()).toBe(true);
  });

  it('primes once per source inside a gesture: plays, then pauses at the start, and never touches a showing picture', async () => {
    engine.prime();
    expect(media.play).not.toHaveBeenCalled(); // nothing to play yet
    engine.load('/a.mp4');
    engine.prime();
    expect(media.play).toHaveBeenCalledTimes(1);
    await settle();
    expect(engine.element.paused).toBe(true);
    engine.prime();
    expect(media.play).toHaveBeenCalledTimes(1);

    const started = engine.start(1000);
    media.frame(engine.element, 3);
    await started;
    engine.prime(); // playing: left alone
    media.end(engine.element);
    engine.prime(); // ended and holding its last frame: never restarted
    expect(media.play).toHaveBeenCalledTimes(2);
  });

  it('restarts from 0, and hold() pauses without restarting', async () => {
    engine.load('/a.mp4');
    const first = engine.start(1000);
    media.frame(engine.element, 6);
    await first;
    engine.hold();
    expect(engine.element.paused).toBe(true);
    expect(engine.element.currentTime).toBe(6);
    media.frame(engine.element, 6.1); // a stray event while held is not a presented frame
    const second = engine.start(1000);
    expect(engine.element.currentTime).toBe(0);
    expect(engine.presenting()).toBe(false);
    media.frame(engine.element, 0.03);
    await expect(second).resolves.toBe('playing');
  });

  it('reports the end once and releases the element on dispose', async () => {
    engine.load('/a.mp4');
    const times: number[] = [];
    engine.onTime = (seconds, ended) => times.push(ended ? -seconds : seconds);
    const started = engine.start(1000);
    media.frame(engine.element, 13.9);
    await started;
    media.end(engine.element);
    expect(times).toEqual([13.9, -13.9]);
    engine.dispose();
    expect(engine.element.hasAttribute('src')).toBe(false);
    await expect(engine.start(10)).resolves.toBe('rejected');
  });
});
