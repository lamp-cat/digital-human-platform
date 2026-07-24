import { z } from 'zod';
import type { StandardRigBone } from './rig.js';

/**
 * 手部动捕：MediaPipe Hand Landmarker 21 关键点、HandFrame 帧格式、
 * 以及 VRM 风格的手指扩展骨骼（不属于 22 根最小骨架，导入人物可选支持）。
 */

/** MediaPipe Hand Landmarker 21 关键点名称（与官方输出顺序一致）。 */
export const HAND_LANDMARK_NAMES = [
  'wrist',
  'thumb_cmc', 'thumb_mcp', 'thumb_ip', 'thumb_tip',
  'index_finger_mcp', 'index_finger_pip', 'index_finger_dip', 'index_finger_tip',
  'middle_finger_mcp', 'middle_finger_pip', 'middle_finger_dip', 'middle_finger_tip',
  'ring_finger_mcp', 'ring_finger_pip', 'ring_finger_dip', 'ring_finger_tip',
  'pinky_mcp', 'pinky_pip', 'pinky_dip', 'pinky_tip',
] as const;

export type HandLandmarkName = (typeof HAND_LANDMARK_NAMES)[number];

/** 单个手部关键点（结构与 PoseLandmark 一致；wx/wy/wz 为米制 worldLandmarks）。 */
export const handLandmarkSchema = z.object({
  name: z.string(),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  visibility: z.number().min(0).max(1).default(1),
  wx: z.number().optional(),
  wy: z.number().optional(),
  wz: z.number().optional(),
});
export type HandLandmark = z.infer<typeof handLandmarkSchema>;

/** 一只手的检出结果。handedness 一律为解剖学语义（归一化见 vision-runtime hand-tracker）。 */
export const handDataSchema = z.object({
  handedness: z.enum(['left', 'right']),
  score: z.number().min(0).max(1),
  landmarks: z.array(handLandmarkSchema),
});
export type HandData = z.infer<typeof handDataSchema>;

/** HandFrame：一帧双手检出（风格与 PoseFrame 一致，world 坐标可选向后兼容）。 */
export const handFrameSchema = z.object({
  timestampMs: z.number(),
  source: z.string().default('mediapipe-hand'),
  hands: z.array(handDataSchema),
});
export type HandFrame = z.infer<typeof handFrameSchema>;

/* ---------------------------------------------------------------------------
 * 手指扩展骨骼（VRM 命名，每指 Proximal/Intermediate/Distal 三节 × 双手）。
 * 不属于 22 根最小骨架；仅导入人物（VRM）可能具备，内置程序化底模不具备。
 * 排列顺序即驱动写入顺序（Hand 之后，同指近节→远节，父先子后）。
 * ------------------------------------------------------------------------- */
export const FINGER_EXTENSION_BONES = [
  'LeftThumbProximal', 'LeftThumbIntermediate', 'LeftThumbDistal',
  'LeftIndexProximal', 'LeftIndexIntermediate', 'LeftIndexDistal',
  'LeftMiddleProximal', 'LeftMiddleIntermediate', 'LeftMiddleDistal',
  'LeftRingProximal', 'LeftRingIntermediate', 'LeftRingDistal',
  'LeftLittleProximal', 'LeftLittleIntermediate', 'LeftLittleDistal',
  'RightThumbProximal', 'RightThumbIntermediate', 'RightThumbDistal',
  'RightIndexProximal', 'RightIndexIntermediate', 'RightIndexDistal',
  'RightMiddleProximal', 'RightMiddleIntermediate', 'RightMiddleDistal',
  'RightRingProximal', 'RightRingIntermediate', 'RightRingDistal',
  'RightLittleProximal', 'RightLittleIntermediate', 'RightLittleDistal',
] as const;

export type FingerBone = (typeof FINGER_EXTENSION_BONES)[number];

/** 可被驱动的全部骨骼：22 根最小骨架 + 可选手指扩展。 */
export type ExtendedRigBone = StandardRigBone | FingerBone;

/** VRM humanoid 手指骨骼名 → 扩展骨骼显式映射（VRM 用小指 Little 命名）。 */
export const VRM_FINGER_TO_RIG: Record<string, FingerBone> = {
  leftThumbProximal: 'LeftThumbProximal',
  leftThumbIntermediate: 'LeftThumbIntermediate',
  leftThumbDistal: 'LeftThumbDistal',
  leftIndexProximal: 'LeftIndexProximal',
  leftIndexIntermediate: 'LeftIndexIntermediate',
  leftIndexDistal: 'LeftIndexDistal',
  leftMiddleProximal: 'LeftMiddleProximal',
  leftMiddleIntermediate: 'LeftMiddleIntermediate',
  leftMiddleDistal: 'LeftMiddleDistal',
  leftRingProximal: 'LeftRingProximal',
  leftRingIntermediate: 'LeftRingIntermediate',
  leftRingDistal: 'LeftRingDistal',
  leftLittleProximal: 'LeftLittleProximal',
  leftLittleIntermediate: 'LeftLittleIntermediate',
  leftLittleDistal: 'LeftLittleDistal',
  rightThumbProximal: 'RightThumbProximal',
  rightThumbIntermediate: 'RightThumbIntermediate',
  rightThumbDistal: 'RightThumbDistal',
  rightIndexProximal: 'RightIndexProximal',
  rightIndexIntermediate: 'RightIndexIntermediate',
  rightIndexDistal: 'RightIndexDistal',
  rightMiddleProximal: 'RightMiddleProximal',
  rightMiddleIntermediate: 'RightMiddleIntermediate',
  rightMiddleDistal: 'RightMiddleDistal',
  rightRingProximal: 'RightRingProximal',
  rightRingIntermediate: 'RightRingIntermediate',
  rightRingDistal: 'RightRingDistal',
  rightLittleProximal: 'RightLittleProximal',
  rightLittleIntermediate: 'RightLittleIntermediate',
  rightLittleDistal: 'RightLittleDistal',
};

/**
 * VRM 1.0 把拇指三节命名为 Metacarpal / Proximal / Distal；
 * VRM 0.x 则使用 Proximal / Intermediate / Distal。分版本映射可防止
 * 拇指少一节或把近节驱动写到错误节点。
 */
export const VRM1_FINGER_TO_RIG: Record<string, FingerBone> = {
  ...VRM_FINGER_TO_RIG,
  leftThumbMetacarpal: 'LeftThumbProximal',
  leftThumbProximal: 'LeftThumbIntermediate',
  rightThumbMetacarpal: 'RightThumbProximal',
  rightThumbProximal: 'RightThumbIntermediate',
};
