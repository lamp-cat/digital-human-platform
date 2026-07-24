import { describe, expect, it } from 'vitest';
import {
  checkWearable,
  computeBodyMask,
  computePoseConfidence,
  createDefaultProfile,
  garmentManifestSchema,
  removeTraitFrom,
  validateProfile,
  type GarmentManifest,
} from '../src/index.js';

const hoodie: GarmentManifest = garmentManifestSchema.parse({
  id: 'top-hoodie-01',
  version: '1.0.0',
  displayName: '基础连帽卫衣',
  type: 'garment',
  category: 'top',
  slots: ['top'],
  layer: 20,
  rigVersion: 'standard-rig-1',
  compatibleBaseAvatars: ['base-adult-v1'],
  shapeConstraints: { shoulderWidth: [0.9, 1.12], torsoLength: [0.92, 1.08] },
  bodyMask: ['body_torso'],
  replacesSlots: [],
  restrictsTraits: {},
  assets: { model: 'model.glb' },
  license: { source: 'self-created', licenseId: 'project-owned' },
});

const tee: GarmentManifest = { ...hoodie, id: 'top-tee-01', displayName: 'T 恤' };

const baseOpts = {
  baseAvatarId: 'base-adult-v1',
  boneScales: { shoulderWidth: 1.0, torsoLength: 1.0 },
  knownGarments: new Map([
    [hoodie.id, hoodie],
    [tee.id, tee],
  ]),
  importCompatibleGarments: null,
};

describe('AvatarProfile', () => {
  it('默认 Profile 通过校验', () => {
    const p = createDefaultProfile();
    const r = validateProfile(p);
    expect(r.success).toBe(true);
  });

  it('拒绝超范围 morph 参数', () => {
    const p = { ...createDefaultProfile(), morphs: { faceWidth: 2 } };
    const r = validateProfile(p);
    expect(r.success).toBe(false);
  });

  it('接受经过目录校验的开源人物来源', () => {
    const p = {
      ...createDefaultProfile('catalog-chibi-dog'),
      assetSource: {
        type: 'catalog' as const,
        assetId: 'chibi-dog',
        compatibility: 'POSE_ONLY' as const,
      },
    };
    const r = validateProfile(p);
    expect(r.success).toBe(true);
    if (r.success) expect(r.profile.assetSource.type).toBe('catalog');
  });
});

describe('换装事务', () => {
  it('穿上兼容衣物并计算 BodyMask', () => {
    const r = checkWearable(hoodie, { ...baseOpts, currentTraits: createDefaultProfile().traits });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.traits.top).toBe('top-hoodie-01');
      expect(r.bodyMask).toContain('body_torso');
    }
  });

  it('同槽位替换：卫衣替换 T 恤', () => {
    const first = checkWearable(tee, { ...baseOpts, currentTraits: createDefaultProfile().traits });
    expect(first.success).toBe(true);
    if (!first.success) return;
    const second = checkWearable(hoodie, { ...baseOpts, currentTraits: first.traits });
    expect(second.success).toBe(true);
    if (second.success) {
      expect(second.traits.top).toBe('top-hoodie-01');
    }
  });

  it('体型超出范围时拒绝穿戴并给出建议', () => {
    const r = checkWearable(hoodie, {
      ...baseOpts,
      boneScales: { shoulderWidth: 1.5 },
      currentTraits: createDefaultProfile().traits,
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.reasonCode).toBe('SHAPE_OUT_OF_RANGE');
  });

  it('POSE_ONLY 导入人物禁止换装', () => {
    const r = checkWearable(hoodie, {
      ...baseOpts,
      currentTraits: createDefaultProfile().traits,
      importedCompatibility: 'POSE_ONLY',
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.reasonCode).toBe('IMPORTED_AVATAR_RESTRICTED');
  });

  it('FULL 导入人物只能穿 compatibleGarments 交集内衣物', () => {
    const r = checkWearable(hoodie, {
      ...baseOpts,
      baseAvatarId: 'imported-xyz',
      currentTraits: createDefaultProfile().traits,
      importedCompatibility: 'FULL',
      importCompatibleGarments: ['top-tee-01'],
    });
    expect(r.success).toBe(false);
  });

  it('卸下 Trait 后 BodyMask 消失', () => {
    const worn = checkWearable(hoodie, { ...baseOpts, currentTraits: createDefaultProfile().traits });
    if (!worn.success) throw new Error('wear failed');
    const removed = removeTraitFrom(worn.traits, hoodie.id);
    expect(removed.top).toBeNull();
    expect(computeBodyMask(removed, baseOpts.knownGarments)).toHaveLength(0);
  });
});

describe('computePoseConfidence（姿态追踪模式）', () => {
  const landmarks = [
    { name: 'nose', x: 0.5, y: 0.2, z: 0, visibility: 0.9 },
    { name: 'left_shoulder', x: 0.6, y: 0.3, z: 0, visibility: 0.9 },
    { name: 'right_shoulder', x: 0.4, y: 0.3, z: 0, visibility: 0.9 },
    { name: 'left_knee', x: 0.55, y: 0.7, z: 0, visibility: 0 },
    { name: 'right_knee', x: 0.45, y: 0.7, z: 0, visibility: 0 },
    { name: 'left_ankle', x: 0.56, y: 0.9, z: 0, visibility: 0 },
    { name: 'right_ankle', x: 0.44, y: 0.9, z: 0, visibility: 0 },
  ];

  it('upper 模式只统计上半身关键点，腿出画不拉低置信度', () => {
    expect(computePoseConfidence(landmarks, 'upper')).toBeCloseTo(0.9);
  });

  it('full 模式统计全部关键点', () => {
    expect(computePoseConfidence(landmarks, 'full')).toBeCloseTo((0.9 * 3) / 7);
    expect(computePoseConfidence(landmarks)).toBeCloseTo((0.9 * 3) / 7); // 默认 full
  });

  it('空关键点列表置信度为 0', () => {
    expect(computePoseConfidence([], 'upper')).toBe(0);
    expect(computePoseConfidence([], 'full')).toBe(0);
  });

  it('upper 模式帧中没有上半身关键点时置信度为 0', () => {
    const legsOnly = landmarks.filter((lm) => lm.name.includes('knee'));
    expect(computePoseConfidence(legsOnly, 'upper')).toBe(0);
  });
});
