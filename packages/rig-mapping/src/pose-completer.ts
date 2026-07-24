import {
  computePoseConfidence,
  type PoseFrame,
  type PoseLandmark,
  type PoseTrackingMode,
} from '@dhp/avatar-schema';

export interface TemporalPoseCompleterOptions {
  /** 直接采信并更新运动状态的可见性阈值，默认 0.55。 */
  reliableVisibility?: number;
  /** 首帧建立弱状态所需的最低可见性，默认 0.2。 */
  bootstrapVisibility?: number;
  /** 最长推理缺口，默认 1200ms；更长遮挡交回 TrackingLossManager。 */
  maxGapMs?: number;
  /** 推理点的最低有效置信度，默认 0.68；接近最长缺口时使用。 */
  minInferenceConfidence?: number;
  /** 推理点置信度上限，默认 0.86；仅短缺口可达到，且与原始分数分开展示。 */
  maxInferenceConfidence?: number;
  /** 预测置信度衰减时间常数，默认 2400ms。 */
  confidenceDecayMs?: number;
  /** 视频姿态模式，默认 full。 */
  trackingMode?: PoseTrackingMode;
}

export interface PoseCompletionResult {
  frame: PoseFrame;
  /** MediaPipe 原始整帧置信度。 */
  rawConfidence: number;
  /** 检测 + 时序/骨骼推理后的整帧有效置信度。 */
  effectiveConfidence: number;
  /** 本帧由时序或骨骼约束补全的关键点名。 */
  inferredLandmarks: string[];
}

interface LandmarkState {
  landmark: PoseLandmark;
  velocity: {
    x: number;
    y: number;
    z: number;
    wx?: number;
    wy?: number;
    wz?: number;
  };
  timestampMs: number;
  confidence: number;
}

interface SegmentLengthState {
  image: number | null;
  world: number | null;
}

const KINEMATIC_SEGMENTS: ReadonlyArray<readonly [string, string]> = [
  ['left_shoulder', 'left_elbow'],
  ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'],
  ['right_elbow', 'right_wrist'],
  ['left_hip', 'left_knee'],
  ['left_knee', 'left_ankle'],
  ['right_hip', 'right_knee'],
  ['right_knee', 'right_ankle'],
];

const COORDINATE_KEYS = ['x', 'y', 'z', 'wx', 'wy', 'wz'] as const;
type CoordinateKey = (typeof COORDINATE_KEYS)[number];

function coordinate(point: PoseLandmark, key: CoordinateKey): number | undefined {
  return point[key];
}

function hasWorld(point: PoseLandmark): boolean {
  return point.wx !== undefined && point.wy !== undefined && point.wz !== undefined;
}

function distance(
  a: PoseLandmark,
  b: PoseLandmark,
  space: 'image' | 'world',
): number | null {
  const keys =
    space === 'world'
      ? (['wx', 'wy', 'wz'] as const)
      : (['x', 'y', 'z'] as const);
  const av = keys.map((key) => coordinate(a, key));
  const bv = keys.map((key) => coordinate(b, key));
  if (av.some((value) => value === undefined) || bv.some((value) => value === undefined)) {
    return null;
  }
  return Math.hypot(
    av[0]! - bv[0]!,
    av[1]! - bv[1]!,
    av[2]! - bv[2]!,
  );
}

function blendLength(previous: number | null, current: number): number {
  return previous === null ? current : previous * 0.85 + current * 0.15;
}

function clampVelocity(value: number, world: boolean): number {
  const limit = world ? 5 : 3;
  return Math.max(-limit, Math.min(limit, value));
}

function copyLandmark(point: PoseLandmark): PoseLandmark {
  return { ...point };
}

/**
 * 视频姿态补全器：
 * - 高置信帧学习每个关键点的速度与四肢段长度；
 * - 短时低置信/缺失时融合原始弱检测与阻尼速度预测；
 * - 对推理出的肘、腕、膝、踝重新施加已学习骨长，减少漂移和肢体伸缩；
 * - 保留 rawConfidence 与 inferredLandmarks，避免把推理结果冒充模型原始分数。
 */
export class TemporalPoseCompleter {
  private states = new Map<string, LandmarkState>();
  private segmentLengths = new Map<string, SegmentLengthState>();

  constructor(private readonly opts: TemporalPoseCompleterOptions = {}) {}

  apply(frame: PoseFrame): PoseCompletionResult {
    const reliable = this.opts.reliableVisibility ?? 0.55;
    const bootstrap = this.opts.bootstrapVisibility ?? 0.2;
    const maxGapMs = this.opts.maxGapMs ?? 1200;
    const minInferenceConfidence = this.opts.minInferenceConfidence ?? 0.68;
    const maxInferenceConfidence = this.opts.maxInferenceConfidence ?? 0.86;
    const confidenceDecayMs = this.opts.confidenceDecayMs ?? 2400;
    const trackingMode = this.opts.trackingMode ?? 'full';
    const rawConfidence = computePoseConfidence(frame.landmarks, trackingMode);
    const rawByName = new Map(frame.landmarks.map((landmark) => [landmark.name, landmark]));

    this.updateSegmentLengths(rawByName, reliable);

    const names = new Set([...rawByName.keys(), ...this.states.keys()]);
    const completed = new Map<string, PoseLandmark>();
    const inferred = new Set<string>();

    for (const name of names) {
      const raw = rawByName.get(name);
      const state = this.states.get(name);
      if (raw && raw.visibility >= reliable) {
        const next = copyLandmark(raw);
        completed.set(name, next);
        this.updateReliableState(next, frame.timestampMs, state);
        continue;
      }

      if (!state && raw && raw.visibility >= bootstrap) {
        const seeded = copyLandmark(raw);
        completed.set(name, seeded);
        this.states.set(name, {
          landmark: seeded,
          velocity: { x: 0, y: 0, z: 0 },
          timestampMs: frame.timestampMs,
          confidence: raw.visibility,
        });
        continue;
      }

      const gapMs = state ? Math.max(0, frame.timestampMs - state.timestampMs) : Infinity;
      const weakDetectionCanReanchor =
        !!raw && raw.visibility >= bootstrap && raw.visibility < reliable;
      if (state && (gapMs <= maxGapMs || weakDetectionCanReanchor)) {
        const predicted = this.predict(state, Math.min(gapMs, maxGapMs));
        const rawWeight = raw
          ? Math.min(0.58, 0.12 + (raw.visibility / Math.max(reliable, 1e-6)) * 0.46)
          : 0;
        const fused = raw ? this.blend(predicted, raw, rawWeight) : predicted;
        const decayed = state.confidence * Math.exp(-gapMs / confidenceDecayMs);
        fused.visibility = Math.max(
          raw?.visibility ?? 0,
          Math.min(maxInferenceConfidence, Math.max(minInferenceConfidence, decayed)),
        );
        completed.set(name, fused);
        inferred.add(name);
        if (gapMs > maxGapMs && weakDetectionCanReanchor) {
          this.states.set(name, {
            landmark: copyLandmark(fused),
            velocity: {
              x: state.velocity.x * 0.25,
              y: state.velocity.y * 0.25,
              z: state.velocity.z * 0.25,
              wx:
                state.velocity.wx === undefined ? undefined : state.velocity.wx * 0.25,
              wy:
                state.velocity.wy === undefined ? undefined : state.velocity.wy * 0.25,
              wz:
                state.velocity.wz === undefined ? undefined : state.velocity.wz * 0.25,
            },
            timestampMs: frame.timestampMs,
            confidence: Math.max(raw.visibility, minInferenceConfidence),
          });
        }
        continue;
      }

      if (raw) completed.set(name, copyLandmark(raw));
    }

    this.applyKinematicConstraints(completed, inferred);
    const landmarks = [...completed.values()];
    const effectiveConfidence = computePoseConfidence(landmarks, trackingMode);
    return {
      frame: {
        ...frame,
        confidence: effectiveConfidence,
        landmarks,
      },
      rawConfidence,
      effectiveConfidence,
      inferredLandmarks: [...inferred],
    };
  }

  reset(): void {
    this.states.clear();
    this.segmentLengths.clear();
  }

  private updateReliableState(
    landmark: PoseLandmark,
    timestampMs: number,
    previous?: LandmarkState,
  ): void {
    const dt = previous ? (timestampMs - previous.timestampMs) / 1000 : 0;
    const velocity: LandmarkState['velocity'] = { x: 0, y: 0, z: 0 };
    for (const key of COORDINATE_KEYS) {
      const value = coordinate(landmark, key);
      const old = previous ? coordinate(previous.landmark, key) : undefined;
      if (value === undefined) continue;
      const measured = dt > 1e-3 && old !== undefined ? (value - old) / dt : 0;
      const prior = previous ? coordinate(previous.velocity as PoseLandmark, key) ?? 0 : 0;
      const smoothed = prior * 0.55 + measured * 0.45;
      const next = clampVelocity(smoothed, key.startsWith('w'));
      if (key === 'x' || key === 'y' || key === 'z') velocity[key] = next;
      else velocity[key] = next;
    }
    this.states.set(landmark.name, {
      landmark: copyLandmark(landmark),
      velocity,
      timestampMs,
      confidence: landmark.visibility,
    });
  }

  private predict(state: LandmarkState, gapMs: number): PoseLandmark {
    const seconds = gapMs / 1000;
    const damping = Math.exp(-seconds * 1.25);
    const predicted = copyLandmark(state.landmark);
    for (const key of COORDINATE_KEYS) {
      const value = coordinate(state.landmark, key);
      const velocity = coordinate(state.velocity as PoseLandmark, key);
      if (value === undefined || velocity === undefined) continue;
      const next = value + velocity * seconds * damping;
      if (key === 'x' || key === 'y' || key === 'z') predicted[key] = next;
      else predicted[key] = next;
    }
    return predicted;
  }

  private blend(predicted: PoseLandmark, raw: PoseLandmark, rawWeight: number): PoseLandmark {
    const fused = copyLandmark(predicted);
    for (const key of COORDINATE_KEYS) {
      const a = coordinate(predicted, key);
      const b = coordinate(raw, key);
      if (b === undefined) continue;
      const next = a === undefined ? b : a * (1 - rawWeight) + b * rawWeight;
      if (key === 'x' || key === 'y' || key === 'z') fused[key] = next;
      else fused[key] = next;
    }
    return fused;
  }

  private updateSegmentLengths(
    raw: ReadonlyMap<string, PoseLandmark>,
    reliable: number,
  ): void {
    for (const [fromName, toName] of KINEMATIC_SEGMENTS) {
      const from = raw.get(fromName);
      const to = raw.get(toName);
      if (!from || !to || from.visibility < reliable || to.visibility < reliable) continue;
      const key = `${fromName}:${toName}`;
      const previous = this.segmentLengths.get(key) ?? { image: null, world: null };
      const image = distance(from, to, 'image');
      const world = hasWorld(from) && hasWorld(to) ? distance(from, to, 'world') : null;
      this.segmentLengths.set(key, {
        image: image === null ? previous.image : blendLength(previous.image, image),
        world: world === null ? previous.world : blendLength(previous.world, world),
      });
    }
  }

  private applyKinematicConstraints(
    landmarks: Map<string, PoseLandmark>,
    inferred: ReadonlySet<string>,
  ): void {
    for (const [fromName, toName] of KINEMATIC_SEGMENTS) {
      const from = landmarks.get(fromName);
      const to = landmarks.get(toName);
      const lengths = this.segmentLengths.get(`${fromName}:${toName}`);
      if (!from || !to || !lengths) continue;
      if (inferred.has(toName)) {
        this.constrainEndpoint(from, to, lengths);
      } else if (inferred.has(fromName)) {
        this.constrainEndpoint(to, from, lengths);
      }
    }
  }

  private constrainEndpoint(
    anchor: PoseLandmark,
    endpoint: PoseLandmark,
    lengths: SegmentLengthState,
  ): void {
    this.constrainSpace(anchor, endpoint, ['x', 'y', 'z'], lengths.image);
    this.constrainSpace(anchor, endpoint, ['wx', 'wy', 'wz'], lengths.world);
  }

  private constrainSpace(
    anchor: PoseLandmark,
    endpoint: PoseLandmark,
    keys: readonly [CoordinateKey, CoordinateKey, CoordinateKey],
    targetLength: number | null,
  ): void {
    if (targetLength === null) return;
    const a = keys.map((key) => coordinate(anchor, key));
    const b = keys.map((key) => coordinate(endpoint, key));
    if (a.some((value) => value === undefined) || b.some((value) => value === undefined)) {
      return;
    }
    const dx = b[0]! - a[0]!;
    const dy = b[1]! - a[1]!;
    const dz = b[2]! - a[2]!;
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-8) return;
    const scale = targetLength / length;
    const values = [
      a[0]! + dx * scale,
      a[1]! + dy * scale,
      a[2]! + dz * scale,
    ];
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index];
      const value = values[index];
      if (key === 'x' || key === 'y' || key === 'z') endpoint[key] = value;
      else endpoint[key] = value;
    }
  }
}
