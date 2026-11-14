import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import './PixelUnderline.css';

/** An out-of-flow, straight underline with square pixel edges. Callers own when (or whether) it draws. */
export function PixelUnderline({ children, className = '', strokeClassName = '', strokeStyle, ...props }:
  HTMLAttributes<HTMLSpanElement> & {
    children: ReactNode;
    strokeClassName?: string;
    strokeStyle?: CSSProperties;
  }) {
  return <span {...props} className={'pixel-underline relative whitespace-nowrap ' + className}>
    {children}
    <svg aria-hidden="true" focusable="false"
      className="pixel-underline-mark absolute pointer-events-none"
      viewBox="0 0 100 12" preserveAspectRatio="none" shapeRendering="crispEdges">
      <path className={'pixel-underline-stroke ' + strokeClassName} style={strokeStyle}
        d="M1 7H99"
        pathLength={1} strokeDasharray={1} fill="none" stroke="currentColor"
        strokeWidth={2.5} strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  </span>;
}
