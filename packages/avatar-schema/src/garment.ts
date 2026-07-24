import { z } from 'zod';
import { BODY_SECTIONS, RIG_VERSION } from './rig.js';
import { BONE_SCALE_PARAM_KEYS, boneScaleRange, type BoneScaleParamKey, type Traits } from './profile.js';

/**
 * 服装/配件 Trait 与 GarmentPackage 清单（开发文档 §7）。
 */

/** §7.2 槽位。 */
export const SLOTS = [
  'hair',
  'inner',
  'top',
  'bottom',
  'footwear',
  'headwear',
  'eyewear',
  'neck',
  'hand',
] as const;
export type Slot = (typeof SLOTS)[number];

/** 槽位 → AvatarProfile.traits 字段映射。 */
export const SLOT_TO_TRAIT_KEY: Record<Slot, keyof Traits> = {
  hair: 'hair',
  inner: 'top',
  top: 'top',
  bottom: 'bottom',
  footwear: 'shoes',
  headwear: 'accessories',
  eyewear: 'accessories',
  neck: 'accessories',
  hand: 'accessories',
};

export const garmentManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  version: z.string().min(1),
  displayName: z.string().min(1),
  type: z.enum(['garment', 'hair', 'accessory', 'shoes']),
  category: z.enum(SLOTS),
  slots: z.array(z.enum(SLOTS)).min(1),
  layer: z.number().int().min(0).max(100).default(10),
  rigVersion: z.literal(RIG_VERSION),
  compatibleBaseAvatars: z.array(z.string()).min(1),
  shapeConstraints: z
    .record(
      z.enum(BONE_SCALE_PARAM_KEYS as [string, ...string[]]),
      z.tuple([z.number(), z.number()]),
    )
    .default({}),
  bodyMask: z.array(z.enum(BODY_SECTIONS)).default([]),
  replacesSlots: z.array(z.enum(SLOTS)).default([]),
  restrictsTraits: z.record(z.enum(SLOTS), z.array(z.string())).default({}),
  assets: z.object({
    model: z.string(),
    thumbnail: z.string().optional(),
  }),
  license: z.object({
    source: z.string(),
    licenseId: z.string(),
  }),
});

export type GarmentManifest = z.infer<typeof garmentManifestSchema>;

export type WearResult =
  | { success: true; traits: Traits; bodyMask: string[] }
  | {
      success: false;
      reasonCode:
        | 'TRAIT_NOT_FOUND'
        | 'BASE_AVATAR_INCOMPATIBLE'
        | 'RIG_VERSION_MISMATCH'
        | 'SHAPE_OUT_OF_RANGE'
        | 'SLOT_CONFLICT'
        | 'IMPORTED_AVATAR_RESTRICTED';
      conflictingTraits: string[];
      suggestedActions: string[];
      message: string;
    };

/**
 * 换装事务的纯校验部分（§7.4）：校验底模、Rig、体型范围，计算冲突槽位。
 * 不执行加载；调用方负责预加载成功后再提交状态。
 */
export function checkWearable(
  manifest: GarmentManifest,
  opts: {
    baseAvatarId: string;
    boneScales: Partial<Record<BoneScaleParamKey, number>>;
    currentTraits: Traits;
    knownGarments: Map<string, GarmentManifest>;
    /** 导入人物 manifest 声明的 compatibleGarments；null 表示内置底模不限制 */
    importCompatibleGarments: string[] | null;
    importedCompatibility?: 'FULL' | 'POSE_ONLY' | null;
  },
): WearResult {
  const { baseAvatarId, boneScales, currentTraits, knownGarments, importCompatibleGarments, importedCompatibility } = opts;

  if (importedCompatibility === 'POSE_ONLY') {
    return {
      success: false,
      reasonCode: 'IMPORTED_AVATAR_RESTRICTED',
      conflictingTraits: [],
      suggestedActions: ['该导入人物仅支持动作控制，不支持 V1 通用换装'],
      message: 'POSE_ONLY 导入人物不支持平台通用换装',
    };
  }
  if (importedCompatibility === 'FULL' && importCompatibleGarments && !importCompatibleGarments.includes(manifest.id)) {
    return {
      success: false,
      reasonCode: 'IMPORTED_AVATAR_RESTRICTED',
      conflictingTraits: [],
      suggestedActions: ['请选择该导入人物清单中声明兼容的衣物'],
      message: `衣物 ${manifest.displayName} 未在该导入人物的兼容清单中`,
    };
  }
  if (!manifest.compatibleBaseAvatars.includes(baseAvatarId)) {
    return {
      success: false,
      reasonCode: 'BASE_AVATAR_INCOMPATIBLE',
      conflictingTraits: [],
      suggestedActions: ['查看衣物兼容的底模版本'],
      message: `衣物 ${manifest.displayName} 不兼容当前底模`,
    };
  }
  for (const [param, [min, max]] of Object.entries(manifest.shapeConstraints)) {
    const value = boneScales[param as BoneScaleParamKey] ?? 1.0;
    if (value < min || value > max) {
      const range = boneScaleRange(param as BoneScaleParamKey);
      return {
        success: false,
        reasonCode: 'SHAPE_OUT_OF_RANGE',
        conflictingTraits: [],
        suggestedActions: [`将 ${param} 调整到 ${min}–${max} 范围内（当前 ${value.toFixed(2)}）`],
        message: `当前体型参数 ${param}=${value.toFixed(2)} 超出衣物支持范围 ${min}–${max}（允许范围 ${range.min}–${range.max}）`,
      };
    }
  }

  // 计算替换与冲突
  const next: Traits = {
    hair: currentTraits.hair ?? null,
    top: currentTraits.top ?? null,
    bottom: currentTraits.bottom ?? null,
    shoes: currentTraits.shoes ?? null,
    accessories: [...(currentTraits.accessories ?? [])],
  };
  const conflicting: string[] = [];
  const removedIds = new Set<string>();

  const removeTrait = (id: string | null) => {
    if (!id) return;
    removedIds.add(id);
    if (next.hair === id) next.hair = null;
    if (next.top === id) next.top = null;
    if (next.bottom === id) next.bottom = null;
    if (next.shoes === id) next.shoes = null;
    next.accessories = next.accessories.filter((a) => a !== id);
  };

  // replacesSlots：卸下占用这些槽位的现有 Trait
  for (const slot of manifest.replacesSlots) {
    const key = SLOT_TO_TRAIT_KEY[slot];
    if (key === 'accessories') {
      for (const id of next.accessories) {
        const g = knownGarments.get(id);
        if (g && g.slots.includes(slot)) removeTrait(id);
      }
    } else {
      removeTrait(next[key]);
    }
  }

  // 主槽位唯一：同槽位已有 Trait 被替换
  for (const slot of manifest.slots) {
    const key = SLOT_TO_TRAIT_KEY[slot];
    if (key === 'accessories') {
      // 配件槽：同一槽位只允许一个
      for (const id of next.accessories) {
        const g = knownGarments.get(id);
        if (g && g.slots.some((s) => manifest.slots.includes(s))) removeTrait(id);
      }
    } else {
      const existing = next[key];
      if (existing && existing !== manifest.id) {
        conflicting.push(existing);
        removeTrait(existing);
      }
    }
  }

  // restrictsTraits：声明的互斥（支持通配，如 "helmet-*"）
  for (const [slot, patterns] of Object.entries(manifest.restrictsTraits)) {
    const key = SLOT_TO_TRAIT_KEY[slot as Slot];
    const matches = (id: string) =>
      patterns.some((p) => (p.endsWith('*') ? id.startsWith(p.slice(0, -1)) : id === p));
    if (key === 'accessories') {
      for (const id of [...next.accessories]) if (matches(id)) removeTrait(id);
    } else {
      const id = next[key];
      if (id && matches(id)) removeTrait(id);
    }
  }

  // 穿戴本体
  const primaryKey = SLOT_TO_TRAIT_KEY[manifest.slots[0]];
  if (primaryKey === 'accessories') {
    if (!next.accessories.includes(manifest.id)) next.accessories.push(manifest.id);
  } else {
    next[primaryKey] = manifest.id;
  }

  const bodyMaskSet = new Set<string>();
  const collect = (id: string | null) => {
    if (!id) return;
    const g = knownGarments.get(id);
    if (g) g.bodyMask.forEach((s) => bodyMaskSet.add(s));
  };
  collect(next.hair);
  collect(next.top);
  collect(next.bottom);
  collect(next.shoes);
  next.accessories.forEach(collect);

  void conflicting;
  return { success: true, traits: next, bodyMask: [...bodyMaskSet] };
}

/** 卸下某个 Trait。 */
export function removeTraitFrom(traits: Traits, garmentId: string): Traits {
  const next: Traits = {
    hair: traits.hair === garmentId ? null : traits.hair ?? null,
    top: traits.top === garmentId ? null : traits.top ?? null,
    bottom: traits.bottom === garmentId ? null : traits.bottom ?? null,
    shoes: traits.shoes === garmentId ? null : traits.shoes ?? null,
    accessories: (traits.accessories ?? []).filter((a) => a !== garmentId),
  };
  return next;
}

/** 汇总当前穿搭的 BodyMask。 */
export function computeBodyMask(traits: Traits, knownGarments: Map<string, GarmentManifest>): string[] {
  const set = new Set<string>();
  const ids = [traits.hair, traits.top, traits.bottom, traits.shoes, ...(traits.accessories ?? [])];
  for (const id of ids) {
    if (!id) continue;
    const g = knownGarments.get(id);
    if (g) g.bodyMask.forEach((s) => set.add(s));
  }
  return [...set];
}
