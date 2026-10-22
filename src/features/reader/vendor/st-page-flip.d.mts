export interface Point {
  x: number;
  y: number;
}
export const FlipDirection: { readonly FORWARD: 0; readonly BACK: 1 };
export const FlipCorner: { readonly TOP: 'top'; readonly BOTTOM: 'bottom' };
export class Helper {
  static GetRotatedPoint(point: Point, origin: Point, angle: number): Point;
}
export class FlipCalculation {
  constructor(direction: 0 | 1, corner: 'top' | 'bottom', width: string, height: string);
  calc(point: Point): boolean;
  getFlippingClipArea(): (Point | null)[];
  getBottomClipArea(): (Point | null)[];
  getActiveCorner(): Point;
  getAngle(): number;
  getShadowStartPoint(): Point | null;
  getShadowAngle(): number;
}
