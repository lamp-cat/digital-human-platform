import { Quaternion, Vector3 } from 'three';
import type { PoseFrame, PoseTrackingMode, StandardRigBone } from '@dhp/avatar-schema';
import type { CalibrationData, DrivenSegment } from './calibrate.js';
import { SEGMENT_ENDPOINTS } from './calibrate.js';
import { landmarkToWorld, swapLateralName } from './coords.js';

/** 骨骼旋转输出：世界系旋转增量（相对绑定姿态）。 */
export type BoneRotationMap = Partial<Record<StandardRigBone, { x: number; y: number; z: number; w: number }>>;

export interface MapPoseOptions {
  /** 覆盖校准时的镜像设置（默认沿用 calibration.mirror）。 */
  mirror?: boolean;
  /** 关键点可见性阈值（默认沿用校准值 0.5）。 */
  visibilityThreshold?: number;
  /** 脊柱最大弯曲角（度），默认 30（Spine/Chest 各分摊一半）。 */
  maxSpineBendDeg?: number;
  /** 骨盆最大转角（度），默认 60（体转运动需要更大范围）。 */
  maxHipsTurnDeg?: number;
  /** 头部最大偏转角（度），默认 45。 */
  maxHeadTurnDeg?: number;
  /** 追踪模式：upper 时不驱动髋关节和双腿，保持当前动画/绑定姿态；默认 full。 */
  trackingMode?: PoseTrackingMode;
}

const DEG = Math.PI / 180;
const IDENTITY = new Quaternion();

/**
 * 映射算法版本（写入分析报告，用于修复前后对比）。
 * v1 = 相对校准姿态的 delta 映射（图像坐标）；
 * v2 = 绝对方向映射：骨骼世界方向直接对齐关键点世界方向
 *      （worldLandmarks 优先，米制、深度可靠），与校准姿势无关
 *      （站立预备即可校准，不再要求 A/T Pose 对齐绑定姿态）。
 *      注：实验过校准帧坐标系修正（frameRotation），实测会把检测器
 *      系统噪声注入映射、误差反而增大（离线评估 18.0° vs 15.8°），故不采用——
 *      image/world landmarks 与预览画面同系，原样复现才符合用户观感。
 */
export const MAPPER_VERSION = 'absolute-world-v2';

/**
 * 绑定姿态（T-Pose，面向 +Z，Y 向上）下各肢体段的世界方向。
 * 与 avatar-runtime skeleton.ts 的 BONE_LOCAL_POSITIONS 一致
 * （左臂/髋线 +X，右臂 -X，腿 -Y，脊柱/头 +Y）；
 * test/bind-directions 有回归断言，防止与骨架定义漂移。
 */
const BIND_DIRECTIONS: Record<DrivenSegment, Vector3> = {
  leftUpperArm: new Vector3(1, 0, 0),
  leftLowerArm: new Vector3(1, 0, 0),
  rightUpperArm: new Vector3(-1, 0, 0),
  rightLowerArm: new Vector3(-1, 0, 0),
  leftUpperLeg: new Vector3(0, -1, 0),
  leftLowerLeg: new Vector3(0, -1, 0),
  rightUpperLeg: new Vector3(0, -1, 0),
  rightLowerLeg: new Vector3(0, -1, 0),
  spine: new Vector3(0, 1, 0),
  hips: new Vector3(1, 0, 0),
  head: new Vector3(0, 1, 0),
};

/** 将四元数的角度限制到 maxAngle 内（沿原轴向截断）。 */
export function clampQuaternionAngle(q: Quaternion, maxAngle: number): Quaternion {
  const angle = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
  if (angle <= maxAngle || angle < 1e-6) return q;
  const clamped = IDENTITY.clone().slerp(q, maxAngle / angle);
  return q.copy(clamped);
}

/** 按比例缩放旋转量（用于脊柱分摊到 Spine/Chest）。 */
function scaleQuaternion(q: Quaternion, scale: number): Quaternion {
  return IDENTITY.clone().slerp(q, scale);
}

const SEGMENT_TO_BONE: Record<string, StandardRigBone> = {
  leftUpperArm: 'LeftUpperArm',
  leftLowerArm: 'LeftLowerArm',
  rightUpperArm: 'RightUpperArm',
  rightLowerArm: 'RightLowerArm',
  leftUpperLeg: 'LeftUpperLeg',
  leftLowerLeg: 'LeftLowerLeg',
  rightUpperLeg: 'RightUpperLeg',
  rightLowerLeg: 'RightLowerLeg',
};

/** 腿部肢体段（上半身模式下跳过）。 */
const LEG_SEGMENTS = new Set(['leftUpperLeg', 'leftLowerLeg', 'rightUpperLeg', 'rightLowerLeg']);

/**
 * 单帧姿态 → StandardRig 骨骼旋转（文档 §10.3）。
 * 绝对方向映射：把关键点肢体方向（经校准帧坐标系修正）直接设为骨骼世界方向，
 * 输出 = 绑定方向 → 目标方向的世界系旋转增量；可见性低于阈值的关键点对应骨骼不输出。
 */
export function mapPoseFrameToBoneRotations(
  frame: PoseFrame,
  calibration: CalibrationData,
  opts: MapPoseOptions = {},
): BoneRotationMap {
  const mirror = opts.mirror ?? calibration.mirror;
  const visibilityThreshold = opts.visibilityThreshold ?? calibration.visibilityThreshold;
  const maxSpineBend = (opts.maxSpineBendDeg ?? 30) * DEG;
  const maxHipsTurn = (opts.maxHipsTurnDeg ?? 60) * DEG;
  const maxHeadTurn = (opts.maxHeadTurnDeg ?? 45) * DEG;
  const upperBodyOnly = opts.trackingMode === 'upper';

  const lmMap = new Map(frame.landmarks.map((lm) => [lm.name, lm]));
  const point = (name: string): Vector3 | null => {
    // 镜像模式：x 翻转的同时交换左右关键点，保持与绑定姿态方向语义一致
    const lm = lmMap.get(mirror ? swapLateralName(name) : name);
    if (!lm || lm.visibility < visibilityThreshold) return null;
    return landmarkToWorld(lm, mirror);
  };
  const mid = (a: string, b: string): Vector3 | null => {
    const pa = point(a);
    const pb = point(b);
    return pa && pb ? pa.add(pb).multiplyScalar(0.5) : null;
  };

  const result: BoneRotationMap = {};

  const emitDelta = (
    segment: DrivenSegment,
    bone: StandardRigBone,
    current: Vector3 | null,
    maxAngle?: number,
    scale = 1,
  ) => {
    if (!current || current.lengthSq() < 1e-10) return;
    const curV = current.normalize();
    const q = new Quaternion().setFromUnitVectors(BIND_DIRECTIONS[segment], curV);
    if (maxAngle !== undefined) clampQuaternionAngle(q, maxAngle);
    const scaled = scale === 1 ? q : scaleQuaternion(q, scale);
    result[bone] = { x: scaled.x, y: scaled.y, z: scaled.z, w: scaled.w };
  };

  // 四肢：绝对方向对齐，不限角（膝盖反向由方向向量自然表达）
  for (const [segment, [from, to]] of Object.entries(SEGMENT_ENDPOINTS)) {
    if (upperBodyOnly && LEG_SEGMENTS.has(segment)) continue; // 上半身模式：双腿不驱动
    const a = point(from);
    const b = point(to);
    if (!a || !b) continue; // 可见性不足 → 不输出该骨骼
    emitDelta(segment as DrivenSegment, SEGMENT_TO_BONE[segment], b.sub(a));
  }

  // 脊柱：髋中点 → 肩中点，限弯曲，Spine/Chest 各分摊一半
  const spineCurrent = (() => {
    const hipMid = mid('left_hip', 'right_hip');
    const shoulderMid = mid('left_shoulder', 'right_shoulder');
    return hipMid && shoulderMid ? shoulderMid.sub(hipMid) : null;
  })();
  emitDelta('spine', 'Spine', spineCurrent ? spineCurrent.clone() : null, maxSpineBend, 0.5);
  emitDelta('spine', 'Chest', spineCurrent ? spineCurrent.clone() : null, maxSpineBend, 0.5);

  // 骨盆仅属于全身控制：上半身模式不写入 Hips，避免髋线噪声带动整个人物。
  if (!upperBodyOnly) {
    const hipsCurrent = (() => {
      const r = point('right_hip');
      const l = point('left_hip');
      return r && l ? l.sub(r) : null;
    })();
    emitDelta('hips', 'Hips', hipsCurrent, maxHipsTurn);
  }

  // 头部：肩中点 → 鼻，限最大偏转角
  const headCurrent = (() => {
    const shoulderMid = mid('left_shoulder', 'right_shoulder');
    const nose = point('nose');
    return shoulderMid && nose ? nose.sub(shoulderMid) : null;
  })();
  emitDelta('head', 'Head', headCurrent, maxHeadTurn);

  return result;
}
