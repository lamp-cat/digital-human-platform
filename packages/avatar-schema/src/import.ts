import { z } from 'zod';
import { BODY_SECTIONS, RIG_VERSION, STANDARD_RIG_BONES } from './rig.js';
import { MORPH_PARAM_KEYS } from './profile.js';

/**
 * 外部 3D 人物导入：Import Manifest 与兼容等级（开发文档 §8）。
 */

export const importManifestSchema = z.object({
  schemaVersion: z.literal('1.0'),
  assetType: z.literal('imported-avatar'),
  displayName: z.string().min(1).max(64),
  rigVersion: z.literal(RIG_VERSION),
  /** 键：StandardRig 骨骼名；值：GLB 中实际骨骼名。 */
  rigMap: z.record(z.enum(STANDARD_RIG_BONES as unknown as [string, ...string[]]), z.string()),
  bindPose: z.enum(['A_POSE', 'T_POSE']),
  bodySections: z.array(z.enum(BODY_SECTIONS)).default([]),
  editableProfile: z
    .object({
      morphs: z.array(z.enum(MORPH_PARAM_KEYS as [string, ...string[]])).default([]),
      materials: z.array(z.enum(['skinToneId', 'skinRoughness', 'eyeColorId'])).default([]),
    })
    .default({ morphs: [], materials: [] }),
  compatibleGarments: z.array(z.string()).default([]),
  license: z.object({
    source: z.string().min(1),
    licenseId: z.string().min(1),
  }),
});

export type ImportManifest = z.infer<typeof importManifestSchema>;

export const COMPATIBILITY_LEVELS = ['FULL', 'POSE_ONLY', 'REJECTED'] as const;
export type CompatibilityLevel = (typeof COMPATIBILITY_LEVELS)[number];

/** §8.3 导入状态机。 */
export const IMPORT_STATES = [
  'selected',
  'uploading',
  'uploaded',
  'validating',
  'accepted_full',
  'accepted_pose_only',
  'rejected',
  'activated',
  'archived',
] as const;
export type ImportState = (typeof IMPORT_STATES)[number];

/** §8.2 上传规则（默认值，可由管理员配置）。 */
export const IMPORT_LIMITS = {
  maxBytes: 100 * 1024 * 1024,
  maxTrianglesRecommended: 80_000,
  maxTrianglesHard: 120_000,
  maxTextureSize: 4096,
  allowedExtensions: ['.vrm', '.glb'],
} as const;
