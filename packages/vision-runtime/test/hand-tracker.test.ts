import { describe, expect, it } from 'vitest';
import type { HandLandmarkerResult } from '@mediapipe/tasks-vision';
import { handResultToHandFrame } from '../src/hand-tracker.js';

function resultWithLabel(label: 'Left' | 'Right'): HandLandmarkerResult {
  return {
    landmarks: [[{ x: 0.25, y: 0.5, z: 0, visibility: 1 }]],
    worldLandmarks: [[{ x: 0, y: 0, z: 0, visibility: 1 }]],
    handedness: [[{
      categoryName: label,
      score: 0.96,
      index: label === 'Left' ? 0 : 1,
      displayName: label,
    }]],
    handednesses: [],
  } as unknown as HandLandmarkerResult;
}

describe('handResultToHandFrame', () => {
  it('保留 Hand Landmarker 的解剖学左右标签，不做二次交换', () => {
    const left = handResultToHandFrame(resultWithLabel('Left'), 10);
    const right = handResultToHandFrame(resultWithLabel('Right'), 20);

    expect(left.hands[0].handedness).toBe('left');
    expect(right.hands[0].handedness).toBe('right');
  });
});
