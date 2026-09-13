/**
 * Shared helper for clamping context-menu positions inside the viewport.
 *
 * The old approach used hardcoded MENU_W/MENU_H constants per call-site
 * and got it wrong as the menus grew (clip context menu now has Split +
 * Crossfade + Speed grid + z-order + Delete → ~300 px, but the constant
 * was 96). Symptom: menus rendered partially off-screen near the bottom
 * of the timeline.
 *
 * Pattern: render the menu first at the *requested* coordinates, then in
 * a layout effect read `menuRef.current.getBoundingClientRect()` and pass
 * the actual size here to get clamped coordinates. Apply with `setState`
 * or directly to `style.left`/`style.top`.
 */

export interface ClampInput {
  requestedX: number;
  requestedY: number;
  menuWidth: number;
  menuHeight: number;
  viewportWidth?: number;
  viewportHeight?: number;
  margin?: number;
}

export interface ClampedPosition {
  x: number;
  y: number;
}

export function clampMenuPosition({
  requestedX,
  requestedY,
  menuWidth,
  menuHeight,
  viewportWidth = window.innerWidth,
  viewportHeight = window.innerHeight,
  margin = 8,
}: ClampInput): ClampedPosition {
  // Shift left if the right edge would overflow.
  let x = requestedX;
  if (x + menuWidth + margin > viewportWidth) {
    x = viewportWidth - menuWidth - margin;
  }
  if (x < margin) x = margin;

  // Shift up if the bottom edge would overflow. Prefer pushing the menu
  // ABOVE the requested point (so the cursor isn't covering its own menu).
  let y = requestedY;
  if (y + menuHeight + margin > viewportHeight) {
    // Try positioning the menu so its bottom is just above the cursor
    // (requestedY - menuHeight). If that goes off the top, fall back to
    // pinning to viewportHeight - menuHeight - margin.
    const above = requestedY - menuHeight;
    y = above >= margin ? above : viewportHeight - menuHeight - margin;
  }
  if (y < margin) y = margin;

  return { x, y };
}
