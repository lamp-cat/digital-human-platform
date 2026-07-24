import type { HandFrame, PoseFrame } from '@dhp/avatar-schema';

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
