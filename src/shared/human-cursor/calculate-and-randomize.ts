import type { Vector } from './math.js';
import { type TweeningFunction, TWEEN_OPTIONS } from './tweening.js';

export interface RandomCurveParameters {
  offsetBoundaryX: number;
  offsetBoundaryY: number;
  knotsCount: number;
  distortionMean: number;
  distortionStDev: number;
  distortionFrequency: number;
  tween: TweeningFunction;
  targetPoints: number;
}

function weightedRandomChoice<T>(items: T[], weights: number[]): T {
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  let random = Math.random() * totalWeight;

  for (let i = 0; i < items.length; i++) {
    random -= weights[i];
    if (random <= 0) {
      return items[i];
    }
  }

  return items[items.length - 1];
}

function randomFromRange(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generates randomized parameters for a human-like mouse curve.
 * Uses weighted random distributions matching humancursor Python implementation.
 */
export function generateRandomCurveParameters(
  preOrigin: Vector,
  postDestination: Vector,
): RandomCurveParameters {
  const tween =
    TWEEN_OPTIONS[Math.floor(Math.random() * TWEEN_OPTIONS.length)];

  // Offset boundary X — heavily weighted towards 75-99 range (~94.65%)
  const offsetBoundaryXRanges = [
    { min: 20, max: 44 },
    { min: 45, max: 74 },
    { min: 75, max: 99 },
  ];
  const selectedXRange = weightedRandomChoice(offsetBoundaryXRanges, [
    0.2, 0.65, 15,
  ]);
  let offsetBoundaryX = randomFromRange(selectedXRange.min, selectedXRange.max);

  // Offset boundary Y — same distribution
  const offsetBoundaryYRanges = [
    { min: 20, max: 44 },
    { min: 45, max: 74 },
    { min: 75, max: 99 },
  ];
  const selectedYRange = weightedRandomChoice(offsetBoundaryYRanges, [
    0.2, 0.65, 15,
  ]);
  let offsetBoundaryY = randomFromRange(selectedYRange.min, selectedYRange.max);

  // Knots count — most likely 2-3, tailing off
  let knotsCount = weightedRandomChoice(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    [0.15, 0.36, 0.17, 0.12, 0.08, 0.04, 0.03, 0.02, 0.015, 0.005],
  );

  // Distortion parameters
  const distortionMean = randomFromRange(80, 109) / 100;
  const distortionStDev = randomFromRange(85, 109) / 100;
  const distortionFrequency = randomFromRange(25, 69) / 100;

  // Target points — matches Python web distribution
  const targetPointsRanges = [
    { min: 35, max: 44 },
    { min: 45, max: 59 },
    { min: 60, max: 79 },
  ];
  const selectedPointsRange = weightedRandomChoice(targetPointsRanges, [
    0.53, 0.32, 0.15,
  ]);
  const targetPoints = randomFromRange(
    selectedPointsRange.min,
    selectedPointsRange.max,
  );

  // Scale boundaries relative to movement distance
  const distance = Math.sqrt(
    Math.pow(postDestination.x - preOrigin.x, 2) +
      Math.pow(postDestination.y - preOrigin.y, 2),
  );

  const minBoundary = Math.max(30, distance * 0.15);
  offsetBoundaryX = Math.max(offsetBoundaryX, minBoundary);
  offsetBoundaryY = Math.max(offsetBoundaryY, minBoundary);

  // Ensure minimum knots for natural curves
  knotsCount = Math.max(knotsCount, 2);

  return {
    offsetBoundaryX,
    offsetBoundaryY,
    knotsCount,
    distortionMean,
    distortionStDev,
    distortionFrequency,
    tween,
    targetPoints,
  };
}
