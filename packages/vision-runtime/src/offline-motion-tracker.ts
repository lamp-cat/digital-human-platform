import {
  FilesetResolver,
  HandLandmarker,
  type PoseLandmarker,
} from '@mediapipe/tasks-vision';
import type {
  HandFrame,
  PoseFrame,
  PoseTrackingMode,
} from '@dhp/avatar-schema';
import {
  createPoseLandmarker,
  poseResultToPoseFrame,
  type PoseDetectorQuality,
  type PoseModelVariant,
} from './pose-landmarker.js';
import { handResultToHandFrame } from './hand-tracker.js';

export interface OfflineMotionTrackerOptions {
  wasmBasePath: string;
  poseModelPath?: string;
  poseModelVariant?: PoseModelVariant;
  handModelPath?: string;
  delegate?: 'GPU' | 'CPU';
  poseQuality?: PoseDetectorQuality;
  trackingMode?: PoseTrackingMode;
  numHands?: number;
  minHandDetectionConfidence?: number;
  minHandPresenceConfidence?: number;
  minHandTrackingConfidence?: number;
}

export interface OfflineMotionFrame {
  pose: PoseFrame;
  hands: HandFrame;
}

/**
 * 面向文件导出的确定性姿态检测器。
 *
 * 与实时追踪器不同，本类不播放 video、不使用 requestAnimationFrame，
 * 而是由调用方逐帧传入已经解码好的 canvas。机器性能只影响处理耗时，
 * 不会改变媒体时间戳、漏掉输出帧或改变导出视频长度。
 */
export class OfflineMotionTracker {
  private poseLandmarker: PoseLandmarker | null = null;
  private handLandmarker: HandLandmarker | null = null;
  private lastPoseTimestampMs = -1;
  private lastHandTimestampMs = -1;
  private disposed = false;

  constructor(private readonly opts: OfflineMotionTrackerOptions) {}

  async load(): Promise<void> {
    if (this.disposed) throw new Error('离线动作检测器已释放');
    if (!this.poseLandmarker) {
      this.poseLandmarker = await createPoseLandmarker({
        wasmBasePath: this.opts.wasmBasePath,
        modelPath: this.opts.poseModelPath,
        modelVariant: this.opts.poseModelVariant ?? 'heavy',
        delegate: this.opts.delegate ?? 'GPU',
        quality: this.opts.poseQuality,
      });
    }
    if (!this.handLandmarker) {
      const vision = await FilesetResolver.forVisionTasks(this.opts.wasmBasePath);
      this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            this.opts.handModelPath ?? '/mediapipe/hand_landmarker.task',
          delegate: this.opts.delegate ?? 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: this.opts.numHands ?? 2,
        minHandDetectionConfidence:
          this.opts.minHandDetectionConfidence ?? 0.55,
        minHandPresenceConfidence:
          this.opts.minHandPresenceConfidence ?? 0.5,
        minTrackingConfidence:
          this.opts.minHandTrackingConfidence ?? 0.6,
      });
    }
  }

  detect(source: TexImageSource, mediaTimestampMs: number): OfflineMotionFrame {
    if (this.disposed || !this.poseLandmarker || !this.handLandmarker) {
      throw new Error('离线动作检测器尚未加载');
    }
    const frameTimestampMs = Math.max(0, Math.round(mediaTimestampMs));
    const poseDetectorTimestamp = Math.max(
      frameTimestampMs,
      this.lastPoseTimestampMs + 1,
    );
    const handDetectorTimestamp = Math.max(
      frameTimestampMs,
      this.lastHandTimestampMs + 1,
    );
    this.lastPoseTimestampMs = poseDetectorTimestamp;
    this.lastHandTimestampMs = handDetectorTimestamp;

    const poseResult = this.poseLandmarker.detectForVideo(
      source,
      poseDetectorTimestamp,
    );
    const handResult = this.handLandmarker.detectForVideo(
      source,
      handDetectorTimestamp,
    );
    return {
      pose: poseResultToPoseFrame(
        poseResult,
        frameTimestampMs,
        this.opts.trackingMode ?? 'full',
      ),
      hands: handResultToHandFrame(handResult, frameTimestampMs),
    };
  }

  close(): void {
    this.disposed = true;
    this.poseLandmarker?.close();
    this.handLandmarker?.close();
    this.poseLandmarker = null;
    this.handLandmarker = null;
  }
}
