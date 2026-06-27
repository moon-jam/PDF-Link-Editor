/**
 * Coordinate conversion between the browser preview and PDF user space.
 *
 * The user draws in CSS pixels (origin top-left, Y down, scaled by zoom); a PDF
 * /Rect needs PDF points (origin bottom-left, Y up, zoom independent, possibly
 * rotated). PDF.js builds a per-page `viewport` that already encodes the scale,
 * rotation and box offset, exposing two helpers:
 *
 *   viewport.convertToPdfPoint(x, y)       // viewport px -> PDF points
 *   viewport.convertToViewportPoint(x, y)  // PDF points  -> viewport px
 *
 * Converting at draw time and storing rectangles in PDF points keeps them
 * correct across zoom changes (and structured to support rotated pages).
 */

/**
 * Convert a rectangle drawn in viewport (CSS-pixel) coordinates into a
 * normalised PDF /Rect: [xMin, yMin, xMax, yMax] in PDF points.
 *
 * @param {object} viewport - PDF.js page viewport for the rendered scale.
 * @param {{x:number,y:number}} start - drag start, viewport px (top-left origin).
 * @param {{x:number,y:number}} end   - drag end, viewport px.
 * @returns {[number,number,number,number]} PDF-space rect.
 */
export function viewportRectToPdfRect(viewport, start, end) {
  // Convert both corners. convertToPdfPoint handles scale, Y-flip and rotation.
  const [ax, ay] = viewport.convertToPdfPoint(start.x, start.y);
  const [bx, by] = viewport.convertToPdfPoint(end.x, end.y);

  return [
    Math.min(ax, bx),
    Math.min(ay, by),
    Math.max(ax, bx),
    Math.max(ay, by),
  ];
}

/**
 * Convert a single point from viewport (CSS-pixel) space to PDF points.
 * Used when the user clicks a destination location on a target page.
 *
 * @param {object} viewport - PDF.js page viewport.
 * @param {{x:number,y:number}} pt - point in viewport px (top-left origin).
 * @returns {{x:number,y:number}} point in PDF points (bottom-left origin).
 */
export function viewportPointToPdfPoint(viewport, pt) {
  const [x, y] = viewport.convertToPdfPoint(pt.x, pt.y);
  return { x, y };
}

/**
 * Convert a stored PDF /Rect back into a CSS-pixel box for display on the
 * overlay at the current viewport (zoom). Returns left/top/width/height
 * suitable for absolutely positioning a <div>.
 *
 * @param {object} viewport - PDF.js page viewport for the current scale.
 * @param {[number,number,number,number]} rect - PDF-space rect.
 */
export function pdfRectToViewportBox(viewport, rect) {
  const [x1, y1, x2, y2] = rect;
  // Convert two opposite corners back to viewport px.
  const [vx1, vy1] = viewport.convertToViewportPoint(x1, y1);
  const [vx2, vy2] = viewport.convertToViewportPoint(x2, y2);

  const left = Math.min(vx1, vx2);
  const top = Math.min(vy1, vy2);
  return {
    left,
    top,
    width: Math.abs(vx2 - vx1),
    height: Math.abs(vy2 - vy1),
  };
}
