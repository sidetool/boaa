import { describe, expect, it } from 'vitest';
import { createPageFold, type CurlPoint, type CurlMatrix } from './page-curl-geometry';
import { FlipCalculation, FlipCorner, FlipDirection, Helper } from './vendor/st-page-flip.mjs';

const project = (m: CurlMatrix, p: CurlPoint) => ({
  x: m[0] * p.x + m[2] * p.y + m[4],
  y: m[1] * p.x + m[3] * p.y + m[5],
});

describe('StPageFlip reader adapter', () => {
  it.each([1, -1] as const)(
    'reaches the next page continuously when dragging beyond the top edge (direction %s)',
    (direction) => {
      const width = 296.40625,
        height = 791.21875;
      const fold = createPageFold(width, height, 63.2975, direction);
      let lastArea = 0;
      for (const q of [0, 0.1, 0.49, 0.5, 0.51, 0.9, 0.99, 0.999999]) {
        const points = fold(q, -237.365625).revealed;
        lastArea =
          Math.abs(
            points.reduce((sum, point, index) => {
              const next = points[(index + 1) % points.length];
              return sum + point.x * next.y - next.x * point.y;
            }, 0),
          ) /
          (2 * width * height);
        if (q >= 0.9) expect(lastArea).toBeGreaterThan(0.85);
      }
      expect(lastArea).toBeGreaterThan(0.99);
    },
  );
  it('keeps the fold live exactly halfway through a deep diagonal drag', () => {
    const fold = createPageFold(296.40625, 791.21875, 650, 1);
    expect(fold(0.5, -450).folded.polygon.length).toBeGreaterThan(0);
  });
  it('does not expose half the other page when reversing a fully held backward turn by 1.5%', () => {
    const width = 296.40625,
      height = 791.21875;
    const fold = createPageFold(width, height, 464.409375, 1);
    expect(fold(0, 124.7).revealed).toEqual([]);
    const points = fold(0.01482340602040233, 124.7).revealed;
    const area =
      Math.abs(
        points.reduce((sum, point, index) => {
          const next = points[(index + 1) % points.length];
          return sum + point.x * next.y - next.x * point.y;
        }, 0),
      ) / 2;
    expect(area / (width * height)).toBeLessThan(0.02);
  });
  it('matches the upstream soft-page clipping and rotation for the same held corner', () => {
    const width = 390,
      height = 700,
      originY = 560,
      pullY = -90;
    const fold = createPageFold(width, height, originY, 1);
    for (const progress of [0.03, 0.3, 0.5, 0.75, 0.95]) {
      const upstream = new FlipCalculation(FlipDirection.FORWARD, FlipCorner.BOTTOM, String(width), String(height));
      expect(
        upstream.calc({
          x: width * (1 - 2 * progress),
          y: height + (originY + pullY - height) * Math.sin(Math.PI * progress),
        }),
      ).toBe(true);
      const actual = fold(progress, pullY);
      const upstreamRevealed = upstream.getBottomClipArea().filter((p): p is CurlPoint => p !== null);
      expect(actual.revealed).toHaveLength(upstreamRevealed.length);
      actual.revealed.forEach((point, i) => {
        expect(point.x).toBeCloseTo(upstreamRevealed[i].x, 4);
        expect(point.y).toBeCloseTo(upstreamRevealed[i].y, 4);
      });
      const position = upstream.getActiveCorner();
      const local = upstream
        .getFlippingClipArea()
        .filter((p): p is CurlPoint => p !== null)
        .map((p) =>
          Helper.GetRotatedPoint({ x: p.x - position.x, y: p.y - position.y }, { x: 0, y: 0 }, upstream.getAngle()),
        );
      expect(actual.folded.polygon).toHaveLength(local.length);
      actual.folded.polygon.forEach((point, i) => {
        expect(point.x).toBeCloseTo(local[i].x, 4);
        expect(point.y).toBeCloseTo(local[i].y, 4);
      });
    }
  });

  it('keeps geometry finite through long holds, reversals and vertical movement near both endpoints', () => {
    for (const direction of [-1, 1] as const)
      for (const origin of [1, 100, 350, 650, 699]) {
        const fold = createPageFold(296.40625, 791.125, origin, direction);
        for (const p of [0, 0.1, 0.4, 0.7, 0.95, 0.999999, 1, 0.95, 1, 0.7, 0.1, 0]) {
          for (const y of [-600, -200, 0, 200, 600]) {
            const g = fold(p, y);
            expect(
              [
                ...g.folded.matrix,
                ...g.folded.polygon.flatMap((point) => [point.x, point.y]),
                ...g.revealed.flatMap((point) => [point.x, point.y]),
              ].every(Number.isFinite),
            ).toBe(true);
          }
        }
      }
  });

  it('reveals exactly the complete fractional-sized page at the endpoint and remains reversible', () => {
    const fold = createPageFold(296.40625, 791.125, 600, 1);
    expect(fold(0, 0).revealed).toEqual([]);
    const end = fold(1, 0);
    expect(end.revealed).toEqual([
      { x: 0, y: 0 },
      { x: 296.40625, y: 0 },
      { x: 296.40625, y: 791.125 },
      { x: 0, y: 791.125 },
    ]);
    expect(end.folded.polygon).toEqual([]);
    const near = fold(0.95, -70);
    expect(near.folded.polygon.length).toBeGreaterThan(0);
    expect(fold(1, 0)).toEqual(end);
    expect(fold(0.95, -70)).toEqual(near);
    expect(fold(0, 0).revealed).toEqual([]);
  });

  it('mirrors page geometry for RTL without mirroring static text or changing page ownership', () => {
    const width = 296.40625;
    const left = createPageFold(width, 791.125, 650, 1);
    const right = createPageFold(width, 791.125, 650, -1);
    for (const progress of [0.05, 0.35, 0.7, 0.95]) {
      const a = left(progress, -80),
        b = right(progress, -80);
      a.folded.polygon.forEach((point, index) => {
        const l = project(a.folded.matrix, point),
          r = project(b.folded.matrix, b.folded.polygon[index]);
        expect(l.x + r.x).toBeCloseTo(width, 8);
        expect(l.y).toBeCloseTo(r.y, 8);
      });
      a.revealed.forEach((point, index) => {
        expect(point.x + b.revealed[index].x).toBeCloseTo(width, 8);
        expect(point.y).toBe(b.revealed[index].y);
      });
    }
  });
});
