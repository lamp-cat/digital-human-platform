import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import type { PoseFrame, PoseTrackingMode } from '@dhp/avatar-schema';
import {
  createPoseLandmarker,
  poseResultToPoseFrame,
  type PoseDetectorQuality,
  type PoseModelVariant,
} from './pose-landmarker.js';

/**
 * 视频文件姿态追踪：与 CameraPoseTracker 完全相同的 PoseLandmarker
 * detectForVideo 管线（同 wasm/模型/输出格式），但视频源是 HTMLVideoElement
 * 播放的本地文件——用于离线视频分析（/pose-lab）与回归数据采集。
 */
export interface VideoFilePoseTrackerOptions {
  /** wasm 目录本地路径，如 '/mediapipe/wasm' */
  wasmBasePath: string;
  /** 模型本地路径（优先于 modelVariant） */
  modelPath?: string;
  /** 模型档位，默认 'full' */
  modelVariant?: PoseModelVariant;
  /** 推理 delegate，默认 'GPU'（headless Chrome 建议 'CPU'） */
  delegate?: 'GPU' | 'CPU';
  /** 检测器质量参数 */
  quality?: PoseDetectorQuality;
  /** 已设置 src 的 video 元素 */
  video: HTMLVideoElement;
  /** 追踪模式，默认 full */
  trackingMode?: PoseTrackingMode;
  /** 推理异常回调。 */
  onError?: (err: Error) => void;
}

export class VideoFilePoseTracker {
  private opts: VideoFilePoseTrackerOptions;
  private landmarker: PoseLandmarker | null = null;
  private rafId = 0;
  private running = false;
  private lastInferMs = 0;
  private lastVideoTime = -1;
  private lastDetectorTimestampMs = -1;
  private disposed = false;

  constructor(opts: VideoFilePoseTrackerOptions) {
    this.opts = opts;
  }

  /** 加载模型（start/sampleTimes 前调用一次）。 */
  async load(): Promise<void> {
    if (this.disposed) throw new Error('视频姿态追踪器已停止');
    if (!this.landmarker) {
      this.landmarker = await createPoseLandmarker(this.opts);
    }
  }

  /**
   * 实时播放模式：play() 视频并用与摄像头相同的 rAF 节流循环产出 PoseFrame。
   */
  async start(onFrame: (frame: PoseFrame) => void): Promise<void> {
    if (this.running) return;
    await this.load();
    const video = this.opts.video;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    this.running = true;
    this.lastInferMs = 0;
    this.lastVideoTime = -1;

    const loop = (): void => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(loop);
      const now = performance.now();
      const interval = 1000 / (this.opts.quality?.targetFps ?? 30);
      if (now - this.lastInferMs < interval) return;
      if (video.readyState < 2 || video.currentTime === this.lastVideoTime) return;
      this.lastInferMs = now;
      this.lastVideoTime = video.currentTime;
      try {
        // MediaPipe 要求检测时间戳严格单调；PoseFrame 则使用媒体时间，
        // 这样暂停、回放和导出时滤波/丢失回退都与视频进度一致。
        const detectorTimestampMs = this.nextDetectorTimestamp(now);
        const frameTimestampMs = Math.round(video.currentTime * 1000);
        const result = this.landmarker!.detectForVideo(video, detectorTimestampMs);
        onFrame(
          poseResultToPoseFrame(result, frameTimestampMs, this.opts.trackingMode ?? 'full'),
        );
      } catch (err) {
        this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    };
    this.rafId = requestAnimationFrame(loop);
  }

  /**
   * 确定性离线采样：按给定时间点逐点 seek + 检测（视频不播放）。
   * 时间戳用视频时间（秒→毫秒），保证 detectForVideo 时间戳单调。
   */
  async sampleTimes(
    timesSec: number[],
    onFrame: (frame: PoseFrame, tSec: number) => void,
  ): Promise<void> {
    await this.load();
    const video = this.opts.video;
    video.muted = true;
    video.pause();
    if (video.readyState < 1) {
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error('视频加载失败'));
      });
    }
    for (const t of timesSec) {
      if (this.disposed) break;
      const boundedTime = Math.min(Math.max(0, t), Math.max(0, video.duration || t));
      // headless Chrome 对 H.264 seek 偶发不触发 seeked：超时重试一次，再超时则跳过该点
      let ok =
        video.readyState >= 2 &&
        Math.abs(video.currentTime - boundedTime) <= 1 / 240;
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        ok = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 15000);
          video.onseeked = () => {
            clearTimeout(timer);
            resolve(true);
          };
          video.currentTime = boundedTime;
        });
      }
      if (!ok) {
        console.warn(`[VideoFilePoseTracker] seek 超时，跳过 t=${boundedTime}s`);
        continue;
      }
      if (this.disposed || !this.landmarker) break;
      const frameTimestampMs = Math.round(boundedTime * 1000);
      const detectorTimestampMs = this.nextDetectorTimestamp(frameTimestampMs);
      const result = this.landmarker!.detectForVideo(video, detectorTimestampMs);
      onFrame(
        poseResultToPoseFrame(
          result,
          frameTimestampMs,
          this.opts.trackingMode ?? 'full',
        ),
        boundedTime,
      );
    }
  }

  private nextDetectorTimestamp(preferredMs: number): number {
    const next = Math.max(Math.round(preferredMs), this.lastDetectorTimestampMs + 1);
    this.lastDetectorTimestampMs = next;
    return next;
  }

  /** 停止推理并释放模型（不释放视频元素）。 */
  stop(): void {
    this.disposed = true;
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (this.landmarker) {
      this.landmarker.close();
      this.landmarker = null;
    }
  }
}
