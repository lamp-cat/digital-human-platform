import type { PoseFrame, PoseLandmark } from '@dhp/avatar-schema';
import { Vector3 } from 'three';
import { landmarkToWorld } from './coords.js';

export interface PoseCollisionResolverOptions {
  /** 躯干碰撞体相对肩宽的额外间距，默认 8%。 */
  clearanceRatio?: number;
  /** 手腕位于躯干内部时，向身体前方推出的最小比例。 */
  frontBias?: number;
  /** 最低可见性；低于此值不做碰撞纠正。 */
  visibilityThreshold?: number;
}

export interface PoseCollisionResult {
  frame: PoseFrame;
  correctedHands: number;
}

type Side = 'left' | 'right';

function midpoint(a: Vector3, b: Vector3): Vector3 {
  return a.clone().add(b).multiplyScalar(0.5);
}

function writeWorld(
  landmark: PoseLandmark,
  platformWorld: Vector3,
): PoseLandmark {
  if (
    landmark.wx !== undefined &&
    landmark.wy !== undefined &&
    landmark.wz !== undefined
  ) {
    return {
      ...landmark,
      wx: platformWorld.x,
      wy: -platformWorld.y,
      wz: -platformWorld.z,
    };
  }
  return {
    ...landmark,
    x: platformWorld.x + 0.5,
    y: 0.5 - platformWorld.y,
    z: -platformWorld.z,
  };
}

/**
 * 基于人体关键点构建躯干椭球碰撞体，并把进入胸腹内部的手腕推出体表。
 *
 * 纠正只旋转“肘→腕”方向，保留前臂长度；手掌三个 Pose 锚点跟随同一位移，
 * 因而不会为了防穿模而拉长手臂或打乱掌面朝向。手指的局部弯曲仍由
 * Hand Landmarker 单独驱动。
 */
export class PoseCollisionResolver {
  constructor(private readonly opts: PoseCollisionResolverOptions = {}) {}

  apply(frame: PoseFrame): PoseCollisionResult {
    const visibility = this.opts.visibilityThreshold ?? 0.45;
    const byName = new Map(frame.landmarks.map((landmark) => [landmark.name, landmark]));
    const leftShoulder = byName.get('left_shoulder');
    const rightShoulder = byName.get('right_shoulder');
    const leftHip = byName.get('left_hip');
    const rightHip = byName.get('right_hip');
    if (
      !leftShoulder ||
      !rightShoulder ||
      !leftHip ||
      !rightHip ||
      [leftShoulder, rightShoulder, leftHip, rightHip].some(
        (point) => point.visibility < visibility,
      )
    ) {
      return { frame, correctedHands: 0 };
    }

    const ls = landmarkToWorld(leftShoulder, false);
    const rs = landmarkToWorld(rightShoulder, false);
    const lh = landmarkToWorld(leftHip, false);
    const rh = landmarkToWorld(rightHip, false);
    const shoulderMid = midpoint(ls, rs);
    const hipMid = midpoint(lh, rh);
    const torsoCenter = midpoint(shoulderMid, hipMid);
    const shoulderWidth = ls.distanceTo(rs);
    const torsoHeight = shoulderMid.distanceTo(hipMid);
    if (shoulderWidth < 1e-4 || torsoHeight < 1e-4) {
      return { frame, correctedHands: 0 };
    }

    const xAxis = ls.clone().sub(rs).normalize();
    const yAxis = shoulderMid.clone().sub(hipMid).normalize();
    let zAxis = new Vector3().crossVectors(xAxis, yAxis).normalize();
    if (zAxis.lengthSq() < 1e-8) zAxis = new Vector3(0, 0, 1);
    if (zAxis.z < 0) zAxis.multiplyScalar(-1);
    const clearance = shoulderWidth * (this.opts.clearanceRatio ?? 0.08);
    const radiusX = shoulderWidth * 0.56 + clearance;
    const radiusY = torsoHeight * 0.58 + clearance;
    const radiusZ = shoulderWidth * 0.32 + clearance;
    const output = new Map(frame.landmarks.map((point) => [point.name, { ...point }]));
    let correctedHands = 0;

    for (const side of ['left', 'right'] as const) {
      if (
        this.resolveHand(
          side,
          output,
          torsoCenter,
          xAxis,
          yAxis,
          zAxis,
          radiusX,
          radiusY,
          radiusZ,
          visibility,
        )
      ) {
        correctedHands += 1;
      }
    }

    if (correctedHands === 0) return { frame, correctedHands: 0 };
    return {
      frame: {
        ...frame,
        landmarks: frame.landmarks.map(
          (point) => output.get(point.name) ?? point,
        ),
      },
      correctedHands,
    };
  }

  private resolveHand(
    side: Side,
    landmarks: Map<string, PoseLandmark>,
    torsoCenter: Vector3,
    xAxis: Vector3,
    yAxis: Vector3,
    zAxis: Vector3,
    radiusX: number,
    radiusY: number,
    radiusZ: number,
    visibilityThreshold: number,
  ): boolean {
    const wrist = landmarks.get(`${side}_wrist`);
    const elbow = landmarks.get(`${side}_elbow`);
    if (
      !wrist ||
      !elbow ||
      wrist.visibility < visibilityThreshold ||
      elbow.visibility < visibilityThreshold
    ) {
      return false;
    }
    const wristWorld = landmarkToWorld(wrist, false);
    const relative = wristWorld.clone().sub(torsoCenter);
    const local = new Vector3(
      relative.dot(xAxis),
      relative.dot(yAxis),
      relative.dot(zAxis),
    );
    const normalizedRadius = Math.sqrt(
      (local.x * local.x) / (radiusX * radiusX) +
        (local.y * local.y) / (radiusY * radiusY) +
        (local.z * local.z) / (radiusZ * radiusZ),
    );
    if (!Number.isFinite(normalizedRadius) || normalizedRadius >= 1) return false;

    const frontBias = Math.max(0.08, this.opts.frontBias ?? 0.28);
    const surfaceDirection = new Vector3(
      local.x / radiusX,
      local.y / radiusY,
      Math.max(local.z / radiusZ, frontBias),
    );
    if (surfaceDirection.lengthSq() < 1e-8) surfaceDirection.set(0, 0, 1);
    surfaceDirection.normalize();
    const surfaceLocal = new Vector3(
      surfaceDirection.x * radiusX,
      surfaceDirection.y * radiusY,
      surfaceDirection.z * radiusZ,
    );
    const target = torsoCenter
      .clone()
      .addScaledVector(xAxis, surfaceLocal.x)
      .addScaledVector(yAxis, surfaceLocal.y)
      .addScaledVector(zAxis, surfaceLocal.z);
    const elbowWorld = landmarkToWorld(elbow, false);
    const forearmLength = elbowWorld.distanceTo(wristWorld);
    const armDirection = target.clone().sub(elbowWorld);
    if (forearmLength < 1e-5 || armDirection.lengthSq() < 1e-8) return false;
    const correctedWrist = elbowWorld
      .clone()
      .add(armDirection.normalize().multiplyScalar(forearmLength));
    const delta = correctedWrist.clone().sub(wristWorld);
    landmarks.set(wrist.name, writeWorld(wrist, correctedWrist));
    for (const anchor of ['index', 'pinky', 'thumb'] as const) {
      const point = landmarks.get(`${side}_${anchor}`);
      if (!point) continue;
      landmarks.set(
        point.name,
        writeWorld(point, landmarkToWorld(point, false).add(delta)),
      );
    }
    return true;
  }
}
