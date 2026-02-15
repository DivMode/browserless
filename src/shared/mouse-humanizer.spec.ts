import { expect } from 'chai';
import { bezierPoint, easeInOut, generateBezierPath, addMicroJitter } from './mouse-humanizer.js';

describe('Mouse Humanizer', () => {
  describe('#bezierPoint', () => {
    it('returns start point at t=0', () => {
      expect(bezierPoint(0, 0, 25, 75, 100)).to.equal(0);
    });
    it('returns end point at t=1', () => {
      expect(bezierPoint(1, 0, 25, 75, 100)).to.equal(100);
    });
    it('returns midpoint approximately at t=0.5', () => {
      const mid = bezierPoint(0.5, 0, 0, 100, 100);
      expect(mid).to.be.within(40, 60);
    });
  });

  describe('#easeInOut', () => {
    it('returns 0 at t=0', () => {
      expect(easeInOut(0)).to.equal(0);
    });
    it('returns 1 at t=1', () => {
      expect(easeInOut(1)).to.equal(1);
    });
    it('returns 0.5 at t=0.5', () => {
      expect(easeInOut(0.5)).to.equal(0.5);
    });
  });

  describe('#generateBezierPath', () => {
    it('starts at start point and ends at end point', () => {
      const path = generateBezierPath(0, 0, 100, 100, 20);
      expect(path[0]).to.deep.equal([0, 0]);
      const last = path[path.length - 1];
      expect(last[0]).to.be.closeTo(100, 1);
      expect(last[1]).to.be.closeTo(100, 1);
    });
    it('generates the correct number of points', () => {
      const path = generateBezierPath(0, 0, 100, 100, 15);
      expect(path).to.have.length(16); // num_points + 1
    });
  });

  describe('#addMicroJitter', () => {
    it('does not jitter the last point', () => {
      const path: [number, number][] = [[0, 0], [50, 50], [100, 100]];
      const jittered = addMicroJitter(path, 5.0);
      expect(jittered[jittered.length - 1]).to.deep.equal([100, 100]);
    });
    it('jitters intermediate points within bounds', () => {
      const path: [number, number][] = [[50, 50], [50, 50], [50, 50]];
      for (let i = 0; i < 20; i++) {
        const jittered = addMicroJitter(path, 2.0);
        for (let j = 0; j < jittered.length - 1; j++) {
          expect(jittered[j][0]).to.be.within(48, 52);
          expect(jittered[j][1]).to.be.within(48, 52);
        }
      }
    });
  });
});
