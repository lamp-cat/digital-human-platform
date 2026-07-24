import { z } from 'zod';

/**
 * AvatarProfile：用户数字人的核心可编辑数据（开发文档 §6.5）。
 * 字段版本化，schemaVersion 用于将来迁移。
 */

export const PROFILE_SCHEMA_VERSION = '1.0' as const;

/** 附录 A：首批脸型参数（BlendShape 驱动），取值范围统一 [-1, 1]。 */
export const MORPH_PARAM_DEFS = [
  { key: 'faceWidth', label: '脸宽', category: 'face' },
  { key: 'faceLength', label: '脸长', category: 'face' },
  { key: 'jawWidth', label: '下颌宽度', category: 'face' },
  { key: 'chinLength', label: '下巴长度', category: 'face' },
  { key: 'eyeSize', label: '眼睛大小', category: 'eye' },
  { key: 'eyeSpacing', label: '眼间距', category: 'eye' },
  { key: 'eyeHeight', label: '眼睛高度', category: 'eye' },
  { key: 'noseWidth', label: '鼻宽', category: 'noseMouth' },
  { key: 'noseHeight', label: '鼻高', category: 'noseMouth' },
  { key: 'mouthWidth', label: '嘴宽', category: 'noseMouth' },
  { key: 'lipFullness', label: '唇部丰满度', category: 'noseMouth' },
] as const;

export type MorphParamKey = (typeof MORPH_PARAM_DEFS)[number]['key'];
export const MORPH_PARAM_KEYS = MORPH_PARAM_DEFS.map((d) => d.key) as MorphParamKey[];

/** 附录 A：体型参数（骨骼链缩放 + 补偿），带允许范围。 */
export const BONE_SCALE_PARAM_DEFS = [
  { key: 'height', label: '身高', min: 0.9, max: 1.1 },
  { key: 'shoulderWidth', label: '肩宽', min: 0.9, max: 1.12 },
  { key: 'torsoLength', label: '躯干长度', min: 0.92, max: 1.08 },
  { key: 'legLength', label: '腿长', min: 0.9, max: 1.1 },
] as const;

export type BoneScaleParamKey = (typeof BONE_SCALE_PARAM_DEFS)[number]['key'];
export const BONE_SCALE_PARAM_KEYS = BONE_SCALE_PARAM_DEFS.map((d) => d.key) as BoneScaleParamKey[];

export function boneScaleRange(key: BoneScaleParamKey): { min: number; max: number } {
  const def = BONE_SCALE_PARAM_DEFS.find((d) => d.key === key)!;
  return { min: def.min, max: def.max };
}

/** 可控色板：肤色 / 眼睛颜色（§6.4：肤色以色板/参数控制，避免每次生成新贴图）。 */
export const SKIN_TONES = [
  { id: 'light-01', label: '白皙', color: '#f5d7c4' },
  { id: 'light-02', label: '浅肤', color: '#eec8ae' },
  { id: 'warm-03', label: '自然暖', color: '#ddb294' },
  { id: 'tan-04', label: '小麦', color: '#c99773' },
  { id: 'brown-05', label: '深棕', color: '#a9765b' },
  { id: 'dark-06', label: '深肤', color: '#7d523d' },
] as const;

export const EYE_COLORS = [
  { id: 'brown-02', label: '棕色', color: '#5b3a24' },
  { id: 'black-01', label: '黑色', color: '#1d1a17' },
  { id: 'blue-03', label: '蓝色', color: '#3d6b9a' },
  { id: 'green-04', label: '绿色', color: '#4a7a52' },
  { id: 'gray-05', label: '灰色', color: '#7a8288' },
] as const;

const morphsSchema = z.object(
  Object.fromEntries(
    MORPH_PARAM_KEYS.map((k) => [k, z.number().min(-1).max(1).optional()]),
  ) as Record<MorphParamKey, z.ZodOptional<z.ZodNumber>>,
);

const boneScalesSchema = z.object(
  Object.fromEntries(
    BONE_SCALE_PARAM_KEYS.map((k) => [k, z.number().min(0.85).max(1.15).optional()]),
  ) as Record<BoneScaleParamKey, z.ZodOptional<z.ZodNumber>>,
);

export const traitsSchema = z.object({
  hair: z.string().nullable().default(null),
  top: z.string().nullable().default(null),
  bottom: z.string().nullable().default(null),
  shoes: z.string().nullable().default(null),
  accessories: z.array(z.string()).default([]),
});
export type Traits = z.infer<typeof traitsSchema>;

export const assetSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('built_in') }),
  z.object({
    type: z.literal('catalog'),
    assetId: z.string().min(1),
    compatibility: z.literal('POSE_ONLY'),
  }),
  z.object({
    type: z.literal('imported'),
    importId: z.string(),
    compatibility: z.enum(['FULL', 'POSE_ONLY']),
  }),
]);
export type AssetSource = z.infer<typeof assetSourceSchema>;

export const avatarProfileSchema = z.object({
  schemaVersion: z.literal(PROFILE_SCHEMA_VERSION),
  baseAvatarId: z.string().min(1),
  assetSource: assetSourceSchema.default({ type: 'built_in' }),
  morphs: morphsSchema.default({}),
  boneScales: boneScalesSchema.default({}),
  materials: z
    .object({
      skinToneId: z.string().default('warm-03'),
      skinRoughness: z.number().min(0).max(1).default(0.52),
      eyeColorId: z.string().default('brown-02'),
    })
    .default({ skinToneId: 'warm-03', skinRoughness: 0.52, eyeColorId: 'brown-02' }),
  traits: traitsSchema.default({ hair: null, top: null, bottom: null, shoes: null, accessories: [] }),
  pose: z
    .object({
      mode: z.enum(['idle', 'preset', 'camera']).default('idle'),
      animationId: z.string().nullable().default('idle-01'),
    })
    .default({ mode: 'idle', animationId: 'idle-01' }),
});

export type AvatarProfile = z.infer<typeof avatarProfileSchema>;

export const BUILT_IN_BASE_AVATAR_ID = 'base-adult-v1';

export function createDefaultProfile(baseAvatarId: string = BUILT_IN_BASE_AVATAR_ID): AvatarProfile {
  return avatarProfileSchema.parse({
    schemaVersion: PROFILE_SCHEMA_VERSION,
    baseAvatarId,
    morphs: Object.fromEntries(MORPH_PARAM_KEYS.map((k) => [k, 0])),
    boneScales: { height: 1.0, shoulderWidth: 1.0, torsoLength: 1.0, legLength: 1.0 },
  });
}

export function validateProfile(data: unknown):
  | { success: true; profile: AvatarProfile }
  | { success: false; errors: string[] } {
  const result = avatarProfileSchema.safeParse(data);
  if (result.success) return { success: true, profile: result.data };
  return {
    success: false,
    errors: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  };
}
