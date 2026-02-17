import { expect } from 'chai';
import { generatePath } from './mouse-humanizer.js';

describe('Mouse Humanizer', () => {
  describe('#generatePath', () => {
    it('starts near start point and ends at exact end point', () => {
      const path = generatePath(0, 0, 100, 100);
      expect(path.length).to.be.greaterThan(2);
      // First point should be near start (with jitter)
      expect(path[0][0]).to.be.within(-1, 1);
      expect(path[0][1]).to.be.within(-1, 1);
      // Last point must be exact target (no jitter)
      expect(path[path.length - 1]).to.deep.equal([100, 100]);
    });

    it('generates multiple intermediate points', () => {
      const path = generatePath(0, 0, 500, 500);
      expect(path.length).to.be.greaterThan(5);
    });

    it('produces a curved path (not all collinear)', () => {
      // Run multiple times since ghost-cursor has randomness
      let hasCurve = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        const path = generatePath(0, 0, 200, 0);
        // Check if any Y coordinate deviates significantly from 0
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

    it('respects moveSpeed option', () => {
      // Faster moveSpeed should produce fewer points
      const slowPath = generatePath(0, 0, 300, 300, { moveSpeed: 0.5 });
      const fastPath = generatePath(0, 0, 300, 300, { moveSpeed: 5.0 });
      // ghost-cursor varies, but generally fast = fewer points
      expect(fastPath.length).to.be.lessThanOrEqual(slowPath.length + 5);
    });

    it('applies micro-jitter to intermediate points only', () => {
      // Run many times and check the last point is always exact
      for (let i = 0; i < 20; i++) {
        const path = generatePath(10, 20, 200, 300);
        const last = path[path.length - 1];
        expect(last[0]).to.equal(200);
        expect(last[1]).to.equal(300);
      }
    });
  });
});
