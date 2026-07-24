import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import type { PoseFrame, PoseTrackingMode } from '@dhp/avatar-schema';
import {
  createPoseLandmarker,
  poseResultToPoseFrame,
  type PoseDetectorQuality,
  type PoseModelVariant,
} from './pose-landmarker.js';

/**
 * 摄像头姿态追踪：getUserMedia + MediaPipe PoseLandmarker（VIDEO 模式）。
 * 推理在自己的 rAF 循环里跑（15–30 FPS），与渲染循环解耦。
 * 模型与 wasm 均来自本地路径（比赛离线要求）。
 */
export interface CameraPoseTrackerOptions {
  /** wasm 目录本地路径，如 '/mediapipe/wasm' */
  wasmBasePath: string;
  /** 模型本地路径（优先于 modelVariant），如 '/mediapipe/pose_landmarker_full.task' */
  modelPath?: string;
  /** 模型档位：'full'=流畅（默认）；'heavy'=精准（桌面 Chrome 可实时） */
  modelVariant?: PoseModelVariant;
  /** 推理 delegate，默认 'GPU' */
  delegate?: 'GPU' | 'CPU';
  /** 检测器质量参数（置信度阈值 0.5 档 / 推理帧率） */
  quality?: PoseDetectorQuality;
  onFrame: (frame: PoseFrame) => void;
  onError?: (err: Error) => void;
  /** 推理帧率上限，默认 30（quality.targetFps 优先） */
  targetFps?: number;
  /** 复用外部 video 元素（否则内部创建） */
  video?: HTMLVideoElement;
  /** 追踪模式：full=全身（置信度取全部关键点平均）；upper=仅上半身（腿出画不拉低置信度），默认 full */
  trackingMode?: PoseTrackingMode;
}

export class CameraPoseTracker {
  private opts: CameraPoseTrackerOptions;
  private landmarker: PoseLandmarker | null = null;
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private rafId = 0;
  private running = false;
  private lastInferMs = 0;
  private lastVideoTime = -1;

  constructor(opts: CameraPoseTrackerOptions) {
    this.opts = opts;
  }

  /** 打开摄像头并加载模型，返回实际使用的 video 元素（供预览）。 */
  async start(): Promise<HTMLVideoElement> {
    if (this.running) return this.video!;
    try {
      const [stream, landmarker] = await Promise.all([
        navigator.mediaDevices.getUserMedia({
          video: { width: 1280, height: 720 },
          audio: false,
        }),
        createPoseLandmarker(this.opts),
      ]);
      this.stream = stream;
      this.landmarker = landmarker;

      const video = this.opts.video ?? document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      this.video = video;

      this.running = true;
      this.lastInferMs = 0;
      this.lastVideoTime = -1;
      this.loop();
      return video;
    } catch (err) {
      this.stop();
      const e = err instanceof Error ? err : new Error(String(err));
      this.opts.onError?.(e);
      throw e;
    }
  }

  private loop = (): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);
    const now = performance.now();
    const interval = 1000 / (this.opts.quality?.targetFps ?? this.opts.targetFps ?? 30);
    if (now - this.lastInferMs < interval) return;
    const video = this.video;
    if (!video || video.readyState < 2 || video.currentTime === this.lastVideoTime) return;
    this.lastInferMs = now;
    this.lastVideoTime = video.currentTime;

    try {
      const result = this.landmarker!.detectForVideo(video, now);
      this.opts.onFrame(poseResultToPoseFrame(result, now, this.opts.trackingMode ?? 'full'));
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  };

  /** 停止推理、释放摄像头与模型。 */
  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.landmarker) {
      this.landmarker.close();
      this.landmarker = null;
    }
  }
}
