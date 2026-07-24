import { describe, expect, it } from 'vitest';
import type { HandData, HandFrame } from '@dhp/avatar-schema';
import { HandFrameStabilizer } from '../src/filters.js';

function hand(side: 'left' | 'right', x: number, score = 0.8): HandData {
  return {
    handedness: side,
    score,
    landmarks: [
      { name: 'wrist', x, y: 0.5, z: 0, visibility: 1 },
    ],
  };
}

function frame(hands: HandData[], timestampMs = 0): HandFrame {
  return { timestampMs, source: 'test', hands };
}

describe('HandFrameStabilizer', () => {
  it('双手交叉或模型标签瞬时翻转时优先保持腕部时序身份', () => {
    const stabilizer = new HandFrameStabilizer();
    const first = stabilizer.apply(frame([
      hand('left', 0.2),
      hand('right', 0.8),
    ]));
    expect(first.hands.find((item) => item.handedness === 'left')?.landmarks[0].x).toBe(0.2);

    // 下一帧 raw handedness 互换，但空间轨迹仍连续。
    const flipped = stabilizer.apply(frame([
      hand('right', 0.22, 0.72),
      hand('left', 0.78, 0.72),
    ], 50));
    expect(flipped.hands.find((item) => item.handedness === 'left')?.landmarks[0].x).toBe(0.22);
    expect(flipped.hands.find((item) => item.handedness === 'right')?.landmarks[0].x).toBe(0.78);
  });

  it('进入/退出阈值使用迟滞，短暂低置信度不会闪断', () => {
    const stabilizer = new HandFrameStabilizer({
      enterConfidence: 0.6,
      exitConfidence: 0.45,
      forgetAfterFrames: 2,
    });
    expect(stabilizer.apply(frame([hand('left', 0.3, 0.62)])).hands).toHaveLength(1);
    expect(stabilizer.apply(frame([hand('left', 0.31, 0.48)], 50)).hands).toHaveLength(1);
    stabilizer.apply(frame([], 100));
    stabilizer.apply(frame([], 150));
    stabilizer.apply(frame([], 200));
    expect(stabilizer.apply(frame([hand('left', 0.32, 0.48)], 250)).hands).toHaveLength(0);
  });
});
