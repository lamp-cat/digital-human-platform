import { describe, expect, it } from 'vitest';
import type { FaceFrame } from '@dhp/avatar-schema';
import {
  FaceDriveManager,
  mapFaceBlendshapesToExpressions,
} from '../src/face-mapper.js';

function frame(
  blendshapes: Record<string, number>,
  timestampMs: number,
  detected = true,
): FaceFrame {
  return {
    timestampMs,
    source: 'test',
    detected,
    landmarkCount: detected ? 478 : 0,
    blendshapes,
  };
}

describe('face-mapper', () => {
  it('独立映射左右眨眼与解剖学视线', () => {
    const out = mapFaceBlendshapesToExpressions({
      eyeBlinkLeft: 0.9,
      eyeBlinkRight: 0.1,
      eyeLookOutLeft: 0.8,
      eyeLookInRight: 0.7,
    });
    expect(out.blinkLeft).toBeGreaterThan(0.85);
    expect(out.blinkRight).toBeLessThan(0.1);
    expect(out.lookLeft).toBeGreaterThan(0.7);
    expect(out.lookRight).toBe(0);
  });

  it('圆唇抑制 aa 并优先输出 ou', () => {
    const plainOpen = mapFaceBlendshapesToExpressions({ jawOpen: 0.8 });
    const rounded = mapFaceBlendshapesToExpressions({ jawOpen: 0.8, mouthPucker: 0.9 });
    expect(plainOpen.aa).toBeGreaterThan(0.75);
    expect(rounded.ou).toBeGreaterThan(0.85);
    expect(rounded.aa).toBeLessThan(plainOpen.aa! * 0.5);
  });

  it('普通张嘴不会单独触发惊讶', () => {
    const talking = mapFaceBlendshapesToExpressions({ jawOpen: 0.9 });
    const surprise = mapFaceBlendshapesToExpressions({
      jawOpen: 0.9,
      eyeWideLeft: 0.8,
      eyeWideRight: 0.8,
      browInnerUp: 0.8,
    });
    expect(talking.surprised).toBe(0);
    expect(surprise.surprised).toBeGreaterThan(0.7);
  });

  it('中性脸标定使用中位数并去除静态偏置', () => {
    const manager = new FaceDriveManager({ calibrationFrames: 3 });
    manager.update(frame({ jawOpen: 0.12 }, 0));
    manager.update(frame({ jawOpen: 0.9 }, 50)); // 标定期间偶发异常张嘴
    const calibrated = manager.update(frame({ jawOpen: 0.1 }, 100));
    expect(calibrated.status).toBe('calibrating');

    const neutral = manager.update(frame({ jawOpen: 0.12 }, 150));
    expect(neutral.status).toBe('tracking');
    expect(neutral.expressions.aa).toBeLessThan(0.02);

    const open = manager.update(frame({ jawOpen: 0.8 }, 200));
    expect(open.expressions.aa).toBeGreaterThan(0.1);
  });

  it('丢脸后短暂保持并平滑回中性', () => {
    const manager = new FaceDriveManager({
      calibrationFrames: 1,
      lostHoldMs: 100,
      returnDurationMs: 200,
    });
    manager.update(frame({}, 0));
    const active = manager.update(frame({ eyeBlinkLeft: 0.9 }, 50));
    const held = manager.update(frame({}, 120, false), 120);
    const faded = manager.update(frame({}, 250, false), 250);
    const neutral = manager.update(frame({}, 400, false), 400);
    expect(active.expressions.blinkLeft).toBeGreaterThan(0);
    expect(held.expressions.blinkLeft).toBeCloseTo(active.expressions.blinkLeft!);
    expect(faded.expressions.blinkLeft).toBeLessThan(active.expressions.blinkLeft!);
    expect(neutral.expressions.blinkLeft).toBe(0);
  });
});
