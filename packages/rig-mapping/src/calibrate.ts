import { Vector3 } from 'three';
import type { PoseFrame } from '@dhp/avatar-schema';
import { landmarkToWorld, swapLateralName } from './coords.js';

/** 驱动用的肢体段（文档 §10.3）。 */
export type DrivenSegment =
  | 'leftUpperArm'
  | 'leftLowerArm'
  | 'rightUpperArm'
  | 'rightLowerArm'
  | 'leftUpperLeg'
  | 'leftLowerLeg'
  | 'rightUpperLeg'
  | 'rightLowerLeg'
  | 'spine'
  | 'hips'
  | 'head';

/** 简单两点段的关键点端点。 */
export const SEGMENT_ENDPOINTS: Record<string, [string, string]> = {
  leftUpperArm: ['left_shoulder', 'left_elbow'],
  leftLowerArm: ['left_elbow', 'left_wrist'],
  rightUpperArm: ['right_shoulder', 'right_elbow'],
  rightLowerArm: ['right_elbow', 'right_wrist'],
  leftUpperLeg: ['left_hip', 'left_knee'],
  leftLowerLeg: ['left_knee', 'left_ankle'],
  rightUpperLeg: ['right_hip', 'right_knee'],
  rightLowerLeg: ['right_knee', 'right_ankle'],
};

/** 校准结果：用户 A/T Pose 均值（舞台坐标系）。 */
export interface CalibrationData {
  createdAtMs: number;
  frameCount: number;
  meanConfidence: number;
  mirror: boolean;
  visibilityThreshold: number;
  shoulderWidth: number;
  hipWidth: number;
  /** 各肢体段的校准方向（单位向量，舞台坐标）。缺端点的段缺省。 */
  restDirections: Partial<Record<DrivenSegment, { x: number; y: number; z: number }>>;
  /** 校准帧关键点均值（调试/展示用，舞台坐标）。 */
  meanLandmarks: Record<string, { x: number; y: number; z: number; visibility: number }>;
}

export interface CalibrateOptions {
  mirror?: boolean;
  visibilityThreshold?: number;
}

/** 校准必须可见的关键点（否则骨骼朝向无法建立）。 */
const REQUIRED_LANDMARKS = ['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip'];

function dir(a: Vector3, b: Vector3): { x: number; y: number; z: number } {
  const v = b.clone().sub(a).normalize();
  return { x: v.x, y: v.y, z: v.z };
}

/**
 * 校准：取 2–3 秒 A/T Pose 帧的均值，记录肩宽、髋宽与各肢体骨骼朝向。
 * 关键点样本可见性低于阈值的不计入均值；有 worldLandmarks 时优先用
 * （米制、深度可靠，见 coords.ts landmarkToWorld）。
 */
export function calibrate(frames: PoseFrame[], opts: CalibrateOptions = {}): CalibrationData {
  if (frames.length === 0) throw new Error('校准失败：没有可用的姿态帧');
  const mirror = opts.mirror ?? false;
  const visibilityThreshold = opts.visibilityThreshold ?? 0.5;

  const acc = new Map<string, { sx: number; sy: number; sz: number; sv: number; n: number }>();
  let confidenceSum = 0;
  for (const frame of frames) {
    confidenceSum += frame.confidence;
    for (const lm of frame.landmarks) {
      if (lm.visibility < visibilityThreshold) continue;
      // 镜像模式：x 翻转的同时交换左右关键点（与 mapper 同一变换）
      const name = mirror ? swapLateralName(lm.name) : lm.name;
      const p = landmarkToWorld(lm, mirror);
      const a = acc.get(name) ?? { sx: 0, sy: 0, sz: 0, sv: 0, n: 0 };
      a.sx += p.x;
      a.sy += p.y;
      a.sz += p.z;
      a.sv += lm.visibility;
      a.n += 1;
      acc.set(name, a);
    }
  }

  const mean = new Map<string, Vector3>();
  const meanLandmarks: CalibrationData['meanLandmarks'] = {};
  for (const [name, a] of acc) {
    mean.set(name, new Vector3(a.sx / a.n, a.sy / a.n, a.sz / a.n));
    meanLandmarks[name] = { x: a.sx / a.n, y: a.sy / a.n, z: a.sz / a.n, visibility: a.sv / a.n };
  }

  for (const name of REQUIRED_LANDMARKS) {
    if (!mean.has(name)) {
      throw new Error(`校准失败：关键点 ${name} 可见性不足，请确保人体完整入镜`);
    }
  }
  const need = (name: string): Vector3 => mean.get(name)!;
  const mid = (a: string, b: string): Vector3 => need(a).clone().add(need(b)).multiplyScalar(0.5);

  const restDirections: CalibrationData['restDirections'] = {};
  // 四肢段（端点缺失则跳过该段）
  for (const [segment, [from, to]] of Object.entries(SEGMENT_ENDPOINTS)) {
    if (mean.has(from) && mean.has(to)) {
      restDirections[segment as DrivenSegment] = dir(need(from), need(to));
    }
  }
  // 脊柱：髋中点 → 肩中点
  restDirections.spine = dir(mid('left_hip', 'right_hip'), mid('left_shoulder', 'right_shoulder'));
  // 骨盆：右髋 → 左髋（髋线朝向）
  restDirections.hips = dir(need('right_hip'), need('left_hip'));
  // 头部：肩中点 → 鼻（缺失鼻子时跳过）
  if (mean.has('nose')) {
    restDirections.head = dir(mid('left_shoulder', 'right_shoulder'), need('nose'));
  }

  return {
    createdAtMs: frames[frames.length - 1].timestampMs,
    frameCount: frames.length,
    meanConfidence: confidenceSum / frames.length,
    mirror,
    visibilityThreshold,
    shoulderWidth: need('left_shoulder').distanceTo(need('right_shoulder')),
    hipWidth: need('left_hip').distanceTo(need('right_hip')),
    restDirections,
    meanLandmarks,
  };
}
