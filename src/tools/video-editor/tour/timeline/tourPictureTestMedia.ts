import { vi } from 'vitest';

/**
 * jsdom has no media pipeline. This stands in for one: `play()` resolves (or rejects while `refuse` is set), `paused` and
 * `currentTime` behave, and `frame(video, t)` is the browser presenting a frame at media time `t`.
 */
export function installFakeMedia() {
  const proto = HTMLMediaElement.prototype;
  const states = new WeakMap<HTMLMediaElement, { paused: boolean; time: number; ended: boolean }>();
  const of = (element: HTMLMediaElement) => {
    let state = states.get(element);
    if (!state) states.set(element, state = { paused: true, time: 0, ended: false });
    return state;
  };
  const original = Object.fromEntries(['paused', 'currentTime', 'ended'].map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)]));
  const media = {
    refuse: false,
    play: vi.spyOn(proto, 'play').mockImplementation(function (this: HTMLMediaElement) {
      if (media.refuse) return Promise.reject(new DOMException('refused', 'NotAllowedError'));
      Object.assign(of(this), { paused: false, ended: false });
      return Promise.resolve();
    }),
    pause: vi.spyOn(proto, 'pause').mockImplementation(function (this: HTMLMediaElement) { of(this).paused = true; }),
    load: vi.spyOn(proto, 'load').mockImplementation(() => undefined),
    frame(video: HTMLMediaElement, seconds: number) {
      of(video).time = seconds;
      video.dispatchEvent(new Event('timeupdate'));
    },
    end(video: HTMLMediaElement) {
      Object.assign(of(video), { paused: true, ended: true });
      video.dispatchEvent(new Event('ended'));
    },
    restore() {
      for (const [key, descriptor] of Object.entries(original)) if (descriptor) Object.defineProperty(proto, key, descriptor);
    },
  };
  Object.defineProperty(proto, 'paused', { configurable: true, get(this: HTMLMediaElement) { return of(this).paused; } });
  Object.defineProperty(proto, 'ended', { configurable: true, get(this: HTMLMediaElement) { return of(this).ended; } });
  Object.defineProperty(proto, 'currentTime', {
    configurable: true,
    get(this: HTMLMediaElement) { return of(this).time; },
    set(this: HTMLMediaElement, value: number) { Object.assign(of(this), { time: value, ended: false }); },
  });
  return media;
}
