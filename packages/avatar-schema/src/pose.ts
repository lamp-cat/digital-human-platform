import { z } from 'zod';

/**
 * PoseFrame：桌面浏览器摄像头产生的一帧人体关键点（开发文档 §10.2）。
 * V1 完全在浏览器本地处理，不上传视频或关键点。
 */

export const poseLandmarkSchema = z.object({
  name: z.string(),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  visibility: z.number().min(0).max(1).default(1),
  /**
   * 可选：MediaPipe worldLandmarks（米制、髋部中点原点、y 向上）。
   * 比图像归一化坐标的 z（相对深度、噪声大）可靠得多，
   * 存在时 rig-mapping 优先用它计算肢体方向（§10.3）。
   * 向后兼容：旧数据无此字段时回退图像坐标。
   */
  wx: z.number().optional(),
  wy: z.number().optional(),
  wz: z.number().optional(),
});
export type PoseLandmark = z.infer<typeof poseLandmarkSchema>;

export const poseFrameSchema = z.object({
  timestampMs: z.number(),
  source: z.string().default('mediapipe-pose'),
  confidence: z.number().min(0).max(1),
  landmarks: z.array(poseLandmarkSchema),
});
export type PoseFrame = z.infer<typeof poseFrameSchema>;

/** MediaPipe Pose 33 关键点中 V1 使用的子集名称。 */
export const POSE_LANDMARK_NAMES = [
  'nose',
  'left_eye_inner', 'left_eye', 'left_eye_outer',
  'right_eye_inner', 'right_eye', 'right_eye_outer',
  'left_ear', 'right_ear',
  'mouth_left', 'mouth_right',
  'left_shoulder', 'right_shoulder',
  'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist',
  'left_pinky', 'right_pinky',
  'left_index', 'right_index',
  'left_thumb', 'right_thumb',
  'left_hip', 'right_hip',
  'left_knee', 'right_knee',
  'left_ankle', 'right_ankle',
  'left_heel', 'right_heel',
  'left_foot_index', 'right_foot_index',
] as const;

/** V1 实时驱动的骨骼范围（§10.5）：骨盆、脊柱、头部、双臂、双腿。 */
export const DRIVEN_BONES = [
  'Hips', 'Spine', 'Chest', 'Neck', 'Head',
  'LeftUpperArm', 'LeftLowerArm', 'RightUpperArm', 'RightLowerArm',
  'LeftUpperLeg', 'LeftLowerLeg', 'RightUpperLeg', 'RightLowerLeg',
] as const;

/** 姿态追踪模式：全身 / 仅上半身。 */
export type PoseTrackingMode = 'full' | 'upper';

/** 上半身模式参与统计的关键点（鼻、眼、耳、嘴、肩、肘、腕、髋）。 */
export const UPPER_BODY_LANDMARK_NAMES = [
  'nose',
  'left_eye', 'right_eye',
  'left_ear', 'right_ear',
  'mouth_left', 'mouth_right',
  'left_shoulder', 'right_shoulder',
  'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist',
  'left_hip', 'right_hip',
] as const;

const UPPER_BODY_SET: ReadonlySet<string> = new Set(UPPER_BODY_LANDMARK_NAMES);

/** 判断关键点是否属于上半身集合。 */
export function isUpperBodyLandmark(name: string): boolean {
  return UPPER_BODY_SET.has(name);
}

/**
 * 按追踪模式计算整帧置信度：
 * full → 全部关键点可见性平均；upper → 仅上半身关键点平均（腿出画不拉低置信度）。
 */
export function computePoseConfidence(landmarks: PoseLandmark[], mode: PoseTrackingMode = 'full'): number {
  if (landmarks.length === 0) return 0;
  let sum = 0;
  let n = 0;
  for (const lm of landmarks) {
    if (mode === 'upper' && !UPPER_BODY_SET.has(lm.name)) continue;
    sum += lm.visibility;
    n += 1;
  }
  return n > 0 ? sum / n : 0;
}
