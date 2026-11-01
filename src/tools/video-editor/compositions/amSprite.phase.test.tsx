// @vitest-environment jsdom

import {cleanup, render} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import AmSprite from '../../../../vendor/astrid-browser/astrid/packs/astrid_motion/rendering/elements/effects/am-sprite/component.tsx';

const remotion = vi.hoisted(() => ({frame: 0}));

vi.mock('remotion', () => ({
  Img: ({src, ...props}: Record<string, unknown>) => <img data-asset-source={src} {...props} />,
  staticFile: (src: string) => src,
  useCurrentFrame: () => remotion.frame,
}));

afterEach(cleanup);

const startingPose = {x: 4, y: 9, flipX: true};
const shiftedPose = {x: 12, y: 15, flipX: false};

const originalParams = {
  x: 2,
  y: 4,
  flipX: false,
  stepFrames: 2 as const,
  keyframes: [
    {frame: 0, x: 2, y: 4, flipX: false},
    {frame: 8, ...startingPose},
    {frame: 30, ...shiftedPose},
  ],
  frames: {frameWidth: 8, frameHeight: 8, count: 4, fps: 12, sequence: [0, 2, 1]},
  blinkAt: [20, 28],
  blinkIndex: 3,
};

// This is the later chapter piece produced at output frame 11 with speed 1.5:
// it carries the active held pose and shifts the next keyframe into piece time.
const cutParams = {
  x: startingPose.x,
  y: startingPose.y,
  flipX: startingPose.flipX,
  stepFrames: 2 as const,
  keyframes: [{frame: 14, ...shiftedPose}],
  frames: originalParams.frames,
  blinkAt: originalParams.blinkAt,
  blinkIndex: originalParams.blinkIndex,
  sourceClock: {offsetFrames: 11, speed: 1.5},
};

function renderSprite(params: typeof originalParams | typeof cutParams, frame: number) {
  remotion.frame = frame;
  const props = {
    clip: {params},
    params,
    assetEntry: {url: '/sprite.png', resolution: '8x8'},
    fps: 24,
  } as Parameters<typeof AmSprite>[0];
  const view = render(<AmSprite {...props} />);
  const markup = view.container.innerHTML;
  view.unmount();
  return markup;
}

describe('vendored am-sprite source clock', () => {
  it('preserves fractional source phase and held poses across a chapter cut', () => {
    expect(cutParams).toMatchObject({
      ...startingPose,
      keyframes: [{frame: 14, ...shiftedPose}],
      sourceClock: {offsetFrames: 11, speed: 1.5},
    });

    for (const pieceFrame of [0, 1, 2, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]) {
      const originalSourceFrame = Math.floor((pieceFrame + 11) * 1.5);
      expect(renderSprite(cutParams, pieceFrame), `piece frame ${pieceFrame}`)
        .toBe(renderSprite(originalParams, originalSourceFrame));
    }
  });
});
