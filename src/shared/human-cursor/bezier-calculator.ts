import type { Vector } from './math.js';

function factorial(n: number): number {
  if (n <= 1) return 1;
  let result = 1;
  for (let i = 2; i <= n; i++) {
    result *= i;
  }
  return result;
}

function binomial(n: number, k: number): number {
  return factorial(n) / (factorial(k) * factorial(n - k));
}

function bernsteinPolynomialPoint(x: number, i: number, n: number): number {
  return binomial(n, i) * Math.pow(x, i) * Math.pow(1 - x, n - i);
}

function bernsteinPolynomial(
  points: Vector[],
): (t: number) => Vector {
  return (t: number): Vector => {
    const n = points.length - 1;
    let x = 0;
    let y = 0;

    for (let i = 0; i < points.length; i++) {
      const bern = bernsteinPolynomialPoint(t, i, n);
      x += points[i].x * bern;
      y += points[i].y * bern;
    }

    return { x, y };
  };
}

/**
 * Given list of control points, returns n points in the Bezier curve
 * described by these points.
 */
export function calculatePointsInCurve(
  n: number,
  points: Vector[],
): Vector[] {
  if (n < 2) {
    throw new Error('n must be at least 2');
  }

  const curvePoints: Vector[] = [];
  const bernsteinPoly = bernsteinPolynomial(points);

  for (let i = 0; i < n; i++) {
    if (i === 0) {
      curvePoints.push({ ...points[0] });
    } else if (i === n - 1) {
      curvePoints.push({ ...points[points.length - 1] });
    } else {
      const t = i / (n - 1);
      curvePoints.push(bernsteinPoly(t));
    }
  }

  return curvePoints;
}
