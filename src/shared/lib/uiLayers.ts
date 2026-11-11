/** Shared z-layer contract for cross-module overlay ordering. */
export const UI_Z_LAYERS = {
  HOME_GLASS_PANE: 100,
  LIGHTBOX_MODAL: 100010,
  // Locked panes must sit above the lightbox (but below non-lightbox modals,
  // which render at OVERLAY_BASE_Z_INDEX = 110000+, see shared.tsx).
  GENERATIONS_PANE_BACKDROP: 100012,
  GENERATIONS_PANE: 100013,
  GENERATIONS_DROP_CHIP: 100014,
  TASKS_PANE_TAB_ABOVE_LIGHTBOX: 100015,
  // Pane body sits above the tab so the pane visually covers the tab handle when open; above GenerationsPane so the bottom strip stays clickable.
  TASKS_PANE_CONTENT: 100016,
  // Astrid's "stopped" / "restarted" card is the one thing to act on, so it stays clickable over the Tasks pane it overlaps at the bottom right.
  RUNTIME_RECOVERY_CARD: 100017,
  // Desktop gallery hover peek (the eye): floats above the pane it was opened from.
  GALLERY_PEEK: 100018,
  // The editor tour's own copy of the Generations pane (tour/gallery): above every real pane layer, under the shield.
  EDITOR_TOUR_GALLERY: 100019,
  // The editor tour's input shield and card cover everything, panes included, so the Tasks pane chat is dimmed and blocked too.
  EDITOR_TOUR_SHIELD: 100020,
  EDITOR_TOUR_CARD: 100021,
  // Toasts must clear non-lightbox modals (110000+), so keep this above 110020
  // (the highest practical modal popup z at layer ~2).
  TOAST_VIEWPORT: 120000,
  TASKS_PANE_TAB_BEHIND_LIGHTBOX: 99,
} as const;
