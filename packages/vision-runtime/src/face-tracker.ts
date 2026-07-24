import {
  FaceLandmarker,
  FilesetResolver,
  type FaceLandmarkerResult,
} from '@mediapipe/tasks-vision';
import type { FaceFrame } from '@dhp/avatar-schema';

/**
 * 面部追踪：单脸 478 点 + 52 个 blendshape。
 *
 * Face Landmarker 的 VIDEO 模式自带单脸时序平滑；本层再限制推理帧率，
 * 与姿态、手部错峰执行，避免三个同步 WASM 推理任务争用主线程。
 */
export interface FaceTrackerOptions {
  /** wasm 目录本地路径，如 '/mediapipe/wasm'。 */
  wasmBasePath: string;
  /** 模型本地路径，默认 '/mediapipe/face_landmarker.task'。 */
  modelPath?: string;
  delegate?: 'GPU' | 'CPU';
  minFaceDetectionConfidence?: number;
  minFacePresenceConfidence?: number;
  minTrackingConfidence?: number;
  /** 推理帧率上限，默认 20。 */
  targetFps?: number;
  /** 与姿态/手部错峰的首帧延迟，默认 56ms。 */
  startDelayMs?: number;
  video: HTMLVideoElement;
  onFrame: (frame: FaceFrame) => void;
  onError?: (err: Error) => void;
}

export function faceResultToFaceFrame(
  result: FaceLandmarkerResult,
  timestampMs: number,
): FaceFrame {
  const landmarks = result.faceLandmarks?.[0] ?? [];
  const categories = result.faceBlendshapes?.[0]?.categories ?? [];
  const blendshapes: Record<string, number> = {};
  for (const category of categories) {
    if (!category.categoryName) continue;
    blendshapes[category.categoryName] = Math.min(1, Math.max(0, category.score));
  }
  const matrix = result.facialTransformationMatrixes?.[0]?.data;
  return {
    timestampMs,
    source: 'mediapipe-face',
    detected: landmarks.length > 0,
    landmarkCount: landmarks.length,
    blendshapes,
    transformationMatrix: matrix?.length === 16 ? [...matrix] : undefined,
  };
}

export class FaceTracker {
  private landmarker: FaceLandmarker | null = null;
  private rafId = 0;
  private running = false;
  private lastInferMs = 0;
  private notBeforeMs = 0;
  private lastVideoTime = -1;

  constructor(private opts: FaceTrackerOptions) {}

  async start(): Promise<void> {
    if (this.running) return;
    try {
      const vision = await FilesetResolver.forVisionTasks(this.opts.wasmBasePath);
      this.landmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: this.opts.modelPath ?? '/mediapipe/face_landmarker.task',
          delegate: this.opts.delegate ?? 'GPU',
        },
        runningMode: 'VIDEO',
        // 官方只在 numFaces=1 时启用平滑；数字人驱动也只需要主用户。
        numFaces: 1,
        minFaceDetectionConfidence: this.opts.minFaceDetectionConfidence ?? 0.6,
        minFacePresenceConfidence: this.opts.minFacePresenceConfidence ?? 0.6,
        minTrackingConfidence: this.opts.minTrackingConfidence ?? 0.6,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      });
      this.running = true;
      this.lastInferMs = 0;
      this.lastVideoTime = -1;
      this.notBeforeMs = performance.now() + (this.opts.startDelayMs ?? 56);
      this.loop();
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
    if (now < this.notBeforeMs) return;
    const interval = 1000 / (this.opts.targetFps ?? 20);
    if (now - this.lastInferMs < interval) return;
    const video = this.opts.video;
    if (!video || video.readyState < 2 || video.currentTime === this.lastVideoTime) return;
    this.lastInferMs = now;
    this.lastVideoTime = video.currentTime;
    try {
      const result = this.landmarker!.detectForVideo(video, now);
      this.opts.onFrame(faceResultToFaceFrame(result, now));
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  };

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.landmarker?.close();
    this.landmarker = null;
  }
}
