import { describe, expect, it } from 'vitest';
import { Object3D, Vector3 } from 'three';
import type { PoseFrame, StandardRigBone } from '@dhp/avatar-schema';
import { applyBoneRotations, buildStandardSkeleton, createRigDriver } from '@dhp/avatar-runtime';
import { calibrate, imageToWorld, mapPoseFrameToBoneRotations } from '../src/index.js';

/**
 * 方向语义回归测试（Bug：摄像头驱动上下/前后颠倒）。
 * MediaPipe 图像坐标：x 右、y 下、z 朝摄像头为负；
 * 平台世界系：x 右、y 上、+Z 朝摄像头（角色面向 +Z）。
 * 用真实绑定骨架（buildStandardSkeleton）+ 真实驱动（applyBoneRotations）断言世界坐标变化方向。
 */

/** 合成 T-Pose 帧（图像归一化坐标，人物面向摄像头，解剖学左侧在图像右侧）。 */
const T_POSE: Record<string, [number, number, number?]> = {
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

function makeFrame(points: Record<string, [number, number, number?]>): PoseFrame {
  return {
    timestampMs: 0,
    source: 'test',
    confidence: 0.95,
    landmarks: Object.entries(points).map(([name, [x, y, z]]) => ({
      name,
      x,
      y,
      z: z ?? 0,
      visibility: 0.99,
    })),
  };
}

/** 真实绑定骨架 + RigDriver（与内置底模/驱动链路一致）。 */
function makeDrivenRig() {
  const { bones, rootBone } = buildStandardSkeleton();
  const root = new Object3D();
  root.add(rootBone);
  root.updateMatrixWorld(true);
  const boneMap = new Map<StandardRigBone, Object3D>(
    Object.entries(bones) as [StandardRigBone, Object3D][],
  );
  const driver = createRigDriver(boneMap, root);
  return { bones, root, driver };
}

function worldPos(bones: ReturnType<typeof buildStandardSkeleton>['bones'], name: StandardRigBone): Vector3 {
  return bones[name].getWorldPosition(new Vector3());
}

function angleOf(q: { w: number }): number {
  return 2 * Math.acos(Math.min(1, Math.abs(q.w)));
}

describe('imageToWorld 坐标变换', () => {
  it('图像 y 向下 → 世界 y 向上；图像 z 朝摄像头为负 → 世界 +Z 朝摄像头', () => {
    // 图像左上方、靠近摄像头的点
    const p = imageToWorld({ x: 0.2, y: 0.1, z: -0.3 }, false);
    expect(p.x).toBeCloseTo(-0.3); // x 不翻转（解剖学一致）
    expect(p.y).toBeCloseTo(0.4); // y 上翻
    expect(p.z).toBeCloseTo(0.3); // 靠近摄像头 = +Z
  });

  it('mirror=true 时 x 翻转（真镜像模式）', () => {
    const p = imageToWorld({ x: 0.2, y: 0.1, z: -0.3 }, true);
    expect(p.x).toBeCloseTo(0.3);
    expect(p.y).toBeCloseTo(0.4);
    expect(p.z).toBeCloseTo(0.3);
  });
});

describe('摄像头驱动方向语义（应用到真实绑定骨架）', () => {
  it('校准 T-Pose 帧 map 后所有骨骼旋转≈单位四元数', () => {
    const calibration = calibrate([makeFrame(T_POSE), makeFrame(T_POSE)]);
    const rotations = mapPoseFrameToBoneRotations(makeFrame(T_POSE), calibration);
    for (const bone of [
      'LeftUpperArm', 'LeftLowerArm', 'RightUpperArm', 'RightLowerArm',
      'LeftUpperLeg', 'RightUpperLeg', 'Spine', 'Chest', 'Hips', 'Head',
    ] as const) {
      const q = rotations[bone];
      expect(q, bone).toBeDefined();
      // v2 绝对方向映射：合成帧的腿部刻意带 ~1.4° 倾斜（dx=0.005/dy=0.2），
      // 骨骼方向会如实跟随（v1 相对映射下该倾斜被校准抵消），故阈值放宽到 0.03
      expect(angleOf(q!), bone).toBeLessThan(0.03);
    }
  });

  it('右手上举（手腕图像 y 更小）→ 右手腕世界 y 增大，左手不动', () => {
    const calibration = calibrate([makeFrame(T_POSE), makeFrame(T_POSE)]);
    const raised = makeFrame({
      ...T_POSE,
      right_elbow: [0.4, 0.18],
      right_wrist: [0.4, 0.06], // 图像 y 更小 = 更靠上
    });
    const rotations = mapPoseFrameToBoneRotations(raised, calibration);
    expect(rotations.RightUpperArm).toBeDefined();

    const { bones, root, driver } = makeDrivenRig();
    const rightBefore = worldPos(bones, 'RightHand');
    const leftBefore = worldPos(bones, 'LeftHand');
    applyBoneRotations(driver, rotations);
    root.updateMatrixWorld(true);
    const rightAfter = worldPos(bones, 'RightHand');
    const leftAfter = worldPos(bones, 'LeftHand');

    // 核心断言：上举必须让世界 y 增大（Bug 表现是减小）
    expect(rightAfter.y).toBeGreaterThan(rightBefore.y + 0.1);
    // 左右不串：左手保持绑定高度
    expect(angleOf(rotations.LeftUpperArm!)).toBeLessThan(0.02);
    expect(leftAfter.y).toBeCloseTo(leftBefore.y, 3);
  });

  it('右手前伸（z 朝摄像头，图像 z 更负）→ 右手世界 z 朝 +Z（朝向相机）增大', () => {
    const calibration = calibrate([makeFrame(T_POSE), makeFrame(T_POSE)]);
    const reach = makeFrame({
      ...T_POSE,
      right_elbow: [0.38, 0.3, -0.15],
      right_wrist: [0.36, 0.3, -0.35], // 朝摄像头方向（图像 z 为负）
    });
    const rotations = mapPoseFrameToBoneRotations(reach, calibration);

    const { bones, root, driver } = makeDrivenRig();
    const before = worldPos(bones, 'RightHand');
    applyBoneRotations(driver, rotations);
    root.updateMatrixWorld(true);
    const after = worldPos(bones, 'RightHand');

    // 核心断言：前伸必须让世界 z 朝 +Z 增大（Bug 表现是远离相机）
    expect(after.z).toBeGreaterThan(before.z + 0.1);
    // 且高度基本不变（水平前伸，不应变成上举/下压）
    expect(Math.abs(after.y - before.y)).toBeLessThan(0.15);
  });

  it('mirror=true（真镜像）：举右手 → 左手腕世界 y 增大，右手不动', () => {
    // 镜像语义：x 翻转 + 左右互换，用户右手驱动角色左手（画面同侧）。
    // 旧实现只翻 x 不换左右，校准方向与绑定姿态相反，动作全面颠倒——本用例即回归。
    const calibration = calibrate([makeFrame(T_POSE), makeFrame(T_POSE)], { mirror: true });
    const raised = makeFrame({
      ...T_POSE,
      right_elbow: [0.4, 0.18],
      right_wrist: [0.4, 0.06],
    });
    const rotations = mapPoseFrameToBoneRotations(raised, calibration, { mirror: true });

    const { bones, root, driver } = makeDrivenRig();
    const leftBefore = worldPos(bones, 'LeftHand');
    const rightBefore = worldPos(bones, 'RightHand');
    applyBoneRotations(driver, rotations);
    root.updateMatrixWorld(true);
    const leftAfter = worldPos(bones, 'LeftHand');
    const rightAfter = worldPos(bones, 'RightHand');

    expect(leftAfter.y).toBeGreaterThan(leftBefore.y + 0.1); // 镜像：左手抬起
    expect(rightAfter.y).toBeCloseTo(rightBefore.y, 3); // 右手不被带动
  });

  it('mirror=true 校准帧 map 后仍是单位旋转（校准与实时帧同一变换）', () => {
    const calibration = calibrate([makeFrame(T_POSE), makeFrame(T_POSE)], { mirror: true });
    const rotations = mapPoseFrameToBoneRotations(makeFrame(T_POSE), calibration, { mirror: true });
    for (const bone of ['LeftUpperArm', 'RightUpperArm', 'Spine', 'Hips', 'Head'] as const) {
      expect(angleOf(rotations[bone]!), bone).toBeLessThan(0.02);
    }
  });
});
