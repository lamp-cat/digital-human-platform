import { describe, expect, it } from 'vitest';
import type { PoseFrame } from '@dhp/avatar-schema';
import {
  CrouchMotionTracker,
  estimateStandingHipHeight,
  measurePoseHipHeight,
} from '../src/index.js';

function poseFrame(hipY: number, timestampMs = 0): PoseFrame {
  const points: Record<string, [number, number]> = {
    nose: [0.5, 0.15],
    left_shoulder: [0.6, 0.3],
    right_shoulder: [0.4, 0.3],
    left_hip: [0.55, hipY],
    right_hip: [0.45, hipY],
    left_knee: [0.56, (hipY + 0.92) / 2],
    right_knee: [0.44, (hipY + 0.92) / 2],
    left_ankle: [0.56, 0.92],
    right_ankle: [0.44, 0.92],
  };
  return {
    timestampMs,
    source: 'root-motion-test',
    confidence: 0.95,
    landmarks: Object.entries(points).map(([name, [x, y]]) => ({
      name,
      x,
      y,
      z: 0,
      visibility: 0.99,
    })),
  };
}

describe('CrouchMotionTracker', () => {
  it('髋部下降时测得髋高缩短', () => {
    expect(measurePoseHipHeight(poseFrame(0.52))).toBeCloseTo(0.4, 3);
    expect(measurePoseHipHeight(poseFrame(0.72))).toBeCloseTo(0.2, 3);
  });

  it('用高分位站姿作为基准，不把夹杂的蹲姿当站姿', () => {
    const height = estimateStandingHipHeight([
      poseFrame(0.72),
      poseFrame(0.68),
      poseFrame(0.52),
      poseFrame(0.53),
      poseFrame(0.51),
    ]);
    expect(height).toBeGreaterThan(0.38);
  });

  it('蹲下输出负向髋位移，并通过速度限制避免单帧抽动', () => {
    const tracker = new CrouchMotionTracker(0.4);
    expect(tracker.update(poseFrame(0.52, 0))).toBe(0);
    const firstCrouch = tracker.update(poseFrame(0.72, 33));
    expect(firstCrouch).toBeLessThan(0);
    expect(firstCrouch).toBeGreaterThan(-0.06);
    let offset = firstCrouch;
    for (let i = 2; i < 45; i++) offset = tracker.update(poseFrame(0.72, i * 33));
    expect(offset).toBeLessThan(-0.35);
    expect(offset).toBeGreaterThanOrEqual(-0.65);
  });

  it('站姿小幅检测噪声落入死区，不带动人物上下抖动', () => {
    const tracker = new CrouchMotionTracker(0.4);
    const outputs = [0.52, 0.523, 0.518, 0.521].map((hipY, index) =>
      tracker.update(poseFrame(hipY, index * 33)),
    );
    expect(outputs.every((offset) => offset === 0)).toBe(true);
  });
});
