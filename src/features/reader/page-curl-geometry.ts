import { FlipCalculation, FlipCorner, FlipDirection, Helper, type Point } from './vendor/st-page-flip.mjs';

export type CurlPoint = Point;
export type CurlMatrix = [number, number, number, number, number, number];
export type PageFold = {
  revealed: Point[];
  folded: { polygon: Point[]; matrix: CurlMatrix };
  shadow?: { x: number; y: number; angle: number; opacity: number };
};
const identity: CurlMatrix = [1, 0, 0, 1, 0, 0];
export const curlPolygon = (points: readonly Point[]) =>
  points.length >= 3 ? `polygon(${points.map((p) => `${p.x}px ${p.y}px`).join(',')})` : 'polygon(0 0,0 0,0 0)';

/** StPageFlip's fold calculation and HTMLPage.drawSoft coordinate conversion.
 * The adapter only maps our fractional page dimensions and RTL coordinates.
 * There are no text strips or changing source/target roles during a turn.
 */
export function createPageFold(width: number, height: number, originY: number, direction: 1 | -1) {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const sx = width / w;
  const sy = height / h;
  const corner = originY < height / 2 ? FlipCorner.TOP : FlipCorner.BOTTOM;
  const calculation = new FlipCalculation(FlipDirection.FORWARD, corner, String(w), String(h));
  const scale = (p: Point): Point => ({ x: p.x * sx, y: p.y * sy });
  const mirror = (p: Point): Point => ({ x: direction === 1 ? p.x : width - p.x, y: p.y });
  const page = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
  let previous: PageFold = { revealed: [], folded: { polygon: [], matrix: identity } };
  return (progress: number, pullY: number): PageFold => {
    if (progress <= 0 || progress >= 1) {
      previous = { revealed: progress >= 1 ? page : [], folded: { polygon: [], matrix: identity } };
      return previous;
    }
    const bend = Math.sin(Math.PI * progress);
    // Upstream expects a position on the page, not a delta from the corner.
    // Applying positive finger dy to the bottom edge placed the corner below
    // the paper; its crease then cut across half the page even at progress ~0.
    const cornerY = corner === FlipCorner.TOP ? 0 : h;
    const fingerY = Math.max(0, Math.min(h, (originY + pullY) / sy));
    // Coincident paper edges are singular for the upstream segment solver.
    // Keep a 0.01px interior inset while folding; exact resting endpoints above
    // are handled directly. This also covers a finger moving past the screen.
    const y = Math.max(0.01, Math.min(h - 0.01, cornerY + (fingerY - cornerY) * bend));
    const x = w * (1 - 2 * progress);
    // Upstream's line/circle intersection divides by x at the exact spine.
    // A sub-pixel nudge avoids a frozen frame on an otherwise valid deep drag.
    if (!calculation.calc({ x: Math.abs(x) < 0.000001 ? (x < 0 ? -0.000001 : 0.000001) : x, y })) return previous;

    const position = calculation.getActiveCorner();
    const angle = calculation.getAngle();
    // Same local clipping transform as upstream HTMLPage.drawSoft (forward).
    const polygon = calculation
      .getFlippingClipArea()
      .filter((p): p is Point => p !== null)
      .map((p) => Helper.GetRotatedPoint({ x: p.x - position.x, y: p.y - position.y }, { x: 0, y: 0 }, angle))
      .map(scale)
      .map(mirror);
    const a = Math.cos(angle),
      b = (Math.sin(angle) * sy) / sx,
      c = (-Math.sin(angle) * sx) / sy,
      d = a;
    const e = position.x * sx,
      f = position.y * sy;
    const matrix: CurlMatrix =
      direction === 1 ? [a, b, c, d, e, f] : [a, -b, -c, d, width - a * width - e, b * width + f];
    const revealed = calculation
      .getBottomClipArea()
      .filter((p): p is Point => p !== null)
      .map(scale)
      .map(mirror);
    let shadow: PageFold['shadow'];
    try {
      const start = calculation.getShadowStartPoint();
      const shadowAngle = calculation.getShadowAngle() + (3 * Math.PI) / 2;
      if (start && Number.isFinite(shadowAngle)) {
        const point = mirror(scale(start));
        shadow = { ...point, angle: direction === 1 ? shadowAngle : Math.PI - shadowAngle, opacity: bend };
      }
    } catch {
      /* A flat endpoint has no finite crease/shadow. */
    }
    const result = { revealed, folded: { polygon, matrix }, shadow };
    if (
      [...matrix, ...polygon.flatMap((p) => [p.x, p.y]), ...revealed.flatMap((p) => [p.x, p.y])].every(Number.isFinite)
    )
      previous = result;
    return previous;
  };
}
