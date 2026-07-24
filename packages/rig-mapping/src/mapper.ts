import { Matrix4, Quaternion, Vector3 } from 'three';
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
  /** 躯干俯仰/侧弯最大角度（度），默认 30。 */
  maxSpineBendDeg?: number;
  /** 骨盆最大水平转角（度），默认 179。 */
  maxHipsTurnDeg?: number;
  /** 肩胸最大水平转角（度），默认 179。 */
  maxTorsoTurnDeg?: number;
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
 * v3 = 延续 v2 的肢体绝对映射；头部改为相对校准姿态的旋转增量，
 *      消除肩→鼻向量固有的前倾/俯视偏差。
 * v4 = 肩线/髋线与躯干竖轴共同构建身体三维坐标系，骨盆、脊柱和胸腔
 *      都能跟随完整水平转体；不再用单条竖直线估计躯干朝向。
 *      注：实验过校准帧坐标系修正（frameRotation），实测会把检测器
 *      系统噪声注入映射、误差反而增大（离线评估 18.0° vs 15.8°），故不采用——
 *      image/world landmarks 与预览画面同系，原样复现才符合用户观感。
 * v5 = 头颈旋转改为“肩胸绝对朝向 + 头部局部增量”。转身时 Neck 与 Head
 *      必然先跟随身体，鼻部短时丢失也不会把头钉在世界正面。
 */
export const MAPPER_VERSION = 'absolute-world-v5';

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

/** 用身体横轴和竖轴构造正交坐标系；绑定姿态为 X=左、Y=上、Z=面向观察者。 */
function bodyFrameQuaternion(lateral: Vector3, vertical: Vector3): Quaternion | null {
  if (lateral.lengthSq() < 1e-10 || vertical.lengthSq() < 1e-10) return null;
  const x = lateral.clone().normalize();
  const y = vertical.clone().addScaledVector(x, -vertical.dot(x));
  if (y.lengthSq() < 1e-10) return null;
  y.normalize();
  const z = x.clone().cross(y);
  if (z.lengthSq() < 1e-10) return null;
  z.normalize();
  y.copy(z).cross(x).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z)).normalize();
}

/**
 * 身体坐标系旋转。
 * 水平转角使用摄像机世界系下的绝对朝向，确保视频即使在侧身帧完成标定也不会把
 * 侧身误当正面；俯仰/侧弯才相对校准姿态去偏置，并单独限幅以抑制深度噪声。
 */
function bodyFrameRotation(
  currentLateral: Vector3 | null,
  currentVertical: Vector3 | null,
  restLateral: Vector3 | null,
  restVertical: Vector3 | null,
  maxTurn: number,
  maxBend: number,
): Quaternion | null {
  if (!currentLateral || !currentVertical || !restLateral || !restVertical) return null;
  const current = bodyFrameQuaternion(currentLateral, currentVertical);
  const rest = bodyFrameQuaternion(restLateral, restVertical);
  if (!current || !rest) return null;

  const lateral = new Vector3(1, 0, 0).applyQuaternion(current);
  const yaw = Math.atan2(-lateral.z, lateral.x);
  const limitedYaw = Math.max(-maxTurn, Math.min(maxTurn, yaw));
  const yawRotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), limitedYaw);
  const currentYaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw);
  const currentBend = currentYaw.invert().multiply(current);

  const restLateralAxis = new Vector3(1, 0, 0).applyQuaternion(rest);
  const restYawAngle = Math.atan2(-restLateralAxis.z, restLateralAxis.x);
  const restYaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), restYawAngle);
  const restBend = restYaw.invert().multiply(rest);

  const bendDelta = currentBend.multiply(restBend.invert()).normalize();
  clampQuaternionAngle(bendDelta, maxBend);
  return yawRotation.multiply(bendDelta).normalize();
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
  const maxHipsTurn = (opts.maxHipsTurnDeg ?? 179) * DEG;
  const maxTorsoTurn = (opts.maxTorsoTurnDeg ?? 179) * DEG;
  const maxHeadTurn = (opts.maxHeadTurnDeg ?? 45) * DEG;
  const upperBodyOnly = opts.trackingMode === 'upper';

  const lmMap = new Map(frame.landmarks.map((lm) => [lm.name, lm]));
  const pointAtVisibility = (name: string, threshold: number): Vector3 | null => {
    // 镜像模式：x 翻转的同时交换左右关键点，保持与绑定姿态方向语义一致
    const lm = lmMap.get(mirror ? swapLateralName(name) : name);
    if (!lm || lm.visibility < threshold) return null;
    return landmarkToWorld(lm, mirror);
  };
  const point = (name: string): Vector3 | null => pointAtVisibility(name, visibilityThreshold);
  // 侧身时远侧肩/髋的 visibility 常略低，但三维坐标仍可用于稳定估计朝向。
  const orientationPoint = (name: string): Vector3 | null =>
    pointAtVisibility(name, Math.min(visibilityThreshold, 0.35));
  const mid = (a: string, b: string): Vector3 | null => {
    const pa = point(a);
    const pb = point(b);
    return pa && pb ? pa.add(pb).multiplyScalar(0.5) : null;
  };
  const orientationMid = (a: string, b: string): Vector3 | null => {
    const pa = orientationPoint(a);
    const pb = orientationPoint(b);
    return pa && pb ? pa.add(pb).multiplyScalar(0.5) : null;
  };
  const calibrationPoint = (name: string): Vector3 | null => {
    const remirror = mirror !== calibration.mirror;
    const sourceName = remirror ? swapLateralName(name) : name;
    const lm = calibration.meanLandmarks[sourceName];
    if (!lm) return null;
    return new Vector3(remirror ? -lm.x : lm.x, lm.y, lm.z);
  };
  const calibrationMid = (a: string, b: string): Vector3 | null => {
    const pa = calibrationPoint(a);
    const pb = calibrationPoint(b);
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

  const leftShoulder = orientationPoint('left_shoulder');
  const rightShoulder = orientationPoint('right_shoulder');
  const leftHip = orientationPoint('left_hip');
  const rightHip = orientationPoint('right_hip');
  const shoulderMid = orientationMid('left_shoulder', 'right_shoulder');
  const hipMid = orientationMid('left_hip', 'right_hip');
  const torsoVertical =
    shoulderMid && hipMid ? shoulderMid.clone().sub(hipMid) : null;
  const shoulderLateral =
    leftShoulder && rightShoulder ? leftShoulder.clone().sub(rightShoulder) : null;
  const hipLateral = leftHip && rightHip ? leftHip.clone().sub(rightHip) : null;

  const restLeftShoulder = calibrationPoint('left_shoulder');
  const restRightShoulder = calibrationPoint('right_shoulder');
  const restLeftHip = calibrationPoint('left_hip');
  const restRightHip = calibrationPoint('right_hip');
  const restShoulderMid = calibrationMid('left_shoulder', 'right_shoulder');
  const restHipMid = calibrationMid('left_hip', 'right_hip');
  const restVertical =
    restShoulderMid && restHipMid ? restShoulderMid.clone().sub(restHipMid) : null;
  const restShoulderLateral =
    restLeftShoulder && restRightShoulder
      ? restLeftShoulder.clone().sub(restRightShoulder)
      : null;
  const restHipLateral =
    restLeftHip && restRightHip ? restLeftHip.clone().sub(restRightHip) : null;

  const hipsRotation = bodyFrameRotation(
    hipLateral,
    torsoVertical,
    restHipLateral,
    restVertical,
    maxHipsTurn,
    maxSpineBend,
  );
  const torsoRotation = bodyFrameRotation(
    shoulderLateral ?? hipLateral,
    torsoVertical,
    restShoulderLateral ?? restHipLateral,
    restVertical,
    maxTorsoTurn,
    maxSpineBend,
  );

  // 世界系旋转增量不能只写 Hips，否则子级 Spine/Chest 会反向补偿而继续朝前。
  // Spine 位于骨盆与肩胸之间，Chest/UpperChest 跟随完整肩胸朝向。
  if (torsoRotation) {
    const spineRotation = hipsRotation
      ? hipsRotation.clone().slerp(torsoRotation, 0.5)
      : torsoRotation.clone();
    result.Spine = {
      x: spineRotation.x,
      y: spineRotation.y,
      z: spineRotation.z,
      w: spineRotation.w,
    };
    for (const bone of ['Chest', 'UpperChest'] as const) {
      result[bone] = {
        x: torsoRotation.x,
        y: torsoRotation.y,
        z: torsoRotation.z,
        w: torsoRotation.w,
      };
    }
  } else {
    // 缺少三维横轴时保留旧的弯腰回退，不因局部遮挡完全丢失躯干驱动。
    emitDelta(
      'spine',
      'Spine',
      torsoVertical ? torsoVertical.clone() : null,
      maxSpineBend,
      0.5,
    );
    emitDelta(
      'spine',
      'Chest',
      torsoVertical ? torsoVertical.clone() : null,
      maxSpineBend,
      0.5,
    );
  }

  // 上半身模式仍不写 Hips；但 Spine/Chest 可以跟随转体，不涉及髋关节控制。
  if (!upperBodyOnly && hipsRotation) {
    result.Hips = {
      x: hipsRotation.x,
      y: hipsRotation.y,
      z: hipsRotation.z,
      w: hipsRotation.w,
    };
  }

  // 头颈必须以肩胸朝向为父级基准：先随躯干整体转向，再叠加头部相对肩胸的动作。
  // 直接在世界系比较“肩中点 → 鼻”会让身体转身时 Head 被限制在旧正面，形成拧颈。
  if (torsoRotation) {
    let localHeadDelta = new Quaternion();
    const nose = orientationPoint('nose');
    const restNose = calibrationPoint('nose');
    const currentTorsoFrame =
      shoulderLateral && torsoVertical
        ? bodyFrameQuaternion(shoulderLateral, torsoVertical)
        : null;
    const restTorsoFrame =
      restShoulderLateral && restVertical
        ? bodyFrameQuaternion(restShoulderLateral, restVertical)
        : null;
    if (
      nose &&
      shoulderMid &&
      restNose &&
      restShoulderMid &&
      currentTorsoFrame &&
      restTorsoFrame
    ) {
      const currentLocal = nose
        .clone()
        .sub(shoulderMid)
        .applyQuaternion(currentTorsoFrame.clone().invert());
      const restLocal = restNose
        .clone()
        .sub(restShoulderMid)
        .applyQuaternion(restTorsoFrame.clone().invert());
      if (currentLocal.lengthSq() >= 1e-10 && restLocal.lengthSq() >= 1e-10) {
        localHeadDelta = new Quaternion().setFromUnitVectors(
          restLocal.normalize(),
          currentLocal.normalize(),
        );
        clampQuaternionAngle(localHeadDelta, maxHeadTurn);
      }
    }

    const neckWorld = torsoRotation.clone().multiply(scaleQuaternion(localHeadDelta, 0.35));
    const headWorld = torsoRotation.clone().multiply(localHeadDelta);
    result.Neck = {
      x: neckWorld.x,
      y: neckWorld.y,
      z: neckWorld.z,
      w: neckWorld.w,
    };
    result.Head = {
      x: headWorld.x,
      y: headWorld.y,
      z: headWorld.z,
      w: headWorld.w,
    };
  } else {
    // 躯干横轴暂时不可用时沿用相对校准的头部回退，避免头部完全冻结。
    const headCurrent = (() => {
      const currentShoulderMid = mid('left_shoulder', 'right_shoulder');
      const nose = point('nose');
      return currentShoulderMid && nose ? nose.sub(currentShoulderMid) : null;
    })();
    const rest = calibration.restDirections.head;
    if (headCurrent && rest) {
      const q = new Quaternion().setFromUnitVectors(
        new Vector3(rest.x, rest.y, rest.z).normalize(),
        headCurrent.normalize(),
      );
      clampQuaternionAngle(q, maxHeadTurn);
      result.Head = { x: q.x, y: q.y, z: q.z, w: q.w };
    }
  }

  return result;
}
