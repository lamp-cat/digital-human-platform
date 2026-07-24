import { describe, expect, it } from 'vitest';
import { Object3D, Quaternion, Vector3 } from 'three';
import type { PoseFrame, StandardRigBone } from '@dhp/avatar-schema';
import { applyBoneRotations, buildStandardSkeleton, createRigDriver } from '@dhp/avatar-runtime';
import { calibrate, mapPoseFrameToBoneRotations } from '../src/index.js';

type Point3 = [number, number, number];

const NEUTRAL_WORLD: Record<string, Point3> = {
  nose: [0, 0.72, 0.08],
  left_ear: [0.07, 0.69, 0],
  right_ear: [-0.07, 0.69, 0],
  left_shoulder: [0.22, 0.48, 0],
  right_shoulder: [-0.22, 0.48, 0],
  left_elbow: [0.43, 0.45, 0],
  right_elbow: [-0.43, 0.45, 0],
  left_wrist: [0.62, 0.42, 0],
  right_wrist: [-0.62, 0.42, 0],
  left_hip: [0.13, 0, 0],
  right_hip: [-0.13, 0, 0],
  left_knee: [0.12, -0.46, 0],
  right_knee: [-0.12, -0.46, 0],
  left_ankle: [0.12, -0.91, 0],
  right_ankle: [-0.12, -0.91, 0],
};

const UPPER_BODY_NAMES = new Set([
  'nose',
  'left_ear',
  'right_ear',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
]);

function rotateY(point: Point3, degrees: number): Vector3 {
  return new Vector3(...point).applyAxisAngle(new Vector3(0, 1, 0), (degrees * Math.PI) / 180);
}

/** 构造带 MediaPipe worldLandmarks 的人体；torsoYaw 可单独模拟扭腰。 */
function makeTurnFrame(
  hipsYaw: number,
  torsoYaw = hipsYaw,
  visibility: Record<string, number> = {},
): PoseFrame {
  return {
    timestampMs: 0,
    source: 'test',
    confidence: 0.98,
    landmarks: Object.entries(NEUTRAL_WORLD).map(([name, point]) => {
      const world = rotateY(point, UPPER_BODY_NAMES.has(name) ? torsoYaw : hipsYaw);
      return {
        name,
        // 图像坐标只作为兼容字段；映射会优先使用下面的米制 worldLandmarks。
        x: 0.5 + world.x * 0.5,
        y: 0.5 - world.y * 0.5,
        z: -world.z,
        wx: world.x,
        wy: -world.y,
        wz: -world.z,
        visibility: visibility[name] ?? 0.99,
      };
    }),
  };
}

function quaternionOf(q: { x: number; y: number; z: number; w: number }): Quaternion {
  return new Quaternion(q.x, q.y, q.z, q.w).normalize();
}

/** 读取四元数把绑定横轴 +X 转到的水平角。 */
function yawDegrees(q: { x: number; y: number; z: number; w: number }): number {
  const lateral = new Vector3(1, 0, 0).applyQuaternion(quaternionOf(q));
  return (Math.atan2(-lateral.z, lateral.x) * 180) / Math.PI;
}

describe('主角转体映射', () => {
  const calibration = calibrate([makeTurnFrame(0), makeTurnFrame(0)]);

  it('整个人侧转 90° 时 Hips、Spine、Chest 和 UpperChest 共同转向', () => {
    const rotations = mapPoseFrameToBoneRotations(makeTurnFrame(90), calibration);
    for (const bone of ['Hips', 'Spine', 'Chest', 'UpperChest'] as const) {
      expect(rotations[bone], bone).toBeDefined();
      expect(yawDegrees(rotations[bone]!), bone).toBeCloseTo(90, 1);
    }
  });

  it('应用到真实 StandardRig 后胸腔正面确实转向侧方', () => {
    const rotations = mapPoseFrameToBoneRotations(makeTurnFrame(90), calibration);
    const { bones, rootBone } = buildStandardSkeleton();
    const root = new Object3D();
    root.add(rootBone);
    root.updateMatrixWorld(true);
    const driver = createRigDriver(
      new Map(
        Object.entries(bones) as [
          StandardRigBone,
          (typeof bones)[StandardRigBone],
        ][],
      ),
      root,
    );

    applyBoneRotations(driver, rotations);
    root.updateMatrixWorld(true);
    const chestForward = new Vector3(0, 0, 1).applyQuaternion(
      bones.Chest.getWorldQuaternion(new Quaternion()),
    );
    expect(chestForward.x).toBeGreaterThan(0.98);
    expect(Math.abs(chestForward.z)).toBeLessThan(0.02);
  });

  it('支持接近背身的 175° 转体，不再被旧的 60° 上限截断', () => {
    const rotations = mapPoseFrameToBoneRotations(makeTurnFrame(175), calibration);
    expect(yawDegrees(rotations.Hips!)).toBeCloseTo(175, 1);
    expect(yawDegrees(rotations.Chest!)).toBeCloseTo(175, 1);
  });

  it('标定帧本身侧身时仍输出世界系绝对朝向，不把侧身误当正面', () => {
    const sideCalibration = calibrate([makeTurnFrame(45), makeTurnFrame(45)]);
    const rotations = mapPoseFrameToBoneRotations(makeTurnFrame(90), sideCalibration);
    expect(yawDegrees(rotations.Hips!)).toBeCloseTo(90, 1);
    expect(yawDegrees(rotations.Chest!)).toBeCloseTo(90, 1);
  });

  it('肩部相对骨盆扭转时沿 Spine → Chest 分配，而不是只转髋部', () => {
    const rotations = mapPoseFrameToBoneRotations(makeTurnFrame(0, 70), calibration);
    expect(Math.abs(yawDegrees(rotations.Hips!))).toBeLessThan(1);
    expect(yawDegrees(rotations.Spine!)).toBeCloseTo(35, 1);
    expect(yawDegrees(rotations.Chest!)).toBeCloseTo(70, 1);
    expect(yawDegrees(rotations.UpperChest!)).toBeCloseTo(70, 1);
  });

  it('上半身模式不写 Hips，但肩胸仍可识别 90° 转体', () => {
    const rotations = mapPoseFrameToBoneRotations(makeTurnFrame(90), calibration, {
      trackingMode: 'upper',
    });
    expect(rotations.Hips).toBeUndefined();
    expect(rotations.LeftUpperLeg).toBeUndefined();
    expect(yawDegrees(rotations.Spine!)).toBeCloseTo(90, 1);
    expect(yawDegrees(rotations.Chest!)).toBeCloseTo(90, 1);
  });

  it('侧身时远侧肩可见性略低仍保留转体结果', () => {
    const rotations = mapPoseFrameToBoneRotations(
      makeTurnFrame(90, 90, { right_shoulder: 0.4 }),
      calibration,
    );
    expect(yawDegrees(rotations.Chest!)).toBeCloseTo(90, 1);
  });

  it('越过背身的 179° → -179° 时四元数保持旋转连续', () => {
    const before = mapPoseFrameToBoneRotations(makeTurnFrame(179), calibration);
    const after = mapPoseFrameToBoneRotations(makeTurnFrame(-179), calibration);
    const distanceDeg =
      (quaternionOf(before.Chest!).angleTo(quaternionOf(after.Chest!)) * 180) / Math.PI;
    expect(distanceDeg).toBeLessThan(3);
  });
});
