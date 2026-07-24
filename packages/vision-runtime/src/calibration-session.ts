import type { PoseFrame, PoseTrackingMode } from '@dhp/avatar-schema';
import { calibrate, type CalibrationData } from '@dhp/rig-mapping';

/**
 * 校准会话：引导用户保持 A/T Pose 约 2.5s，
 * 按追踪模式检测入镜完整性（full=肩/髋/踝；upper=鼻/肩/肘/腕/髋）并给出光照/居中提示，
 * 成功后输出 CalibrationData（交给 rig-mapping 的姿态映射）。
 */
export type CalibrationStatus = 'idle' | 'collecting' | 'success' | 'failed';

export interface CalibrationSessionState {
  status: CalibrationStatus;
  /** 0–1 采样进度 */
  progress: number;
  /** 给用户的提示（入镜 / 光照 / 保持姿势）。 */
  feedback: string[];
  /** 关键部位可见性概览（展示用）。 */
  visibilitySummary: Record<string, number>;
}

export interface CalibrationSessionOptions {
  /** 采样窗口，默认 2500ms */
  durationMs?: number;
  /** 关键点可见性阈值，默认 0.5 */
  visibilityThreshold?: number;
  /**
   * 真镜像模式：x 翻转并交换左右关键点（用户右手驱动角色左手，画面同侧）。
   * 平台默认解剖学对应（mirror=false，用户右手驱动数字人右手），
   * 预览的镜像只是 video 的 CSS 显示，不需要在此处校正。
   */
  mirror?: boolean;
  /** 最少帧数，防止窗口内只有零星几帧，默认 15 */
  minFrames?: number;
  /** 追踪模式：full=全身入镜；upper=仅上半身入镜（踝膝不要求），默认 full */
  trackingMode?: PoseTrackingMode;
}

const FULL_BODY_LANDMARKS = [
  ['left_shoulder', '左肩'],
  ['right_shoulder', '右肩'],
  ['left_hip', '左髋'],
  ['right_hip', '右髋'],
  ['left_ankle', '左踝'],
  ['right_ankle', '右踝'],
] as const;

const UPPER_BODY_LANDMARKS = [
  ['nose', '鼻'],
  ['left_shoulder', '左肩'],
  ['right_shoulder', '右肩'],
  ['left_elbow', '左肘'],
  ['right_elbow', '右肘'],
  ['left_wrist', '左腕'],
  ['right_wrist', '右腕'],
  ['left_hip', '左髋'],
  ['right_hip', '右髋'],
] as const;

/** 各模式的入镜提示语。 */
const FRAMING_HINT: Record<PoseTrackingMode, string> = {
  full: '请后退至全身入镜（头、手、脚都在画面中）并居中',
  upper: '上半身入镜，肩、肘、手腕保持在画面中',
};

export class CalibrationSession {
  private opts: Required<CalibrationSessionOptions>;
  private frames: PoseFrame[] = [];
  private startMs: number | null = null;
  private status: CalibrationStatus = 'idle';
  private result: CalibrationData | null = null;
  private feedback: string[] = [];
  private visibilitySummary: Record<string, number> = {};

  constructor(opts: CalibrationSessionOptions = {}) {
    this.opts = {
      durationMs: opts.durationMs ?? 2500,
      visibilityThreshold: opts.visibilityThreshold ?? 0.5,
      mirror: opts.mirror ?? false,
      minFrames: opts.minFrames ?? 15,
      trackingMode: opts.trackingMode ?? 'full',
    };
  }

  /** 当前模式要求可见的关键点清单。 */
  private requiredLandmarks(): readonly (readonly [string, string])[] {
    return this.opts.trackingMode === 'upper' ? UPPER_BODY_LANDMARKS : FULL_BODY_LANDMARKS;
  }

  /** 开始/重新开始采样。 */
  begin(): void {
    this.frames = [];
    this.startMs = null;
    this.status = 'collecting';
    this.result = null;
    this.feedback = [];
    this.visibilitySummary = {};
  }

  /** 每帧喂入（建议喂平滑后的帧）。 */
  addFrame(frame: PoseFrame): CalibrationSessionState {
    if (this.status !== 'collecting') return this.getState();
    if (this.startMs === null) this.startMs = frame.timestampMs;
    const elapsed = frame.timestampMs - this.startMs;

    this.frames.push(frame);
    this.updateFeedback(frame);

    if (elapsed >= this.opts.durationMs) {
      this.finish();
    }
    return this.getState();
  }

  private updateFeedback(frame: PoseFrame): void {
    const feedback: string[] = [];
    const summary: Record<string, number> = {};
    const threshold = this.opts.visibilityThreshold;

    if (frame.confidence < threshold || frame.landmarks.length === 0) {
      feedback.push('未检测到人体，请站入画面中央');
      feedback.push('请检查光照：正面均匀光，避免逆光');
    } else {
      const byName = new Map(frame.landmarks.map((lm) => [lm.name, lm.visibility]));
      const missing: string[] = [];
      for (const [name, label] of this.requiredLandmarks()) {
        const v = byName.get(name) ?? 0;
        summary[label] = v;
        if (v <= threshold) missing.push(label);
      }
      if (missing.length > 0) {
        feedback.push(
          this.opts.trackingMode === 'upper'
            ? `上半身未完整入镜：${[...new Set(missing)].join('、')} 不可见，${FRAMING_HINT.upper}`
            : `人体未完整入镜：${[...new Set(missing)].join('、')} 不可见，${FRAMING_HINT.full}`,
        );
      } else if (frame.confidence < 0.7) {
        feedback.push('关键点置信度偏低，请改善光照并保持不动');
      } else {
        feedback.push('姿态良好，请保持不动…');
      }
    }
    this.feedback = feedback;
    this.visibilitySummary = summary;
  }

  private finish(): void {
    // 用窗口内的帧做完整性检查
    const enough = this.frames.length >= this.opts.minFrames;
    const last = this.frames[this.frames.length - 1];
    const required = this.requiredLandmarks();
    const complete =
      last &&
      required.every(
        ([name]) => (last.landmarks.find((lm) => lm.name === name)?.visibility ?? 0) > this.opts.visibilityThreshold,
      );
    if (!enough || !complete) {
      this.status = 'failed';
      this.feedback = enough
        ? [`校准失败：${this.opts.trackingMode === 'upper' ? '上半身' : '人体'}未完整入镜，请调整后重试`]
        : ['校准失败：有效帧太少，请检查摄像头与光照后重试'];
      return;
    }
    try {
      this.result = calibrate(this.frames, {
        mirror: this.opts.mirror,
        visibilityThreshold: this.opts.visibilityThreshold,
      });
      this.status = 'success';
      this.feedback = ['校准成功'];
    } catch (err) {
      this.status = 'failed';
      this.feedback = [err instanceof Error ? err.message : '校准失败，请重试'];
    }
  }

  getState(): CalibrationSessionState {
    const progress =
      this.status === 'success'
        ? 1
        : this.startMs === null || this.frames.length === 0
          ? 0
          : Math.min(
              1,
              (this.frames[this.frames.length - 1].timestampMs - this.startMs) / this.opts.durationMs,
            );
    return {
      status: this.status,
      progress,
      feedback: this.feedback,
      visibilitySummary: this.visibilitySummary,
    };
  }

  /** 校准成功后取结果（供 mapPoseFrameToBoneRotations 使用）。 */
  getResult(): CalibrationData | null {
    return this.result;
  }

  reset(): void {
    this.frames = [];
    this.startMs = null;
    this.status = 'idle';
    this.result = null;
    this.feedback = [];
    this.visibilitySummary = {};
  }
}
