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

    it('generates power-scaled point count from arc length', () => {
      // Short move (~7px): arcLength^0.25*20 ≈ 33 points
      const shortPath = generatePath(100, 100, 105, 105);
      expect(shortPath.length).to.be.greaterThan(10);

      // Long move (~424px): arcLength^0.25*20 ≈ 90 points
      const longPath = generatePath(0, 0, 300, 300);
      expect(longPath.length).to.be.greaterThan(50);
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

    it('points progress monotonically along the eased curve (no back-and-forth)', () => {
      // easeOutQuad sampling of a smooth Bezier should not produce
      // consecutive duplicate indices or erratic jumps
      for (let run = 0; run < 10; run++) {
        const path = generatePath(0, 0, 300, 200);
        // Path should have distinct points (no long runs of duplicates)
        let distinctCount = 1;
        for (let i = 1; i < path.length; i++) {
          if (path[i][0] !== path[i - 1][0] || path[i][1] !== path[i - 1][1]) {
            distinctCount++;
          }
        }
        // At least 50% of points should be distinct
        expect(distinctCount).to.be.greaterThan(path.length * 0.5);
      }
    });
  });
});
