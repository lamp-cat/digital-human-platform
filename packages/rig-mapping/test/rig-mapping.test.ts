import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import type { PoseFrame } from '@dhp/avatar-schema';
import {
  LandmarkSmoother,
  OneEuroFilter,
  TrackingLossManager,
  blendTowardIdle,
  calibrate,
  mapPoseFrameToBoneRotations,
} from '../src/index.js';

/** 合成 T-Pose 帧（图像归一化坐标，人物面向摄像头，解剖学左侧在图像右侧）。 */
const T_POSE: Record<string, [number, number]> = {
  nose: [0.5, 0.15],
  left_ear: [0.545, 0.16],
  right_ear: [0.455, 0.16],
  left_shoulder: [0.6, 0.3],
  right_shoulder: [0.4, 0.3],
  left_elbow: [0.7, 0.3],
  right_elbow: [0.3, 0.3],
  left_wrist: [0.8, 0.3],
  right_wrist: [0.2, 0.3],
  left_hip: [0.55, 0.52],
  right_hip: [0.45, 0.52],
  left_knee: [0.555, 0.72],
  right_knee: [0.445, 0.72],
  left_ankle: [0.56, 0.92],
  right_ankle: [0.44, 0.92],
};

function makeFrame(
  points: Record<string, [number, number]>,
  vis: Record<string, number> = {},
  opts: { confidence?: number; timestampMs?: number } = {},
): PoseFrame {
  return {
    timestampMs: opts.timestampMs ?? 0,
    source: 'test',
    confidence: opts.confidence ?? 0.95,
    landmarks: Object.entries(points).map(([name, [x, y]]) => ({
      name,
      x,
      y,
      z: 0,
      visibility: vis[name] ?? 0.99,
    })),
  };
}

function angleOf(q: { w: number }): number {
  return 2 * Math.acos(Math.min(1, Math.abs(q.w)));
}

describe('OneEuroFilter / LandmarkSmoother', () => {
  it('恒定输入下输出收敛到该值', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0.02 });
    let y = 0;
    for (let i = 0; i < 30; i++) y = f.filter(1.0, 1 / 30);
    expect(y).toBeCloseTo(1.0, 3);
  });

  it('阶跃输入最终收敛，且首帧无延迟', () => {
    const f = new OneEuroFilter();
    expect(f.filter(5, 1 / 30)).toBe(5); // 首帧直通
    let y = 5;
    for (let i = 0; i < 120; i++) y = f.filter(10, 1 / 30);
    expect(Math.abs(y - 10)).toBeLessThan(0.05);
  });

  it('LandmarkSmoother 输出保持 PoseFrame 结构', () => {
    const smoother = new LandmarkSmoother();
    const frame = makeFrame(T_POSE, {}, { timestampMs: 0 });
    const smoothed = smoother.apply(frame);
    expect(smoothed.landmarks).toHaveLength(frame.landmarks.length);
    const smoothed2 = smoother.apply(makeFrame(T_POSE, {}, { timestampMs: 33 }));
    expect(smoothed2.landmarks[0].x).toBeCloseTo(frame.landmarks[0].x, 3);
  });
});

describe('calibrate + mapPoseFrameToBoneRotations', () => {
  it('校准帧与输入帧一致（T-Pose）→ 输出≈单位旋转', () => {
    const frames = [makeFrame(T_POSE), makeFrame(T_POSE), makeFrame(T_POSE)];
    const calibration = calibrate(frames);
    expect(calibration.shoulderWidth).toBeGreaterThan(0);
    expect(calibration.hipWidth).toBeGreaterThan(0);

    const rotations = mapPoseFrameToBoneRotations(makeFrame(T_POSE), calibration);
    for (const bone of ['LeftUpperArm', 'RightLowerLeg', 'Spine', 'Hips', 'Head'] as const) {
      const q = rotations[bone];
      expect(q, bone).toBeDefined();
      // v2 绝对方向映射：合成帧腿部带 ~1.4° 倾斜会被如实跟随，阈值放宽到 0.03
      expect(angleOf(q!), bone).toBeLessThan(0.03);
    }
  });

  it('镜像参数不破坏校准一致性', () => {
    const calibration = calibrate([makeFrame(T_POSE), makeFrame(T_POSE)], { mirror: true });
    const rotations = mapPoseFrameToBoneRotations(makeFrame(T_POSE), calibration, { mirror: true });
    expect(angleOf(rotations.LeftUpperArm!)).toBeLessThan(0.02);
  });

  it('抬起左臂 → LeftUpperArm 输出约 90° 旋转', () => {
    const calibration = calibrate([makeFrame(T_POSE), makeFrame(T_POSE)]);
    // 左小臂与左上臂竖直向上（图像 y 减小）
    const raised = makeFrame({
      ...T_POSE,
      left_elbow: [0.6, 0.2],
      left_wrist: [0.6, 0.1],
    });
    const rotations = mapPoseFrameToBoneRotations(raised, calibration);
    expect(rotations.LeftUpperArm).toBeDefined();
    expect(angleOf(rotations.LeftUpperArm!)).toBeCloseTo(Math.PI / 2, 1);
    expect(rotations.LeftLowerArm).toBeDefined();
    // 未动的右臂仍≈单位旋转
    expect(angleOf(rotations.RightUpperArm!)).toBeLessThan(0.02);
  });

  it('关键点可见性不足 → 对应骨骼不输出', () => {
    const calibration = calibrate([makeFrame(T_POSE), makeFrame(T_POSE)]);
    const frame = makeFrame(T_POSE, { left_elbow: 0.1, left_knee: 0.2 });
    const rotations = mapPoseFrameToBoneRotations(frame, calibration);
    expect(rotations.LeftUpperArm).toBeUndefined();
    expect(rotations.LeftLowerArm).toBeUndefined(); // elbow 缺失，前臂同样跳过
    expect(rotations.LeftUpperLeg).toBeUndefined();
    expect(rotations.RightUpperArm).toBeDefined();
    expect(rotations.RightUpperLeg).toBeDefined();
  });

  it('头部偏转限制在最大角度内', () => {
    const calibration = calibrate([makeFrame(T_POSE), makeFrame(T_POSE)]);
    const turned = makeFrame({ ...T_POSE, nose: [0.9, 0.16] });
    const rotations = mapPoseFrameToBoneRotations(turned, calibration, { maxHeadTurnDeg: 45 });
    expect(rotations.Head).toBeDefined();
    const angle = angleOf(rotations.Head!);
    expect(angle).toBeLessThanOrEqual((45 * Math.PI) / 180 + 1e-3);
    expect(angle).toBeGreaterThan(0.5); // 但确实有显著偏转
  });

  it('头部以校准姿态为中立位，不把鼻子的固有前向深度误判为低头', () => {
    const neutral = makeFrame(T_POSE);
    for (const lm of neutral.landmarks) {
      if (lm.name === 'left_shoulder') {
        Object.assign(lm, { wx: 0.2, wy: 0, wz: 0 });
      } else if (lm.name === 'right_shoulder') {
        Object.assign(lm, { wx: -0.2, wy: 0, wz: 0 });
      } else if (lm.name === 'nose') {
        // 平台世界坐标为 (0, 0.35, 0.18)：鼻子相对肩部天然向前，
        // 旧绝对映射会产生约 27° 的持续俯仰偏差。
        Object.assign(lm, { wx: 0, wy: -0.35, wz: -0.18 });
      }
    }
    const calibration = calibrate([neutral, structuredClone(neutral)]);
    const rotations = mapPoseFrameToBoneRotations(structuredClone(neutral), calibration);
    expect(rotations.Head).toBeDefined();
    expect(angleOf(rotations.Head!)).toBeLessThan(0.01);

    const nodded = structuredClone(neutral);
    const nose = nodded.landmarks.find((lm) => lm.name === 'nose')!;
    Object.assign(nose, { wy: -0.24, wz: -0.30 });
    const moved = mapPoseFrameToBoneRotations(nodded, calibration);
    expect(angleOf(moved.Head!)).toBeGreaterThan(0.2);
  });

  it('缺少必需关键点时校准报错', () => {
    const incomplete = makeFrame({ nose: [0.5, 0.15] });
    expect(() => calibrate([incomplete])).toThrow(/校准失败/);
  });
});

describe('TrackingLossManager', () => {
  const ROT_90 = (() => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    return { x: q.x, y: q.y, z: q.z, w: q.w };
  })();

  it('丢失回退权重曲线：tracking → frozen → blending → lost', () => {
    const mgr = new TrackingLossManager();
    const good = { LeftUpperArm: ROT_90 };

    // t=0：高置信，直通
    let r = mgr.update(0, 0.9, good);
    expect(r.status).toBe('tracking');
    expect(r.blendWeight).toBe(0);
    expect(r.rotations.LeftUpperArm!.w).toBeCloseTo(ROT_90.w);

    // t=300ms：低置信但未到冻结时间，沿用最近可信姿态
    r = mgr.update(300, 0.1, {});
    expect(r.status).toBe('tracking');
    expect(r.rotations.LeftUpperArm).toBeDefined();

    // t=600ms：冻结
    r = mgr.update(600, 0.1, {});
    expect(r.status).toBe('frozen');
    expect(r.blendWeight).toBe(0);
    expect(angleOf(r.rotations.LeftUpperArm!)).toBeCloseTo(Math.PI / 2, 2);

    // t=1300ms：混合中（0<w<1），角度应小于 90°
    r = mgr.update(1300, 0.1, {});
    expect(r.status).toBe('blending');
    expect(r.blendWeight).toBeGreaterThan(0);
    expect(r.blendWeight).toBeLessThan(1);
    expect(angleOf(r.rotations.LeftUpperArm!)).toBeLessThan(Math.PI / 2 - 0.05);

    // t=2500ms：完全丢失，回到待机（单位旋转）
    r = mgr.update(2500, 0.1, {});
    expect(r.status).toBe('lost');
    expect(r.blendWeight).toBe(1);
    expect(angleOf(r.rotations.LeftUpperArm!)).toBeLessThan(0.01);

    // 恢复高置信后回到 tracking
    r = mgr.update(2600, 0.9, good);
    expect(r.status).toBe('tracking');
  });

  it('blendTowardIdle 按权重缩放旋转量', () => {
    const half = blendTowardIdle({ LeftUpperArm: ROT_90 }, 0.5);
    expect(angleOf(half.LeftUpperArm!)).toBeCloseTo(Math.PI / 4, 2);
  });
});

describe('上半身模式（trackingMode: upper）', () => {
  it('upper 模式不输出髋关节和腿部旋转，手臂/脊柱/头部正常输出', () => {
    const calibration = calibrate([makeFrame(T_POSE), makeFrame(T_POSE)]);
    const turnedHips = makeFrame({
      ...T_POSE,
      left_hip: [0.62, 0.49],
      right_hip: [0.43, 0.55],
    });
    const rotations = mapPoseFrameToBoneRotations(turnedHips, calibration, {
      trackingMode: 'upper',
    });
    // 髋关节和腿部即使关键点全可见、髋线明显倾斜也不驱动
    expect(rotations.Hips).toBeUndefined();
    expect(rotations.LeftUpperLeg).toBeUndefined();
    expect(rotations.LeftLowerLeg).toBeUndefined();
    expect(rotations.RightUpperLeg).toBeUndefined();
    expect(rotations.RightLowerLeg).toBeUndefined();
    // 上半身骨骼正常
    for (const bone of ['LeftUpperArm', 'RightUpperArm', 'Spine', 'Chest', 'Head'] as const) {
      expect(rotations[bone], bone).toBeDefined();
    }
  });

  it('upper 模式腿部关键点 visibility=0 时不触发跟踪丢失', () => {
    const legsGone = Object.fromEntries(
      ['left_knee', 'right_knee', 'left_ankle', 'right_ankle'].map((n) => [n, 0]),
    );
    const frame = makeFrame(T_POSE, legsGone, { timestampMs: 0, confidence: 0.9 });

    const upper = new TrackingLossManager({ trackingMode: 'upper' });
    const r = upper.updateWithFrame(0, frame, {});
    expect(r.status).toBe('tracking');

    // 对照：full 模式下整个人离开画面（全部关键点不可见）→ 进入丢失流程
    const allGone = Object.fromEntries(Object.keys(T_POSE).map((n) => [n, 0]));
    const goneFrame = makeFrame(T_POSE, allGone, { timestampMs: 0 });
    const full = new TrackingLossManager({ trackingMode: 'full' });
    full.updateWithFrame(0, goneFrame, {}); // 低置信，lastGood 未建立
    expect(full.updateWithFrame(600, goneFrame, {}).status).toBe('frozen');

    // upper 模式同样整体离画也要触发丢失（冻结 → 混合回待机）
    upper.updateWithFrame(600, goneFrame, {});
    expect(upper.updateWithFrame(1200, goneFrame, {}).status).toBe('blending');
  });

  it('full 模式行为不变：update 仍按传入置信度判定', () => {
    const mgr = new TrackingLossManager({ trackingMode: 'full' });
    const good = { LeftUpperArm: { x: 0, y: 0, z: 0, w: 1 } };
    expect(mgr.update(0, 0.9, good).status).toBe('tracking');
    expect(mgr.update(600, 0.1, {}).status).toBe('frozen');
  });
});
