import { describe, expect, it } from 'vitest';
import type { PoseFrame, PoseLandmark } from '@dhp/avatar-schema';
import { TemporalPoseCompleter } from '../src/index.js';

function landmark(
  name: string,
  x: number,
  y: number,
  visibility = 0.95,
): PoseLandmark {
  return {
    name,
    x,
    y,
    z: 0,
    wx: x,
    wy: y,
    wz: 0,
    visibility,
  };
}

function frame(timestampMs: number, landmarks: PoseLandmark[]): PoseFrame {
  return {
    timestampMs,
    source: 'test',
    confidence:
      landmarks.reduce((sum, point) => sum + point.visibility, 0) /
      Math.max(1, landmarks.length),
    landmarks,
  };
}

describe('TemporalPoseCompleter', () => {
  it('短时低置信关键点使用速度预测补全，并保留原始/有效置信度', () => {
    const completer = new TemporalPoseCompleter();
    completer.apply(
      frame(0, [
        landmark('left_shoulder', 0, 0),
        landmark('left_elbow', 0.2, 0),
        landmark('left_wrist', 0.4, 0),
      ]),
    );
    completer.apply(
      frame(100, [
        landmark('left_shoulder', 0, 0.02),
        landmark('left_elbow', 0.2, 0.02),
        landmark('left_wrist', 0.4, 0.02),
      ]),
    );

    const result = completer.apply(
      frame(200, [
        landmark('left_shoulder', 0, 0.04),
        landmark('left_elbow', 0.8, 0.6, 0.1),
        landmark('left_wrist', 0.9, 0.7, 0.1),
      ]),
    );

    expect(result.inferredLandmarks).toContain('left_elbow');
    expect(result.inferredLandmarks).toContain('left_wrist');
    expect(result.effectiveConfidence).toBeGreaterThan(result.rawConfidence + 0.25);
    const elbow = result.frame.landmarks.find((point) => point.name === 'left_elbow')!;
    expect(elbow.visibility).toBeGreaterThanOrEqual(0.68);
    expect(elbow.visibility).toBeLessThanOrEqual(0.86);
    expect(elbow.x).toBeLessThan(0.6);
  });

  it('推理出的肢体端点保持已学习骨长，避免遮挡时手脚伸缩', () => {
    const completer = new TemporalPoseCompleter();
    completer.apply(
      frame(0, [
        landmark('left_shoulder', 0, 0),
        landmark('left_elbow', 0.2, 0),
        landmark('left_wrist', 0.4, 0),
      ]),
    );
    const result = completer.apply(
      frame(100, [
        landmark('left_shoulder', 0, 0),
        landmark('left_elbow', 0.7, 0.4, 0.1),
        landmark('left_wrist', 0.9, 0.6, 0.1),
      ]),
    );
    const byName = new Map(result.frame.landmarks.map((point) => [point.name, point]));
    const shoulder = byName.get('left_shoulder')!;
    const elbow = byName.get('left_elbow')!;
    const wrist = byName.get('left_wrist')!;
    expect(Math.hypot(elbow.wx! - shoulder.wx!, elbow.wy! - shoulder.wy!)).toBeCloseTo(
      0.2,
      4,
    );
    expect(Math.hypot(wrist.wx! - elbow.wx!, wrist.wy! - elbow.wy!)).toBeCloseTo(0.2, 4);
  });

  it('整帧短暂未检测到人体时延续最近运动状态', () => {
    const completer = new TemporalPoseCompleter();
    completer.apply(
      frame(0, [
        landmark('left_shoulder', 0, 0),
        landmark('right_shoulder', -0.2, 0),
      ]),
    );
    const result = completer.apply(frame(200, []));
    expect(result.rawConfidence).toBe(0);
    expect(result.frame.landmarks).toHaveLength(2);
    expect(result.inferredLandmarks).toEqual(
      expect.arrayContaining(['left_shoulder', 'right_shoulder']),
    );
    expect(result.effectiveConfidence).toBeGreaterThanOrEqual(0.68);
    expect(result.effectiveConfidence).toBeLessThanOrEqual(0.86);
  });

  it('超过最大推理时长后不继续猜测，交回丢失跟踪管理器', () => {
    const completer = new TemporalPoseCompleter({ maxGapMs: 500 });
    completer.apply(frame(0, [landmark('nose', 0, 0)]));
    const result = completer.apply(frame(800, []));
    expect(result.frame.landmarks).toHaveLength(0);
    expect(result.effectiveConfidence).toBe(0);
  });

  it('reset 会清除历史预测状态', () => {
    const completer = new TemporalPoseCompleter();
    completer.apply(frame(0, [landmark('nose', 0, 0)]));
    completer.reset();
    expect(completer.apply(frame(100, [])).frame.landmarks).toHaveLength(0);
  });
});
