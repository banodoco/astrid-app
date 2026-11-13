import { useLayoutEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, X } from 'lucide-react';

export function VisionDialog({ title, eyebrow, identity, className = '', children, onClose, next }: {
  title: string;
  eyebrow: string;
  identity: string;
  className?: string;
  children: ReactNode;
  onClose: () => void;
  next?: { label: string; onClick: () => void };
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const [scrollEdges, setScrollEdges] = useState({ top: false, bottom: false });
  const titleId = useId();


  useLayoutEffect(() => {
    if (dialogRef.current && !dialogRef.current.open) {
      dialogRef.current.showModal();
      // Focus the descriptive heading rather than the X: Safari otherwise
      // paints a strong focus ring on the auto-focused close button at open.
      titleRef.current?.focus({ preventScroll: true });
    }
  }, []);

  // Chrome on iPhone changes its visible viewport as browser controls move.
  // Bind panel position and height to that same viewport; CSS applies safe areas
  // once with max(), rather than adding a second home-indicator-sized gap.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const viewport = window.visualViewport;
    let frame = 0;
    const update = () => {
      frame = 0;
      // Do not undo the user's pinch zoom by continually shrinking the dialog.
      if (viewport && viewport.scale > 1.05) return;
      dialog.style.setProperty('--vision-viewport-top', (viewport?.offsetTop ?? 0) + 'px');
      dialog.style.setProperty('--vision-viewport-height', (viewport?.height ?? window.innerHeight) + 'px');
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    update();
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, []);

  // Keep the native modal/top layer, but reset disclosures and scroll per subject.
  useLayoutEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 0; }, [identity]);

  // Show a fade only where scrollable content actually continues. Observe both the
  // viewport and its content so expanded aspirations, gaps and projects update the edges too.
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    const inner = scrollContentRef.current;
    if (!viewport || !inner) return;

    const updateEdges = () => {
      const remaining = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      const top = remaining > 2 && viewport.scrollTop > 2;
      const bottom = remaining > 2 && viewport.scrollTop < remaining - 2;
      setScrollEdges(previous =>
        previous.top === top && previous.bottom === bottom ? previous : { top, bottom });
    };

    viewport.addEventListener('scroll', updateEdges, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateEdges);
    observer?.observe(viewport);
    observer?.observe(inner);
    updateEdges();
    return () => {
      viewport.removeEventListener('scroll', updateEdges);
      observer?.disconnect();
    };
  }, [identity]);

  const backdropPointerRef = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(null);
  const isOutsidePanel = (clientX: number, clientY: number) => {
    const dialog = dialogRef.current;
    if (!dialog?.open) return false;
    const bounds = dialog.getBoundingClientRect();
    return clientX < bounds.left || clientX > bounds.right ||
      clientY < bounds.top || clientY > bounds.bottom;
  };

  return (
    <dialog
      ref={dialogRef}
      className={'astrid-vision-details ' + className}
      aria-labelledby={titleId}
      data-has-next={Boolean(next) || undefined}
      onClose={onClose}
      onPointerDownCapture={event => {
        // Keep the native modal top layer until the gesture's final click.
        // A requestAnimationFrame after pointerup can precede Safari's click.
        backdropPointerRef.current = event.isPrimary && event.button === 0 &&
          event.target === event.currentTarget && isOutsidePanel(event.clientX, event.clientY)
          ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false } : null;
        if (backdropPointerRef.current) event.stopPropagation();
      }}
      onPointerMoveCapture={event => {
        const gesture = backdropPointerRef.current;
        if (gesture?.pointerId === event.pointerId &&
            Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 10) {
          gesture.moved = true;
        }
      }}
      onPointerUpCapture={event => {
        const gesture = backdropPointerRef.current;
        if (gesture?.pointerId !== event.pointerId) return;
        if (gesture.moved || !isOutsidePanel(event.clientX, event.clientY)) backdropPointerRef.current = null;
        event.stopPropagation();
        // Do not cancel the default action: consume the compatibility click below.
      }}
      onPointerCancelCapture={event => {
        if (backdropPointerRef.current?.pointerId === event.pointerId) backdropPointerRef.current = null;
      }}
      onClickCapture={event => {
        const beganOnBackdrop = backdropPointerRef.current !== null;
        backdropPointerRef.current = null;
        // Keyboard activation of a child can report (0, 0); coordinates alone
        // would mistake it for a backdrop click and break disclosures and links.
        if (event.target !== event.currentTarget || !isOutsidePanel(event.clientX, event.clientY)) return;
        event.preventDefault();
        event.stopPropagation();
        // This click already has a fixed target. It cannot activate a card beneath.
        if (beganOnBackdrop) dialogRef.current?.close();
      }}
    >
      <div className="astrid-vision-details-shell">
        <header className="astrid-vision-details-header">
          <div className="astrid-vision-details-header-copy">
            <p className="astrid-vision-details-eyebrow">
              {eyebrow}
            </p>
            <h2 id={titleId} ref={titleRef} tabIndex={-1} aria-live="polite">{title}</h2>
          </div>
          <button type="button" className="astrid-vision-details-close" aria-label="Close details"
            onClick={event => { event.stopPropagation(); dialogRef.current?.close(); }}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className="astrid-vision-details-scroll-frame">
          <div className="astrid-vision-details-scroll" ref={scrollRef}>
            <div className="astrid-vision-details-scroll-inner" ref={scrollContentRef} key={identity}>
              {children}
            </div>
          </div>
          {next && <button type="button" className="astrid-vision-details-next"
            aria-label={next.label} title={next.label}
            onClick={event => { event.stopPropagation(); next.onClick(); }}>
            <ChevronRight size={24} aria-hidden="true" />
          </button>}
          <div className="astrid-vision-details-scroll-fade astrid-vision-details-scroll-fade--top"
            data-visible={scrollEdges.top || undefined} aria-hidden="true" />
          <div className="astrid-vision-details-scroll-fade astrid-vision-details-scroll-fade--bottom"
            data-visible={scrollEdges.bottom || undefined} aria-hidden="true" />
        </div>
      </div>
    </dialog>
  );
}
