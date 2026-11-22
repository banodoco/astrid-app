import assert from 'node:assert/strict';
import {closeSync, fsyncSync, openSync, readFileSync, writeSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const playwrightPath = process.env.SAVE_LOOP_PLAYWRIGHT;
assert(playwrightPath, 'SAVE_LOOP_PLAYWRIGHT must name the installed Playwright module');
const {chromium: stockChromium} = await import(pathToFileURL(playwrightPath));

function observeGeometry({project, timeline, clipId, sourceTrack}) {
  const url = new URL(location.href);
  if (window.top !== window || url.pathname !== '/tools/video-editor' ||
      url.searchParams.get('project') !== project || url.searchParams.get('timeline') !== timeline) return;

  const clipSelector = `.clip-action[data-clip-id="${CSS.escape(clipId)}"]`;
  const trackSelector = '[data-row-id]:not([data-action-id]):not([data-clip-id])';
  const areaSelector = '.timeline-canvas-edit-area';
  const box = element => {
    const rect = element?.getBoundingClientRect();
    return rect ? [rect.left, rect.top, rect.width, rect.height] : null;
  };
  const hit = (x, y) => {
    const element = document.elementFromPoint(x, y);
    return {row: element?.closest('[data-row-id]')?.dataset.rowId ?? null,
      fixture_clip: Boolean(element?.closest(clipSelector))};
  };
  let active = null;
  let resultCount = 0;
  const report = (phase, x, y) => {
    try {
      if (resultCount++ >= 24) return;
      const area = document.querySelector(areaSelector);
      const clip = document.querySelector(clipSelector);
      const rows = {};
      for (const row of area?.querySelectorAll(trackSelector) ?? []) {
        const id = row.dataset.rowId;
        if (/^[VA][1-9]$/.test(id) && !(id in rows)) rows[id] = box(row);
      }
      const clipBox = box(clip);
      const sourceBox = rows[sourceTrack];
      const centerX = clipBox && clipBox[0] + clipBox[2] / 2;
      const hitSamples = phase === 'pointerdown' && clipBox && sourceBox ? {
        clip_center: hit(centerX, clipBox[1] + clipBox[3] / 2),
        source_row_top: hit(centerX, sourceBox[1] + 1),
        source_row_bottom: hit(centerX, sourceBox[1] + sourceBox[3] - 1),
      } : undefined;
      void window.__p77RecordGeometry({phase, at: performance.now(), x, y, hit: hit(x, y),
        viewport: [innerWidth, innerHeight], device_pixel_ratio: devicePixelRatio,
        window_scroll: [scrollX, scrollY], timeline_scroll: area ? [area.scrollLeft, area.scrollTop] : null,
        timeline_box: box(area), clip_track: clip?.dataset.rowId ?? null, clip_box: clipBox, rows, hit_samples: hitSamples,
      }).catch(() => {});
    } catch { /* A geometry observation cannot prevent the product gesture. */ }
  };
  window.addEventListener('pointerdown', event => {
    if (active || !event.isTrusted || event.button !== 0 || !(event.target instanceof Element) ||
        event.target.closest(clipSelector)?.dataset.rowId !== sourceTrack) return;
    active = event.pointerId;
    report('pointerdown', event.clientX, event.clientY);
  }, true);
  window.addEventListener('pointermove', event => {
    if (event.isTrusted && active === event.pointerId) report('pointermove', event.clientX, event.clientY);
  }, true);
  window.addEventListener('pointerup', event => {
    if (!event.isTrusted || active !== event.pointerId) return;
    const {clientX: x, clientY: y} = event;
    active = null;
    report('pointerup', x, y);
    requestAnimationFrame(() => report('first_frame_after_up', x, y));
    setTimeout(() => report('150ms_after_up', x, y), 150);
    setTimeout(() => report('1000ms_after_up', x, y), 1000);
  }, true);
  window.addEventListener('pointercancel', event => {
    if (event.isTrusted && active === event.pointerId) {
      active = null;
      report('pointercancel', event.clientX, event.clientY);
    }
  }, true);
}

export const chromium = {
  async launchPersistentContext(profile, options) {
    const root = process.env.SAVE_LOOP_ROOT;
    const origin = process.env.SAVE_LOOP_BASE_URL;
    assert(root && origin === 'http://127.0.0.1:2400' && profile.startsWith(path.join(root, 'p77-dispatch-chrome-')));
    assert.equal(readFileSync(path.join(root, '.sl1-stack-owned'), 'utf8'), `astrid-app-sl1-stack-v1 ${root}`);
    const fixture = JSON.parse(readFileSync(path.join(root, 'results/manifest.json'), 'utf8'));
    const target = fixture.clips.video.primary;
    assert(fixture.media.synthetic && fixture.live_proof.restored_version === 30 &&
      target.clip_id === 'fixture-video-0154' && target.track_id === 'V6');
    const fd = openSync(path.join(root, 'results/browser-geometry.jsonl'), 'wx', 0o600);
    let context;
    let count = 0;
    try {
      context = await stockChromium.launchPersistentContext(profile, options);
      await context.exposeBinding('__p77RecordGeometry', ({frame}, sample) => {
        const url = new URL(frame.url());
        if (url.origin !== origin || url.pathname !== '/tools/video-editor' ||
            url.searchParams.get('project') !== fixture.project_id || url.searchParams.get('timeline') !== fixture.timeline_id ||
            ++count > 24) return;
        writeSync(fd, JSON.stringify(sample) + '\n');
      });
      await context.addInitScript(observeGeometry, {project: fixture.project_id, timeline: fixture.timeline_id,
        clipId: target.clip_id, sourceTrack: target.track_id});
      context.on('close', () => { fsyncSync(fd); closeSync(fd); });
      return context;
    } catch (error) {
      await context?.close();
      closeSync(fd);
      throw error;
    }
  },
};
