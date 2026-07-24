import { Quaternion } from 'three';
import { computePoseConfidence, type PoseFrame, type PoseTrackingMode, type StandardRigBone } from '@dhp/avatar-schema';
import type { BoneRotationMap } from './mapper.js';

/**
 * 跟踪丢失管理（文档 §10.4/§10.5）：
 * - 连续低置信度 500ms 后冻结最近可信姿态；
 * - 超过 1s 后按混合权重平滑回待机（绑定姿态 = 单位旋转）。
 */
export type TrackingStatus = 'tracking' | 'frozen' | 'blending' | 'lost';

export interface TrackingLossOptions {
  /** 帧置信度阈值，默认 0.5 */
  confidenceThreshold?: number;
  /** 低置信持续时间达到该值后进入冻结，默认 500ms */
  freezeDelayMs?: number;
  /** 低置信持续时间达到该值后开始混合回待机，默认 1000ms */
  blendStartMs?: number;
  /** 混合时长，默认 1000ms */
  blendDurationMs?: number;
  /** 追踪模式：upper 时丢失判定只看上半身关键点（腿出画不触发丢失），默认 full */
  trackingMode?: PoseTrackingMode;
}

export interface TrackingLossResult {
  status: TrackingStatus;
  /** 0 = 完全使用最近可信姿态；1 = 完全回待机。 */
  blendWeight: number;
  rotations: BoneRotationMap;
}

const IDENTITY = new Quaternion();

/** 按权重把每根骨骼旋转向单位旋转（待机）混合。 */
export function blendTowardIdle(rotations: BoneRotationMap, w: number): BoneRotationMap {
  if (w <= 0) return { ...rotations };
  const out: BoneRotationMap = {};
  for (const [bone, q] of Object.entries(rotations) as [StandardRigBone, { x: number; y: number; z: number; w: number }][]) {
    const blended = IDENTITY.clone().slerp(new Quaternion(q.x, q.y, q.z, q.w), 1 - w);
    out[bone] = { x: blended.x, y: blended.y, z: blended.z, w: blended.w };
  }
  return out;
}

export class TrackingLossManager {
  private confidenceThreshold: number;
  private freezeDelayMs: number;
  private blendStartMs: number;
  private blendDurationMs: number;
  private trackingMode: PoseTrackingMode;
  private lastGood: BoneRotationMap = {};
  private lastGoodMs: number | null = null;

  constructor(opts: TrackingLossOptions = {}) {
    this.confidenceThreshold = opts.confidenceThreshold ?? 0.5;
    this.freezeDelayMs = opts.freezeDelayMs ?? 500;
    this.blendStartMs = opts.blendStartMs ?? 1000;
    this.blendDurationMs = opts.blendDurationMs ?? 1000;
    this.trackingMode = opts.trackingMode ?? 'full';
  }

  /**
   * 每帧调用：confidence 为整帧置信度，rotations 为当帧映射结果。
   * 返回实际应输出的旋转（可能是冻结姿态或向待机混合后的结果）。
   */
  update(nowMs: number, confidence: number, rotations: BoneRotationMap): TrackingLossResult {
    if (confidence >= this.confidenceThreshold) {
      this.lastGood = rotations;
      this.lastGoodMs = nowMs;
      return { status: 'tracking', blendWeight: 0, rotations };
    }
    if (this.lastGoodMs === null) {
      // 从未有过可信帧：直接输出待机
      return { status: 'frozen', blendWeight: 1, rotations: {} };
    }
    const dt = nowMs - this.lastGoodMs;
    if (dt < this.freezeDelayMs) {
      // 短暂抖动容忍：沿用最近可信姿态
      return { status: 'tracking', blendWeight: 0, rotations: this.lastGood };
    }
    if (dt < this.blendStartMs) {
      return { status: 'frozen', blendWeight: 0, rotations: this.lastGood };
    }
    const w = Math.min(1, (dt - this.blendStartMs) / this.blendDurationMs);
    return {
      status: w >= 1 ? 'lost' : 'blending',
      blendWeight: w,
      rotations: blendTowardIdle(this.lastGood, w),
    };
  }

  /**
   * 按模式从 PoseFrame 计算置信度后走 update：
   * upper 模式只统计上半身关键点，腿不可见不会触发丢失。
   */
  updateWithFrame(nowMs: number, frame: PoseFrame, rotations: BoneRotationMap): TrackingLossResult {
    return this.update(nowMs, computePoseConfidence(frame.landmarks, this.trackingMode), rotations);
  }

  reset(): void {
    this.lastGood = {};
    this.lastGoodMs = null;
  }
}
