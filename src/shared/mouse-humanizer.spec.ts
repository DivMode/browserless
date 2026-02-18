import { expect } from 'chai';
import { generatePath } from './mouse-humanizer.js';

describe('Mouse Humanizer', () => {
  describe('#generatePath', () => {
    it('starts near start point and ends at exact end point', () => {
      const path = generatePath(0, 0, 100, 100);
      expect(path.length).to.be.greaterThan(2);
      // First point should be near start
      expect(path[0][0]).to.be.within(-1, 1);
      expect(path[0][1]).to.be.within(-1, 1);
      // Last point must be exact target
      expect(path[path.length - 1]).to.deep.equal([100, 100]);
    });

    it('generates multiple intermediate points', () => {
      const path = generatePath(0, 0, 500, 500);
      // human-cursor generates 35-80 target points
      expect(path.length).to.be.greaterThan(10);
    });

    it('produces a curved path (not all collinear)', () => {
      let hasCurve = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        const path = generatePath(0, 0, 200, 0);
        for (const [, y] of path.slice(1, -1)) {
          if (Math.abs(y) > 2) {
            hasCurve = true;
            break;
          }
        }
        if (hasCurve) break;
      }
      expect(hasCurve).to.be.true;
    });

    it('handles short distances', () => {
      const path = generatePath(100, 100, 105, 105);
      expect(path.length).to.be.greaterThan(1);
      expect(path[path.length - 1]).to.deep.equal([105, 105]);
    });

    it('handles zero distance (same start and end)', () => {
      const path = generatePath(50, 50, 50, 50);
      expect(path.length).to.be.greaterThan(0);
      expect(path[path.length - 1]).to.deep.equal([50, 50]);
    });

    it('respects moveSpeed option (faster = fewer points)', () => {
      // Distance-proportional points: ~distance/(2*speed)
      // 300*sqrt(2) ≈ 424px → slow(0.5): ~424 pts, fast(5.0): ~42 pts
      const slowPath = generatePath(0, 0, 300, 300, { moveSpeed: 0.5 });
      const fastPath = generatePath(0, 0, 300, 300, { moveSpeed: 5.0 });
      expect(fastPath.length).to.be.lessThan(slowPath.length);
    });

    it('last point is always exact target', () => {
      for (let i = 0; i < 20; i++) {
        const path = generatePath(10, 20, 200, 300);
        const last = path[path.length - 1];
        expect(last[0]).to.equal(200);
        expect(last[1]).to.equal(300);
      }
    });

    it('has no sharp direction reversals (smoothing pass)', () => {
      const cosThreshold = Math.cos((150 * Math.PI) / 180);

      for (let run = 0; run < 20; run++) {
        const path = generatePath(0, 0, 300, 200);

        for (let i = 1; i < path.length - 1; i++) {
          const prev = path[i - 1];
          const curr = path[i];
          const next = path[i + 1];

          const dx1 = curr[0] - prev[0],
            dy1 = curr[1] - prev[1];
          const dx2 = next[0] - curr[0],
            dy2 = next[1] - curr[1];
          const mag1 = Math.hypot(dx1, dy1);
          const mag2 = Math.hypot(dx2, dy2);

          // Skip near-zero movement
          if (mag1 < 0.01 || mag2 < 0.01) continue;

          const cosAngle = (dx1 * dx2 + dy1 * dy2) / (mag1 * mag2);
          expect(cosAngle).to.be.at.least(
            cosThreshold,
            `Sharp reversal at point ${i} in run ${run}`,
          );
        }
      }
    });
  });
});
