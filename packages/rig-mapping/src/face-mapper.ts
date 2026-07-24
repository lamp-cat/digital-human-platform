import {
  FACE_EXPRESSION_NAMES,
  type FaceExpressionName,
  type FaceExpressionWeights,
  type FaceFrame,
} from '@dhp/avatar-schema';
import { OneEuroFilter, type OneEuroFilterOptions } from './filters.js';

type ShapeMap = Record<string, number>;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const mean = (...values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * 去除用户静止脸与模型固有偏置。blendshape 接近 0 时的小噪声进入 dead zone，
 * 其余区间重新映射到 0–1，保留大表情的动态范围。
 */
function calibratedShape(
  shapes: ShapeMap,
  baseline: ShapeMap,
  name: string,
  deadZone = 0.018,
): number {
  const base = clamp01(baseline[name] ?? 0);
  const value = clamp01(shapes[name] ?? 0);
  const active = value - base - deadZone;
  return active <= 0 ? 0 : clamp01(active / Math.max(1 - base - deadZone, 0.08));
}

/**
 * MediaPipe 52 blendshape → VRM 1.0 标准表情。
 *
 * 眼动与眨眼保持左右独立；口型先拆分元音/圆唇，再计算情绪，避免单纯张嘴被
 * 误判成“惊讶”。输出只包含 0–1 权重，不依赖 Three.js，可直接回归测试。
 */
export function mapFaceBlendshapesToExpressions(
  shapes: ShapeMap,
  baseline: ShapeMap = {},
): FaceExpressionWeights {
  const s = (name: string, deadZone?: number) =>
    calibratedShape(shapes, baseline, name, deadZone);

  const blinkLeft = s('eyeBlinkLeft', 0.012);
  const blinkRight = s('eyeBlinkRight', 0.012);
  const eyeUp = mean(s('eyeLookUpLeft'), s('eyeLookUpRight'));
  const eyeDown = mean(s('eyeLookDownLeft'), s('eyeLookDownRight'));
  // 解剖学视线：向左 = 左眼向外 + 右眼向内。
  const eyeLeft = mean(s('eyeLookOutLeft'), s('eyeLookInRight'));
  const eyeRight = mean(s('eyeLookInLeft'), s('eyeLookOutRight'));

  const jawOpen = s('jawOpen', 0.025);
  const funnel = s('mouthFunnel');
  const pucker = s('mouthPucker');
  const smile = mean(s('mouthSmileLeft'), s('mouthSmileRight'));
  const frown = mean(s('mouthFrownLeft'), s('mouthFrownRight'));
  const mouthPress = mean(s('mouthPressLeft'), s('mouthPressRight'));
  const mouthStretch = mean(s('mouthStretchLeft'), s('mouthStretchRight'));
  const lowerDown = mean(s('mouthLowerDownLeft'), s('mouthLowerDownRight'));
  const cheekSquint = mean(s('cheekSquintLeft'), s('cheekSquintRight'));
  const eyeWide = mean(s('eyeWideLeft'), s('eyeWideRight'));
  const browInnerUp = s('browInnerUp');
  const browDown = mean(s('browDownLeft'), s('browDownRight'));

  // 圆唇时抑制 aa，防止同一张嘴同时触发互斥口型。
  const rounded = Math.max(funnel, pucker);
  const aa = clamp01(jawOpen * (1 - 0.78 * rounded));
  const oh = clamp01(Math.max(funnel, jawOpen * funnel * 1.15));
  const ou = clamp01(pucker);
  const ee = clamp01(mouthStretch * (1 - 0.55 * jawOpen));
  const ih = clamp01(mean(mouthStretch, lowerDown) * (1 - 0.35 * rounded));

  const happy = clamp01(smile * 1.1 + cheekSquint * 0.18);
  const angry = clamp01(browDown * 0.72 + mouthPress * 0.28);
  const sad = clamp01(frown * 0.72 + browInnerUp * 0.28);
  // 需要“张嘴 + 眼/眉上提”共同出现，普通说话不会轻易触发惊讶。
  const surpriseUpper = mean(eyeWide, browInnerUp);
  const surprised = clamp01(Math.sqrt(jawOpen * surpriseUpper) * 1.08);

  return {
    blink: mean(blinkLeft, blinkRight),
    blinkLeft,
    blinkRight,
    lookUp: eyeUp,
    lookDown: eyeDown,
    lookLeft: eyeLeft,
    lookRight: eyeRight,
    aa,
    ih,
    ee,
    oh,
    ou,
    happy,
    angry,
    sad,
    surprised,
    relaxed: 0,
  };
}

export type FaceTrackingStatus = 'calibrating' | 'tracking' | 'lost';

export interface FaceDriveResult {
  status: FaceTrackingStatus;
  calibrationProgress: number;
  expressions: FaceExpressionWeights;
}

export interface FaceDriveOptions {
  /** 中性脸采样帧数，默认 12；用中位数抵抗采样期间眨眼。 */
  calibrationFrames?: number;
  /** 认为 Face Landmarker 输出完整的最少关键点数，默认 470。 */
  minLandmarkCount?: number;
  /** 丢失后沿用最近结果的时间，默认 120ms。 */
  lostHoldMs?: number;
  /** 从最近表情平滑回到中性的时间，默认 320ms。 */
  returnDurationMs?: number;
  smoother?: OneEuroFilterOptions;
}

/**
 * 面部驱动状态机：中性脸标定 → blendshape 去偏置 → One Euro 平滑 →
 * 丢失短暂保持并渐隐。标定只采集检出完整的帧。
 */
export class FaceDriveManager {
  private calibrationFrames: number;
  private minLandmarkCount: number;
  private lostHoldMs: number;
  private returnDurationMs: number;
  private samples: ShapeMap[] = [];
  private baseline: ShapeMap | null = null;
  private filters = new Map<FaceExpressionName, OneEuroFilter>();
  private lastTimestampMs: number | null = null;
  private lastGoodMs: number | null = null;
  private lastExpressions: FaceExpressionWeights = {};

  constructor(private opts: FaceDriveOptions = {}) {
    this.calibrationFrames = opts.calibrationFrames ?? 12;
    this.minLandmarkCount = opts.minLandmarkCount ?? 470;
    this.lostHoldMs = opts.lostHoldMs ?? 120;
    this.returnDurationMs = opts.returnDurationMs ?? 320;
  }

  update(frame: FaceFrame, nowMs = frame.timestampMs): FaceDriveResult {
    const good = frame.detected && frame.landmarkCount >= this.minLandmarkCount;
    if (!this.baseline) {
      if (good) this.samples.push({ ...frame.blendshapes });
      if (this.samples.length >= this.calibrationFrames) this.finishCalibration();
      return {
        status: 'calibrating',
        calibrationProgress: Math.min(1, this.samples.length / this.calibrationFrames),
        expressions: {},
      };
    }

    if (good) {
      const mapped = mapFaceBlendshapesToExpressions(frame.blendshapes, this.baseline);
      const dt =
        this.lastTimestampMs === null
          ? 1 / 20
          : Math.max((nowMs - this.lastTimestampMs) / 1000, 1e-3);
      const smoothed: FaceExpressionWeights = {};
      for (const name of FACE_EXPRESSION_NAMES) {
        let filter = this.filters.get(name);
        if (!filter) {
          filter = new OneEuroFilter({
            minCutoff: 2.2,
            beta: 0.22,
            dCutoff: 1.0,
            ...this.opts.smoother,
          });
          this.filters.set(name, filter);
        }
        smoothed[name] = clamp01(filter.filter(mapped[name] ?? 0, dt));
      }
      this.lastTimestampMs = nowMs;
      this.lastGoodMs = nowMs;
      this.lastExpressions = smoothed;
      return { status: 'tracking', calibrationProgress: 1, expressions: smoothed };
    }

    if (this.lastGoodMs === null) {
      return { status: 'lost', calibrationProgress: 1, expressions: {} };
    }
    const elapsed = nowMs - this.lastGoodMs;
    const fade = elapsed <= this.lostHoldMs
      ? 1
      : clamp01(1 - (elapsed - this.lostHoldMs) / this.returnDurationMs);
    const expressions = Object.fromEntries(
      Object.entries(this.lastExpressions).map(([name, value]) => [name, (value ?? 0) * fade]),
    ) as FaceExpressionWeights;
    return { status: elapsed <= this.lostHoldMs ? 'tracking' : 'lost', calibrationProgress: 1, expressions };
  }

  recalibrate(): void {
    this.samples = [];
    this.baseline = null;
    this.filters.clear();
    this.lastTimestampMs = null;
    this.lastGoodMs = null;
    this.lastExpressions = {};
  }

  reset(): void {
    this.recalibrate();
  }

  private finishCalibration(): void {
    const names = new Set(this.samples.flatMap((sample) => Object.keys(sample)));
    const baseline: ShapeMap = {};
    for (const name of names) baseline[name] = median(this.samples.map((sample) => sample[name] ?? 0));
    this.baseline = baseline;
    this.filters.clear();
    this.lastTimestampMs = null;
  }
}
