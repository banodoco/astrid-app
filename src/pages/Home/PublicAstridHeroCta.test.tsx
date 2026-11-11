// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicAstridHeroCta } from './PublicAstridHeroCta';

describe('PublicAstridHeroCta', () => {
  afterEach(cleanup);

  it('offers a single link to the demo, noting that Astrid is free to run locally', () => {
    render(<PublicAstridHeroCta active />);
    expect(screen.getByRole('link', { name: 'Visit demo Free to run locally' })).toHaveAttribute('href', '/tools/video-editor');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not save the app preference on a phone', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('iPhone');
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    render(<PublicAstridHeroCta />);
    screen.getByRole('link', { name: /^Visit demo/ }).click();
    expect(localStorage.getItem('astrid:prefers-app')).toBeNull();
  });
});
