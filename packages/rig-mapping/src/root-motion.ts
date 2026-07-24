import type { PoseFrame } from '@dhp/avatar-schema';
import type { CalibrationData } from './calibrate.js';
import { landmarkToWorld } from './coords.js';
import { OneEuroFilter } from './filters.js';

export interface CrouchMotionOptions {
  /** 数字人髋高（米），内置 StandardRig 绑定髋高为 0.95。 */
  avatarHipHeight?: number;
  /** 最大下蹲位移，默认 0.65m。 */
  maxCrouchMeters?: number;
  /** 站姿附近的位移死区，默认 0.018m。 */
  deadbandMeters?: number;
  /** 每秒最大髋部位移，限制误检导致的上下抽动。 */
  maxSpeedMetersPerSec?: number;
}

/** 真人髋中点到较低支撑脚踝的垂直高度。 */
export function measurePoseHipHeight(
  frame: PoseFrame,
  visibilityThreshold = 0.45,
): number | null {
  const landmarks = new Map(frame.landmarks.map((landmark) => [landmark.name, landmark]));
  const leftHip = landmarks.get('left_hip');
  const rightHip = landmarks.get('right_hip');
  if (
    !leftHip ||
    !rightHip ||
    leftHip.visibility < visibilityThreshold ||
    rightHip.visibility < visibilityThreshold
  ) {
    return null;
  }
  const hipY =
    (landmarkToWorld(leftHip, false).y + landmarkToWorld(rightHip, false).y) / 2;
  const ankleYs = ['left_ankle', 'right_ankle']
    .map((name) => landmarks.get(name))
    .filter(
      (landmark): landmark is NonNullable<typeof landmark> =>
        !!landmark && landmark.visibility >= visibilityThreshold,
    )
    .map((landmark) => landmarkToWorld(landmark, false).y);
  if (ankleYs.length === 0) return null;
  const height = hipY - Math.min(...ankleYs);
  return Number.isFinite(height) && height > 0.04 ? height : null;
}

/** 从若干候选帧取高分位数，避免某一帧正处于下蹲而把蹲姿当站姿。 */
export function estimateStandingHipHeight(frames: PoseFrame[]): number | null {
  const heights = frames
    .map((frame) => measurePoseHipHeight(frame))
    .filter((height): height is number => height !== null)
    .sort((a, b) => a - b);
  if (heights.length === 0) return null;
  return heights[Math.min(heights.length - 1, Math.floor(heights.length * 0.85))];
}

/** 摄像头站姿校准结果中的髋高基准。 */
export function calibrationHipHeight(calibration: CalibrationData): number | null {
  const leftHip = calibration.meanLandmarks.left_hip;
  const rightHip = calibration.meanLandmarks.right_hip;
  const ankles = [
    calibration.meanLandmarks.left_ankle,
    calibration.meanLandmarks.right_ankle,
  ].filter((landmark): landmark is NonNullable<typeof landmark> => !!landmark);
  if (!leftHip || !rightHip || ankles.length === 0) return null;
  const hipY = (leftHip.y + rightHip.y) / 2;
  const height = hipY - Math.min(...ankles.map((ankle) => ankle.y));
  return Number.isFinite(height) && height > 0.04 ? height : null;
}

/**
 * 蹲起根运动：腿部仍由绝对骨骼方向驱动，本类只补偿 Hips 的垂直位置，
 * 让支撑脚尽量留在地面。死区、One Euro 与速度限制共同抑制上下抽动。
 */
export class CrouchMotionTracker {
  private baselineHeight: number | null;
  private filter = new OneEuroFilter({ minCutoff: 1.25, beta: 0.18, dCutoff: 1 });
  private lastTimestampMs: number | null = null;
  private lastOffsetY = 0;
  private readonly avatarHipHeight: number;
  private readonly maxCrouchMeters: number;
  private readonly deadbandMeters: number;
  private readonly maxSpeedMetersPerSec: number;

  constructor(baselineHeight: number | null = null, options: CrouchMotionOptions = {}) {
    this.baselineHeight = baselineHeight;
    this.avatarHipHeight = options.avatarHipHeight ?? 0.95;
    this.maxCrouchMeters = options.maxCrouchMeters ?? 0.65;
    this.deadbandMeters = options.deadbandMeters ?? 0.018;
    this.maxSpeedMetersPerSec = options.maxSpeedMetersPerSec ?? 1.6;
  }

  setBaseline(height: number | null): void {
    this.baselineHeight = height;
    this.reset();
  }

  update(frame: PoseFrame): number {
    const measured = measurePoseHipHeight(frame);
    if (measured === null) return this.lastOffsetY;
    if (this.baselineHeight === null) this.baselineHeight = measured;
    const baseline = this.baselineHeight;
    if (!(baseline > 0.04)) return this.lastOffsetY;

    // 用身高比例归一化，不依赖真人离相机的距离或实际身高。
    let target = ((measured - baseline) / baseline) * this.avatarHipHeight;
    target = Math.min(0.04, Math.max(-this.maxCrouchMeters, target));
    if (Math.abs(target) < this.deadbandMeters) target = 0;

    const dt =
      this.lastTimestampMs === null
        ? 1 / 30
        : Math.min(0.1, Math.max(1 / 120, (frame.timestampMs - this.lastTimestampMs) / 1000));
    this.lastTimestampMs = frame.timestampMs;
    const filtered = this.filter.filter(target, dt);
    const maxDelta = this.maxSpeedMetersPerSec * dt;
    const limited = Math.min(
      this.lastOffsetY + maxDelta,
      Math.max(this.lastOffsetY - maxDelta, filtered),
    );
    this.lastOffsetY = Math.abs(limited) < this.deadbandMeters * 0.5 ? 0 : limited;
    return this.lastOffsetY;
  }

  reset(): void {
    this.filter.reset();
    this.lastTimestampMs = null;
    this.lastOffsetY = 0;
  }
}
