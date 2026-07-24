import { FilesetResolver, PoseLandmarker, type PoseLandmarkerResult } from '@mediapipe/tasks-vision';
import { POSE_LANDMARK_NAMES, computePoseConfidence, type PoseFrame, type PoseLandmark, type PoseTrackingMode } from '@dhp/avatar-schema';

/**
 * PoseLandmarker 共享创建与帧转换（摄像头与视频文件两条链路共用，保证同一 wasm/模型/输出格式）。
 */

/** 模型档位：full=流畅（约 9MB）；heavy=精准（约 29MB，桌面 Chrome 可实时）。 */
export type PoseModelVariant = 'full' | 'heavy';

/** 检测器质量参数（0.5 档置信度阈值 + 推理帧率）。 */
export interface PoseDetectorQuality {
  /** 推理帧率上限（15–30），默认 30 */
  targetFps?: number;
  minPoseDetectionConfidence?: number;
  minPosePresenceConfidence?: number;
  minTrackingConfidence?: number;
}

export interface CreatePoseLandmarkerOptions {
  /** wasm 目录本地路径，如 '/mediapipe/wasm' */
  wasmBasePath: string;
  /** 模型本地路径（优先于 modelVariant） */
  modelPath?: string;
  /** 模型档位，默认 'full'；modelPath 缺省时解析为 /mediapipe/pose_landmarker_${variant}.task */
  modelVariant?: PoseModelVariant;
  /** 推理 delegate，默认 'GPU'（headless / 无 GPU 环境用 'CPU'） */
  delegate?: 'GPU' | 'CPU';
  quality?: PoseDetectorQuality;
}

export function resolveModelPath(opts: Pick<CreatePoseLandmarkerOptions, 'modelPath' | 'modelVariant'>): string {
  if (opts.modelPath) return opts.modelPath;
  return `/mediapipe/pose_landmarker_${opts.modelVariant ?? 'full'}.task`;
}

export async function createPoseLandmarker(opts: CreatePoseLandmarkerOptions): Promise<PoseLandmarker> {
  const vision = await FilesetResolver.forVisionTasks(opts.wasmBasePath);
  const q = opts.quality ?? {};
  return PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: resolveModelPath(opts),
      delegate: opts.delegate ?? 'GPU',
    },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: q.minPoseDetectionConfidence ?? 0.5,
    minPosePresenceConfidence: q.minPosePresenceConfidence ?? 0.5,
    minTrackingConfidence: q.minTrackingConfidence ?? 0.5,
  });
}

/**
 * MediaPipe 33 点 → PoseFrame（命名按 POSE_LANDMARK_NAMES / MediaPipe 顺序）。
 * 同时携带 worldLandmarks（wx/wy/wz，米制、髋部原点）：比图像 z 可靠，
 * rig-mapping 存在时优先使用。
 */
export function poseResultToPoseFrame(
  result: PoseLandmarkerResult,
  timestampMs: number,
  trackingMode: PoseTrackingMode,
): PoseFrame {
  const landmarks = result.landmarks?.[0] ?? null;
  const world = result.worldLandmarks?.[0] ?? null;
  if (!landmarks || landmarks.length === 0) {
    return { timestampMs, source: 'mediapipe-pose', confidence: 0, landmarks: [] };
  }
  const out: PoseLandmark[] = [];
  for (let i = 0; i < landmarks.length && i < POSE_LANDMARK_NAMES.length; i++) {
    const lm = landmarks[i];
    const w = world?.[i];
    const plm: PoseLandmark = {
      name: POSE_LANDMARK_NAMES[i],
      x: lm.x,
      y: lm.y,
      z: lm.z,
      visibility: lm.visibility ?? 1,
    };
    if (w) {
      plm.wx = w.x;
      plm.wy = w.y;
      plm.wz = w.z;
    }
    out.push(plm);
  }
  return {
    timestampMs,
    source: 'mediapipe-pose',
    confidence: computePoseConfidence(out, trackingMode),
    landmarks: out,
  };
}
