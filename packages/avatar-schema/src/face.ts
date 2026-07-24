import { z } from 'zod';

/**
 * 面部动捕帧：MediaPipe Face Landmarker 输出 478 个面部关键点与
 * 52 个 ARKit 风格 blendshape。本平台只跨包传递渲染所需的 blendshape
 * 与可选头部变换矩阵，避免在主线程长期保留高密度关键点数组。
 */

export const FACE_EXPRESSION_NAMES = [
  'blink',
  'blinkLeft',
  'blinkRight',
  'lookUp',
  'lookDown',
  'lookLeft',
  'lookRight',
  'aa',
  'ih',
  'ee',
  'oh',
  'ou',
  'happy',
  'angry',
  'sad',
  'surprised',
  'relaxed',
] as const;

export type FaceExpressionName = (typeof FACE_EXPRESSION_NAMES)[number];
export type FaceExpressionWeights = Partial<Record<FaceExpressionName, number>>;

export const faceFrameSchema = z.object({
  timestampMs: z.number(),
  source: z.string().default('mediapipe-face'),
  detected: z.boolean(),
  landmarkCount: z.number().int().nonnegative(),
  blendshapes: z.record(z.string(), z.number().min(0).max(1)),
  /** MediaPipe 4×4 canonical-face → detected-face 变换矩阵。 */
  transformationMatrix: z.array(z.number()).length(16).optional(),
});

export type FaceFrame = z.infer<typeof faceFrameSchema>;
