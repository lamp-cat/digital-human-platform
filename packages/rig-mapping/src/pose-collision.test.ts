import { describe, expect, it } from 'vitest';
import type { PoseFrame, PoseLandmark } from '@dhp/avatar-schema';
import { PoseCollisionResolver } from './pose-collision.js';
import { landmarkToWorld } from './coords.js';

function point(
  name: string,
  wx: number,
  wy: number,
  wz: number,
): PoseLandmark {
  return {
    name,
    x: wx + 0.5,
    y: wy + 0.5,
    z: wz,
    wx,
    wy,
    wz,
    visibility: 1,
  };
}

function frame(wristX: number, wristZ: number): PoseFrame {
  return {
    timestampMs: 0,
    source: 'test',
    confidence: 1,
    landmarks: [
      point('left_shoulder', 0.2, -0.4, 0),
      point('right_shoulder', -0.2, -0.4, 0),
      point('left_hip', 0.13, 0, 0),
      point('right_hip', -0.13, 0, 0),
      point('left_elbow', 0.38, -0.23, 0),
      point('left_wrist', wristX, -0.2, wristZ),
      point('left_index', wristX + 0.02, -0.18, wristZ),
      point('left_pinky', wristX - 0.02, -0.18, wristZ),
      point('left_thumb', wristX, -0.18, wristZ),
    ],
  };
}

describe('PoseCollisionResolver', () => {
  it('把进入胸腹的手腕推出体表并保留前臂长度', () => {
    const input = frame(0.02, 0);
    const before = new Map(input.landmarks.map((item) => [item.name, item]));
    const beforeLength = landmarkToWorld(before.get('left_elbow')!, false).distanceTo(
      landmarkToWorld(before.get('left_wrist')!, false),
    );
    const result = new PoseCollisionResolver().apply(input);
    const after = new Map(result.frame.landmarks.map((item) => [item.name, item]));
    const afterWrist = landmarkToWorld(after.get('left_wrist')!, false);
    const afterLength = landmarkToWorld(after.get('left_elbow')!, false).distanceTo(
      afterWrist,
    );

    expect(result.correctedHands).toBe(1);
    expect(afterWrist.z).toBeGreaterThan(0);
    expect(afterLength).toBeCloseTo(beforeLength, 6);
  });

  it('手腕位于躯干外时不修改关键点', () => {
    const input = frame(0.55, 0.15);
    const result = new PoseCollisionResolver().apply(input);
    expect(result.correctedHands).toBe(0);
    expect(result.frame).toBe(input);
  });
});
