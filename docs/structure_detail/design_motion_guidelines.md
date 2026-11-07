# Design & Motion Guidelines

## Purpose

Project-specific design patterns, animation timings, and interaction patterns for Astrid.
For general Tailwind/shadcn/lucide usage, see their official docs.

## Core Building Blocks

| Layer | Location | Purpose |
|-------|----------|---------|
| **Theme Tokens** | `tailwind.config.ts` | Color palette, shadows, animations via CSS variables (`hsl(var(--*))`) |
| **CSS Variables** | `src/index.css` | Defines `--background`, `--foreground`, `--wes-*` HSL values |
| **UI Primitives** | `src/shared/components/ui/` | Thin wrappers around shadcn-ui with project-level defaults |
| **Motion Helpers** | `src/shared/components/transitions/` | Reusable animation components (PageFadeIn, FadeInSection, etc.) |
| **High-Level Layout** | `src/app/Layout.tsx` & `src/shared/components/` | GlobalHeader, PaneHeader, etc. |

---

## Standard Transitions

| Component | Duration | Easing | Use Case |
|-----------|----------|--------|----------|
| **PageFadeIn** | 300ms | ease-out | Page/section entry |
| **FadeInSection** | 40ms delay | ease-out | Staggered list items |
| **Modal** | 150ms | ease-in-out | Dialog open/close |
| **Tooltip** | 100ms | ease | Quick hover states |

Source: `src/shared/components/transitions/`

---

## Modal Patterns

**Default**: Use `ModalContainer` (`src/shared/components/ModalContainer.tsx`) -- handles responsive sizing, header/footer/scroll, and mobile safe areas.

**Custom layouts** (tabbed, multi-step, etc.): Use `useModal` from `src/shared/hooks/useModal.ts`.

### Entrance Animations

All modals use the same center-based entrance (defined in `DialogContent`):

| Direction | Animation Classes |
|-----------|-------------------|
| **Enter** | `fade-in-0 zoom-in-95 slide-in-from-left-1/2 slide-in-from-top-[48%]` |
| **Exit** | `fade-out-0 zoom-out-95 slide-out-to-left-1/2 slide-out-to-top-[48%]` |
| **Duration** | 200ms |

Do not create custom entrance animations for individual modals.

### Scroll Fade (`useScrollFade`)

For modals with long scrollable content, `useScrollFade` (`src/shared/hooks/useScrollFade.ts`) shows a gradient fade above the footer when content overflows. Fade auto-hides at scroll bottom.

```tsx
const { showFade, scrollRef } = useScrollFade({ isOpen });
// Attach scrollRef to scrollable container, render fade overlay in footer wrapper
```

Used by: SettingsModal, PromptEditorModal, and other custom-layout modals.

---

## Mobile Double-Tap Detection

`onDoubleClick` is unreliable on mobile. Use this pattern instead (300ms detection window):

| Ref | Purpose |
|-----|---------|
| `lastTouchTimeRef` | Timestamp of last tap |
| `doubleTapTimeoutRef` | Pending single-tap timeout (cleared on double-tap) |

**Pattern summary:**
1. On `onTouchEnd`, compare `Date.now()` to `lastTouchTimeRef`
2. If delta < 300ms: clear pending timeout, fire double-tap action
3. Otherwise: set 300ms timeout for single-tap action
4. Clean up timeout on unmount via `useEffect`

**Key rules:**
- Desktop: standard `onDoubleClick` events
- Mobile: `onTouchEnd` with double-tap detection
- Use `isMobile` to conditionally apply handlers
- Disable `onClick` on mobile to prevent interference with touch detection

### Components Using This Pattern

| Component | Double-tap action |
|-----------|-------------------|
| `MediaGallery` | Open image lightbox |
| `VideoOutputsGallery` | Open video lightbox |
| `ShotImageManager` | Open image editor |
| `Timeline` | Open image lightbox |
| `HoverScrubVideo` | Supports both `onDoubleClick` and `onTouchEnd` props |

---

## Key Invariants

- Never hardcode colors -- use semantic tokens (`bg-background`, `text-foreground`, etc.)
- Use existing transition components from `src/shared/components/transitions/` before writing custom keyframes
- All hooks must be called before any early returns (Rules of Hooks)
- Icons: lucide-react exclusively

---

[Contributor entry point](../../AGENTS.md)
