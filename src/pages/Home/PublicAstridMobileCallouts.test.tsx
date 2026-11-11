// @vitest-environment jsdom
import { createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PublicAstridMobileCallouts } from './PublicAstridMobileCallouts';
import type { PublicAstridAudience } from './publicAstridMotion';

function setup(audience: PublicAstridAudience = 'app') {
  const stageRef = createRef<HTMLDivElement>();
  const view = (mode: PublicAstridAudience, active = true) => (
    <div ref={stageRef}>
      <div className="astrid-timeline-surface" />
      <div className="astrid-inspector-surface" />
      <div className="astrid-chat-surface" />
      <button data-astrid-agent-launcher>Open Agent</button>
      <PublicAstridMobileCallouts stageRef={stageRef} audience={mode} active={active} reducedMotion />
      <button>Outside control</button>
    </div>
  );
  const result = render(view(audience));
  return { ...result, stageRef, view };
}

describe('mobile feature disclosures', () => {
  afterEach(cleanup);

  it('reveals one card at a time and moves the highlight without moving focus', () => {
    const { stageRef } = setup();
    const edit = screen.getByRole('button', { name: 'Edit with your agents' });
    const effects = screen.getByRole('button', { name: 'Live-code effects' });
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    fireEvent.click(edit);
    expect(edit).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(edit.getAttribute('aria-controls')!)).toHaveAttribute('role', 'region');
    expect(stageRef.current!.querySelector('.astrid-timeline-surface')).toHaveAttribute('data-astrid-feature-highlight', 'timeline');
    effects.focus();
    fireEvent.click(effects);
    expect(edit).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByRole('region')).toHaveLength(1);
    expect(stageRef.current!.querySelector('.astrid-timeline-surface')).not.toHaveAttribute('data-astrid-feature-highlight');
    expect(stageRef.current!.querySelector('.astrid-inspector-surface')).toHaveAttribute('data-astrid-feature-highlight', 'effects');
    expect(effects).toHaveFocus();
    fireEvent.click(effects);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('dismisses on outside pointer or focus without stealing focus', () => {
    setup();
    const edit = screen.getByRole('button', { name: 'Edit with your agents' });
    const outside = screen.getByRole('button', { name: 'Outside control' });
    fireEvent.click(edit);
    fireEvent.pointerDown(outside);
    expect(edit).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(edit);
    fireEvent.focusIn(outside);
    expect(edit).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps integration links out of the closed card and returns focus on Escape', () => {
    setup('agent');
    const tools = screen.getByRole('button', { name: 'Connected to open-source tools' });
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    fireEvent.click(tools);
    const link = screen.getByRole('link', { name: 'ComfyUI' });
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    link.focus();
    fireEvent.keyDown(link, { key: 'Escape' });
    expect(tools).toHaveFocus();
    expect(tools).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('clears selection and highlights across audience changes and suspension', () => {
    const { rerender, stageRef, view } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Live-code effects' }));
    rerender(view('agent'));
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(stageRef.current!.querySelector('[data-astrid-feature-highlight]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reusable workflows' }));
    rerender(view('agent', false));
    expect(stageRef.current!.querySelector('[data-astrid-feature-highlight]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reusable workflows' })).not.toBeInTheDocument();
    rerender(view('agent'));
    expect(screen.getByRole('button', { name: 'Reusable workflows' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('does not bubble card clicks into the Agent backdrop', () => {
    const stageRef = createRef<HTMLDivElement>();
    let backgroundClicks = 0;
    render(
      <div ref={stageRef} onClick={() => backgroundClicks++}>
        <PublicAstridMobileCallouts stageRef={stageRef} audience="agent" active reducedMotion />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reusable workflows' }));
    fireEvent.click(screen.getByText(/Build on community-made plans/));
    expect(backgroundClicks).toBe(0);
  });
});
