import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision';
import { HAND_LANDMARK_NAMES, type HandData, type HandFrame, type HandLandmark } from '@dhp/avatar-schema';

/**
 * 手部追踪：MediaPipe Hand Landmarker（21 关键点 × 双手），
 * 与 CameraPoseTracker 共用同一视频元素与本地 wasm（完全离线）。
 * 推理在自己的 rAF 循环里跑（默认 18Hz），可用 startDelayMs 与姿态推理错峰。
 */

export interface HandTrackerOptions {
  /** wasm 目录本地路径，如 '/mediapipe/wasm' */
  wasmBasePath: string;
  /** 模型本地路径，默认 '/mediapipe/hand_landmarker.task' */
  modelPath?: string;
  /** 推理 delegate，默认 'GPU' */
  delegate?: 'GPU' | 'CPU';
  /** 同时检出的手数量，默认 2 */
  numHands?: number;
  minHandDetectionConfidence?: number;
  minHandPresenceConfidence?: number;
  minTrackingConfidence?: number;
  /** 推理帧率上限，默认 24（兼顾手指快速动作与主线程负载） */
  targetFps?: number;
  /** 首帧推理延迟（ms），用于与姿态推理错峰，默认 28 */
  startDelayMs?: number;
  /** 与姿态追踪共用的视频元素（必须已在播放） */
  video: HTMLVideoElement;
  onFrame: (frame: HandFrame) => void;
  onError?: (err: Error) => void;
}

/**
 * MediaPipe HandLandmarker 结果 → HandFrame。
 *
 * handedness 语义转换（关键）：
 * 官方文档（developers.google.com/mediapipe/solutions/vision/hand_landmarker）：
 * “Handedness is determined assuming the input image is mirrored, i.e., taken
 *  with a front-facing/selfie camera with images flipped horizontally.
 *  If it is not the case, please swap the handedness output.”
 * 本平台输入是 getUserMedia 的原始（未水平翻转）前置画面，因此必须交换标签：
 * 模型输出 'Left' 实为解剖学右手，'Right' 实为解剖学左手。
 * 转换后 HandFrame.handedness 一律为解剖学语义（mirror=false：用户右手 → 数字人右手）。
 */
export function handResultToHandFrame(result: HandLandmarkerResult, timestampMs: number): HandFrame {
  const hands: HandData[] = [];
  const landmarkSets = result.landmarks ?? [];
  for (let i = 0; i < landmarkSets.length; i++) {
    const landmarks = landmarkSets[i];
    if (!landmarks || landmarks.length === 0) continue;
    const world = result.worldLandmarks?.[i];
    const category = result.handedness?.[i]?.[0];
    const rawLabel = category?.categoryName ?? 'Left';
    // 未镜像前置画面 → 交换（见上方注释依据）
    const handedness: 'left' | 'right' = rawLabel === 'Left' ? 'right' : 'left';
    const score = category?.score ?? 0;
    const out: HandLandmark[] = [];
    for (let j = 0; j < landmarks.length && j < HAND_LANDMARK_NAMES.length; j++) {
      const lm = landmarks[j];
      const w = world?.[j];
      const plm: HandLandmark = {
        name: HAND_LANDMARK_NAMES[j],
        x: lm.x,
        y: lm.y,
        z: lm.z,
        visibility: 1, // 手部关键点无逐点 visibility，按 1 处理
      };
      if (w) {
        plm.wx = w.x;
        plm.wy = w.y;
        plm.wz = w.z;
      }
      out.push(plm);
    }
    hands.push({ handedness, score, landmarks: out });
  }
  return { timestampMs, source: 'mediapipe-hand', hands };
}

export class HandTracker {
  private opts: HandTrackerOptions;
  private landmarker: HandLandmarker | null = null;
  private rafId = 0;
  private running = false;
  private lastInferMs = 0;
  private notBeforeMs = 0;
  private lastVideoTime = -1;

  constructor(opts: HandTrackerOptions) {
    this.opts = opts;
  }

  /** 加载模型并启动推理循环（不触碰摄像头，复用外部视频元素）。 */
  async start(): Promise<void> {
    if (this.running) return;
    try {
      const vision = await FilesetResolver.forVisionTasks(this.opts.wasmBasePath);
      this.landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: this.opts.modelPath ?? '/mediapipe/hand_landmarker.task',
          delegate: this.opts.delegate ?? 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: this.opts.numHands ?? 2,
        minHandDetectionConfidence: this.opts.minHandDetectionConfidence ?? 0.6,
        minHandPresenceConfidence: this.opts.minHandPresenceConfidence ?? 0.55,
        // 更高 IoU 阈值会在快速移动/遮挡后更早重新触发掌检测，减少漂移。
        minTrackingConfidence: this.opts.minTrackingConfidence ?? 0.6,
      });
      this.running = true;
      this.lastInferMs = 0;
      this.lastVideoTime = -1;
      this.notBeforeMs = performance.now() + (this.opts.startDelayMs ?? 28);
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
    if (now < this.notBeforeMs) return; // 与姿态推理错峰
    const interval = 1000 / (this.opts.targetFps ?? 24);
    if (now - this.lastInferMs < interval) return;
    const video = this.opts.video;
    if (!video || video.readyState < 2 || video.currentTime === this.lastVideoTime) return;
    this.lastInferMs = now;
    this.lastVideoTime = video.currentTime;

    try {
      const result = this.landmarker!.detectForVideo(video, now);
      this.opts.onFrame(handResultToHandFrame(result, now));
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  };

  /** 停止推理并释放模型（不关闭共享的视频流）。 */
  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (this.landmarker) {
      this.landmarker.close();
      this.landmarker = null;
    }
  }
}
