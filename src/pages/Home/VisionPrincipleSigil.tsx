/** Small, original pixel-geometry marks for the four published principles.
 * Built as crisp SVG paths so they retain their edges at every device scale.
 * Colors belong to the card's existing --sigil-ink token; no raster assets. */
export function VisionPrincipleSigil({ principleId }: { principleId: string }) {
  return (
    <span className="astrid-vision-principle-sigil" aria-hidden="true">
      <svg className="astrid-vision-sigil-art" viewBox="0 0 40 40" fill="none"
        shapeRendering="crispEdges" focusable="false">
        {principleId === 'local-first-cloud-capable' ? (
          <>
            {/* A stable core surrounded by optional connections and an orbit. */}
            <g className="astrid-vision-sigil-orbit" fill="currentColor" opacity=".7">
              <rect x="18" y="3" width="4" height="2" />
              <rect x="27" y="7" width="3" height="2" />
              <rect x="34" y="18" width="2" height="4" />
              <rect x="28" y="30" width="3" height="2" />
              <rect x="18" y="35" width="4" height="2" />
              <rect x="8" y="30" width="3" height="2" />
              <rect x="4" y="18" width="2" height="4" />
              <rect x="9" y="7" width="3" height="2" />
              <rect x="31" y="11" width="2" height="3" />
              <rect x="31" y="26" width="2" height="3" />
              <rect x="7" y="11" width="2" height="3" />
              <rect x="7" y="26" width="2" height="3" />
            </g>
            <g className="astrid-vision-sigil-nodes" stroke="currentColor" strokeWidth="1.5">
              <path d="M20 5v7M35 20h-7M20 35v-7M5 20h7" />
              <rect x="18" y="2" width="4" height="4" fill="var(--astrid-paper)" />
              <rect x="34" y="18" width="4" height="4" fill="var(--astrid-paper)" />
              <rect x="18" y="34" width="4" height="4" fill="var(--astrid-paper)" />
              <rect x="2" y="18" width="4" height="4" fill="var(--astrid-paper)" />
            </g>
            <path className="astrid-vision-sigil-core" d="M16 13h8v3h3v12H13V16h3z" fill="currentColor" />
            <rect className="astrid-vision-sigil-window" x="18" y="20" width="5" height="5" fill="var(--astrid-paper)" />
          </>
        ) : principleId === 'open-by-design' ? (
          <>
            {/* An intentionally unsealed, permeable ring. */}
            <g className="astrid-vision-sigil-open-ring" stroke="currentColor" strokeWidth="3" strokeLinecap="butt">
              <path d="M14 7h12v3h5v5h3v10h-3v6h-6v3H14v-3H9v-6H6V15h3v-5h5" />
            </g>
            <g className="astrid-vision-sigil-open-sparks" fill="currentColor">
              <rect x="30" y="5" width="2" height="7" />
              <rect x="27" y="8" width="8" height="2" />
              <rect x="5" y="30" width="2" height="6" opacity=".65" />
              <rect x="3" y="32" width="6" height="2" opacity=".65" />
              <rect x="34" y="28" width="2" height="2" />
            </g>
          </>
        ) : principleId === 'in-the-creators-control' ? (
          <>
            {/* An offering palm and an independent, suspended spark. */}
            <path className="astrid-vision-sigil-hand" d="M5 31h5v-3h5v-3h8v-3h5v-6h-3v4h-4v-8h-3v10h-3v-7h-3v11H8v2H5z"
              stroke="currentColor" strokeWidth="2.1" strokeLinejoin="miter" />
            <path className="astrid-vision-sigil-hand-fingers" d="M10 29h10v-2h5v-3h3" stroke="currentColor" strokeWidth="1.6" opacity=".5" />
            <g className="astrid-vision-sigil-spark" fill="currentColor">
              <rect x="19" y="3" width="3" height="13" />
              <rect x="14" y="8" width="13" height="3" />
              <rect x="8" y="6" width="2" height="2" opacity=".7" />
              <rect x="29" y="4" width="2" height="2" opacity=".7" />
            </g>
          </>
        ) : principleId === 'eliminate-needless-technical-wrangling' ? (
          <>
            {/* Paths start knotted, then the clear line emerges on hover. */}
            <g className="astrid-vision-sigil-knot" stroke="currentColor" strokeWidth="2.2">
              <path d="M3 14h7v-6h8v5h7v9h-6v9H9v-7H5v-5h10v-8h8v-4h7" />
              <path d="M4 26h7v4h7v-7h6v-9h7v6h-6v6h-7v7" opacity=".65" />
              <path d="M7 10h3v8h9v-6" opacity=".75" />
            </g>
            <g className="astrid-vision-sigil-clear-path" stroke="currentColor" strokeWidth="2.5">
              <path d="M6 20h9v-4h9v4h10" />
              <path d="M30 16l4 4-4 4" />
            </g>
            <g fill="currentColor">
              <rect x="32" y="7" width="2" height="2" opacity=".55" />
              <rect x="7" y="35" width="2" height="2" opacity=".55" />
            </g>
          </>
        ) : (
          <path d="M20 4v11h11v10H20v11H10V25H0V15h10V4z" stroke="currentColor" strokeWidth="2" />
        )}
      </svg>
    </span>
  );
}
