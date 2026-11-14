import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PixelUnderline } from './PixelUnderline';

describe('shared pixel underline', () => {
  it('keeps the full phrase accessible with purely decorative square geometry', () => {
    const { container } = render(<h1>A tool to unlock <PixelUnderline>artistic potential</PixelUnderline>.</h1>);
    expect(screen.getByRole('heading')).toHaveTextContent('A tool to unlock artistic potential.');
    const path = container.querySelector('path')!;
    expect(path.getAttribute('d')).not.toMatch(/[CQSA]/i);
    expect(path).toHaveAttribute('d', 'M1 7H99');
    expect(path).toHaveAttribute('stroke-linecap', 'square');
    expect(path).toHaveAttribute('stroke-linejoin', 'miter');
    expect(path.closest('svg')).toHaveAttribute('shape-rendering', 'crispEdges');
    expect(path.closest('svg')).toHaveAttribute('aria-hidden', 'true');
  });
  it('leaves entrance timing to its consumer and forwards source attributes', () => {
    const { container } = render(<PixelUnderline data-tour-emphasis strokeClassName="editor-tour-underline">really need</PixelUnderline>);
    expect(container.querySelector('[data-tour-emphasis]')).toHaveTextContent('really need');
    expect(container.querySelector('path')).toHaveClass('pixel-underline-stroke', 'editor-tour-underline');
    expect(container.querySelector('path')).toHaveAttribute('stroke-dasharray', '1');
  });
});
