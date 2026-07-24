import type { HandData, HandFrame, PoseFrame } from '@dhp/avatar-schema';

/**
 * One Euro Filter：关键点平滑（低延迟 + 抑制抖动）。
 * 参考 Casiez et al. 2012：速度自适应截止频率。
 */
export interface OneEuroFilterOptions {
  /** 最小截止频率 Hz（越小越平滑），默认 1.0 */
  minCutoff?: number;
  /** 速度系数（越大低速度下越跟手），默认 0.02 */
  beta?: number;
  /** 速度信号的截止频率 Hz，默认 1.0 */
  dCutoff?: number;
}

export class OneEuroFilter {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;
  private xPrev: number | null = null;
  private dxPrev = 0;

  constructor(opts: OneEuroFilterOptions = {}) {
    this.minCutoff = opts.minCutoff ?? 1.0;
    this.beta = opts.beta ?? 0.02;
    this.dCutoff = opts.dCutoff ?? 1.0;
  }

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x: number, dt: number): number {
    if (!(dt > 0)) dt = 1 / 60;
    if (this.xPrev === null) {
      this.xPrev = x;
      this.dxPrev = 0;
      return x;
    }
    const dx = (x - this.xPrev) / dt;
    const aD = OneEuroFilter.alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = OneEuroFilter.alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    return xHat;
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
  }
}

/** 对 PoseFrame 的每个关键点做 x/y/z（有 world 坐标时含 wx/wy/wz）One Euro 滤波。 */
export class LandmarkSmoother {
  private filters = new Map<
    string,
    { x: OneEuroFilter; y: OneEuroFilter; z: OneEuroFilter; wx: OneEuroFilter; wy: OneEuroFilter; wz: OneEuroFilter }
  >();
  private lastTimestampMs: number | null = null;

  constructor(private opts: OneEuroFilterOptions = {}) {}

  apply(frame: PoseFrame): PoseFrame {
    const dt =
      this.lastTimestampMs === null
        ? 1 / 30
        : Math.max((frame.timestampMs - this.lastTimestampMs) / 1000, 1e-3);
    this.lastTimestampMs = frame.timestampMs;

    const landmarks = frame.landmarks.map((lm) => {
      let f = this.filters.get(lm.name);
      if (!f) {
        f = {
          x: new OneEuroFilter(this.opts),
          y: new OneEuroFilter(this.opts),
          z: new OneEuroFilter(this.opts),
          wx: new OneEuroFilter(this.opts),
          wy: new OneEuroFilter(this.opts),
          wz: new OneEuroFilter(this.opts),
        };
        this.filters.set(lm.name, f);
      }
      const out = {
        ...lm,
        x: f.x.filter(lm.x, dt),
        y: f.y.filter(lm.y, dt),
        z: f.z.filter(lm.z, dt),
      };
      // worldLandmarks 同步滤波（mapper 优先使用，不滤波会把抖动带进骨骼）
      if (lm.wx !== undefined) out.wx = f.wx.filter(lm.wx, dt);
      if (lm.wy !== undefined) out.wy = f.wy.filter(lm.wy, dt);
      if (lm.wz !== undefined) out.wz = f.wz.filter(lm.wz, dt);
      return out;
    });
    return { ...frame, landmarks };
  }

  reset(): void {
    this.filters.clear();
    this.lastTimestampMs = null;
  }
}

/** 对 HandFrame 的每只手每个关键点做 x/y/z（有 world 坐标时含 wx/wy/wz）One Euro 滤波。 */
export class HandFrameSmoother {
  private filters = new Map<
    string,
    { x: OneEuroFilter; y: OneEuroFilter; z: OneEuroFilter; wx: OneEuroFilter; wy: OneEuroFilter; wz: OneEuroFilter }
  >();
  private lastTimestampMs: number | null = null;

  constructor(private opts: OneEuroFilterOptions = {}) {}

  apply(frame: HandFrame): HandFrame {
    const dt =
      this.lastTimestampMs === null
        ? 1 / 18
        : Math.max((frame.timestampMs - this.lastTimestampMs) / 1000, 1e-3);
    this.lastTimestampMs = frame.timestampMs;

    const hands = frame.hands.map((hand) => {
      const landmarks = hand.landmarks.map((lm) => {
        const key = `${hand.handedness}:${lm.name}`;
        let f = this.filters.get(key);
        if (!f) {
          f = {
            x: new OneEuroFilter(this.opts),
            y: new OneEuroFilter(this.opts),
            z: new OneEuroFilter(this.opts),
            wx: new OneEuroFilter(this.opts),
            wy: new OneEuroFilter(this.opts),
            wz: new OneEuroFilter(this.opts),
          };
          this.filters.set(key, f);
        }
        const out = {
          ...lm,
          x: f.x.filter(lm.x, dt),
          y: f.y.filter(lm.y, dt),
          z: f.z.filter(lm.z, dt),
        };
        // worldLandmarks 同步滤波（手指角度对深度噪声敏感）
        if (lm.wx !== undefined) out.wx = f.wx.filter(lm.wx, dt);
        if (lm.wy !== undefined) out.wy = f.wy.filter(lm.wy, dt);
        if (lm.wz !== undefined) out.wz = f.wz.filter(lm.wz, dt);
        return out;
      });
      return { ...hand, landmarks };
    });
    return { ...frame, hands };
  }

  reset(): void {
    this.filters.clear();
    this.lastTimestampMs = null;
  }
}

export interface HandFrameStabilizerOptions {
  /** 新手进入追踪的置信度，默认 0.6。 */
  enterConfidence?: number;
  /** 已追踪手继续保留的置信度，默认 0.45（迟滞，减少闪断）。 */
  exitConfidence?: number;
  /** 连续缺失多少帧后忘记该手的空间身份，默认 5。 */
  forgetAfterFrames?: number;
  /** 左右标签与时序位置冲突时的标签惩罚，默认 0.22。 */
  labelMismatchPenalty?: number;
}

type HandSide = 'left' | 'right';

function wristOf(hand: HandData): { x: number; y: number } | null {
  const wrist = hand.landmarks.find((lm) => lm.name === 'wrist');
  return wrist ? { x: wrist.x, y: wrist.y } : null;
}

function pointDistance(
  a: { x: number; y: number } | null,
  b: { x: number; y: number } | null,
): number {
  if (!a || !b) return 0.16;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 双手时序身份稳定器。
 *
 * Hand Landmarker 的单帧 handedness 在交叉、遮挡或手背朝向镜头时可能跳变；
 * 本类用手腕轨迹做二分配，并对进入/退出置信度使用迟滞。输出 handedness
 * 仍是解剖学语义，可直接交给 HandFrameSmoother 和 hand-mapper。
 */
export class HandFrameStabilizer {
  private previous: Record<HandSide, { wrist: { x: number; y: number } | null; missing: number } | null> = {
    left: null,
    right: null,
  };

  constructor(private opts: HandFrameStabilizerOptions = {}) {}

  apply(frame: HandFrame): HandFrame {
    const enter = this.opts.enterConfidence ?? 0.6;
    const exit = this.opts.exitConfidence ?? 0.45;
    const forgetAfter = this.opts.forgetAfterFrames ?? 5;
    const mismatch = this.opts.labelMismatchPenalty ?? 0.22;
    const candidates = frame.hands
      .filter((hand) => hand.landmarks.length > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);

    // 至多两只手，穷举“保持标签 / 交换标签”并选择时序代价更小的一组。
    const assignments: { hands: HandData[]; cost: number }[] = [];
    if (candidates.length === 1) {
      for (const side of ['left', 'right'] as HandSide[]) {
        const hand = candidates[0];
        const state = this.previous[side];
        const threshold = state ? exit : enter;
        if (hand.score < threshold) continue;
        assignments.push({
          hands: [{ ...hand, handedness: side }],
          cost:
            pointDistance(wristOf(hand), state?.wrist ?? null) +
            (hand.handedness === side ? 0 : mismatch * (0.5 + hand.score)),
        });
      }
    } else if (candidates.length === 2) {
      const permutations: [HandSide, HandSide][] = [['left', 'right'], ['right', 'left']];
      for (const sides of permutations) {
        let cost = 0;
        const hands: HandData[] = [];
        let valid = true;
        for (let i = 0; i < 2; i++) {
          const hand = candidates[i];
          const side = sides[i];
          const state = this.previous[side];
          if (hand.score < (state ? exit : enter)) {
            valid = false;
            break;
          }
          cost +=
            pointDistance(wristOf(hand), state?.wrist ?? null) +
            (hand.handedness === side ? 0 : mismatch * (0.5 + hand.score));
          hands.push({ ...hand, handedness: side });
        }
        if (valid) assignments.push({ hands, cost });
      }
    }

    const selected = assignments.sort((a, b) => a.cost - b.cost)[0]?.hands ?? [];
    for (const side of ['left', 'right'] as HandSide[]) {
      const hand = selected.find((candidate) => candidate.handedness === side);
      if (hand) {
        this.previous[side] = { wrist: wristOf(hand), missing: 0 };
      } else if (this.previous[side]) {
        this.previous[side]!.missing += 1;
        if (this.previous[side]!.missing > forgetAfter) this.previous[side] = null;
      }
    }
    return { ...frame, hands: selected };
  }

  reset(): void {
    this.previous = { left: null, right: null };
  }
}
