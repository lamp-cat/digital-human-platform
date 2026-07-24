import { describe, expect, it } from 'vitest';
import { AnimationMixer, Group, Quaternion, Vector3 } from 'three';
import {
  BODY_SECTIONS,
  BUILT_IN_BASE_AVATAR_ID,
  MORPH_PARAM_KEYS,
  RIG_VERSION,
  STANDARD_RIG_BONES,
  createDefaultProfile,
  type GarmentManifest,
} from '@dhp/avatar-schema';
import {
  AvatarPackage,
  PROCEDURAL_GARMENT_IDS,
  applyProfile,
  createBaseAvatar,
  createGarment,
  createPresetClips,
  buildStandardSkeleton,
  retargetClipToRig,
} from '../src/index.js';

/** 测试用 manifest 工厂。 */
function makeManifest(id: string, overrides: Partial<GarmentManifest> = {}): GarmentManifest {
  return {
    id,
    version: '1.0.0',
    displayName: `测试-${id}`,
    type: 'garment',
    category: 'top',
    slots: ['top'],
    layer: 10,
    rigVersion: RIG_VERSION,
    compatibleBaseAvatars: [BUILT_IN_BASE_AVATAR_ID],
    shapeConstraints: {},
    bodyMask: [],
    replacesSlots: [],
    restrictsTraits: {},
    assets: { model: `procedural:${id}` },
    license: { source: 'self-created', licenseId: 'project-owned' },
    ...overrides,
  };
}

const HOODIE = makeManifest('top-hoodie-01', {
  bodyMask: ['body_torso', 'body_left_upper_arm', 'body_right_upper_arm'],
});
const TEE = makeManifest('top-tee-01', { bodyMask: ['body_torso'] });
const JEANS = makeManifest('bottom-jeans-01', {
  category: 'bottom',
  slots: ['bottom'],
  bodyMask: ['body_hips', 'body_left_upper_leg', 'body_right_upper_leg'],
});

function makeCatalog(): Map<string, GarmentManifest> {
  return new Map([
    [HOODIE.id, HOODIE],
    [TEE.id, TEE],
    [JEANS.id, JEANS],
  ]);
}

describe('createBaseAvatar', () => {
  it('包含 22 根 StandardRig 骨骼', () => {
    const avatar = createBaseAvatar();
    expect(Object.keys(avatar.bones)).toHaveLength(22);
    for (const name of STANDARD_RIG_BONES) {
      expect(avatar.bones[name], name).toBeDefined();
      expect(avatar.bones[name].name).toBe(name);
    }
  });

  it('14 个身体分区子网格命名齐全且为 SkinnedMesh', () => {
    const avatar = createBaseAvatar();
    expect(Object.keys(avatar.sections)).toHaveLength(14);
    for (const section of BODY_SECTIONS) {
      const mesh = avatar.sections[section];
      expect(mesh.name).toBe(section);
      expect(mesh.isSkinnedMesh).toBe(true);
      expect(avatar.root.getObjectByName(section)).toBe(mesh);
    }
  });

  it('每个分区刚性绑定：权重归一化且指向对应骨骼', () => {
    const avatar = createBaseAvatar();
    for (const section of BODY_SECTIONS) {
      const mesh = avatar.sections[section];
      const weight = mesh.geometry.getAttribute('skinWeight');
      const index = mesh.geometry.getAttribute('skinIndex');
      expect(weight).toBeDefined();
      expect(index).toBeDefined();
      const count = weight.count;
      for (let i = 0; i < count; i += Math.max(1, Math.floor(count / 8))) {
        const sum = weight.getX(i) + weight.getY(i) + weight.getZ(i) + weight.getW(i);
        expect(sum).toBeCloseTo(1, 5);
      }
    }
  });

  it('body_head 含 11 个 morph target，名字与参数 key 一致', () => {
    const avatar = createBaseAvatar();
    const head = avatar.headMesh;
    expect(head.geometry.morphAttributes.position).toHaveLength(11);
    expect(Object.keys(head.morphTargetDictionary ?? {}).sort()).toEqual(
      [...MORPH_PARAM_KEYS].sort(),
    );
    expect(head.morphTargetInfluences).toHaveLength(11);
  });

  it('整体高度约 1.70m', () => {
    const avatar = createBaseAvatar();
    avatar.root.updateMatrixWorld(true);
    const head = avatar.sections.body_head;
    head.geometry.computeBoundingBox();
    const max = head.geometry.boundingBox!.max;
    expect(max.y).toBeGreaterThan(1.65);
    expect(max.y).toBeLessThan(1.75);
  });
});

describe('applyProfile', () => {
  it('morphs 写入 morphTargetInfluences', () => {
    const avatar = createBaseAvatar();
    const profile = createDefaultProfile();
    profile.morphs.faceWidth = 0.8;
    applyProfile(avatar, profile);
    const dict = avatar.headMesh.morphTargetDictionary!;
    expect(avatar.headMesh.morphTargetInfluences![dict.faceWidth]).toBeCloseTo(0.8);
  });

  it('boneScales：height 整链缩放 / shoulderWidth 拉开肩距，且限制在范围内', () => {
    const avatar = createBaseAvatar();
    const profile = createDefaultProfile();
    profile.boneScales = { height: 1.05, shoulderWidth: 1.1, torsoLength: 1.04, legLength: 0.95 };
    applyProfile(avatar, profile);
    expect(avatar.bones.Hips.scale.x).toBeCloseTo(1.05);
    expect(avatar.bones.LeftShoulder.position.x).toBeGreaterThan(0.07);
    expect(avatar.bones.RightShoulder.position.x).toBeLessThan(-0.07);
    expect(avatar.bones.Spine.scale.y).toBeCloseTo(Math.sqrt(1.04));
    expect(avatar.bones.LeftUpperLeg.scale.y).toBeCloseTo(Math.sqrt(0.95));

    // 超范围值被钳制且保持正值
    profile.boneScales = { height: 3, shoulderWidth: 0.1, torsoLength: 1.04, legLength: 0.95 };
    applyProfile(avatar, profile);
    expect(avatar.bones.Hips.scale.x).toBeLessThanOrEqual(1.1);
    expect(avatar.bones.Hips.scale.x).toBeGreaterThan(0);
    expect(avatar.bones.LeftShoulder.position.x).toBeGreaterThan(0);
  });

  it('materials：肤色 / 眼睛颜色 / 粗糙度写入材质', () => {
    const avatar = createBaseAvatar();
    const profile = createDefaultProfile();
    profile.materials = { skinToneId: 'dark-06', skinRoughness: 0.9, eyeColorId: 'blue-03' };
    applyProfile(avatar, profile);
    expect(avatar.bodyMaterial.color.getHexString()).toBe('7d523d');
    expect(avatar.bodyMaterial.roughness).toBeCloseTo(0.9);
    expect(avatar.eyeMaterial.color.getHexString()).toBe('3d6b9a');
  });
});

describe('AvatarPackage 换装事务', () => {
  function makePackage() {
    return new AvatarPackage({
      profile: createDefaultProfile(),
      knownGarments: makeCatalog(),
    });
  }

  it('wearTrait 成功：提交 traits 并应用 BodyMask', () => {
    const pkg = makePackage();
    const result = pkg.wearTrait(HOODIE);
    expect(result.success).toBe(true);
    expect(pkg.getProfile().traits.top).toBe('top-hoodie-01');
    expect(pkg.getLoadedTraitIds()).toEqual(['top-hoodie-01']);
    const base = pkg.getBaseAvatar()!;
    expect(base.sections.body_torso.visible).toBe(false);
    expect(base.sections.body_left_upper_arm.visible).toBe(false);
    expect(base.sections.body_head.visible).toBe(true);
    expect(pkg.root.getObjectByName('garment:top-hoodie-01')).toBeDefined();
    pkg.dispose();
  });

  it('同槽位冲突：新衣替换旧衣（事务移除旧网格）', () => {
    const pkg = makePackage();
    pkg.wearTrait(HOODIE);
    const result = pkg.wearTrait(TEE);
    expect(result.success).toBe(true);
    expect(pkg.getLoadedTraitIds()).toEqual(['top-tee-01']);
    expect(pkg.root.getObjectByName('garment:top-hoodie-01')).toBeUndefined();
    expect(pkg.root.getObjectByName('garment:top-tee-01')).toBeDefined();
    pkg.dispose();
  });

  it('体型超出衣物范围：SHAPE_OUT_OF_RANGE 且状态不变', () => {
    const pkg = makePackage();
    const profile = createDefaultProfile();
    profile.boneScales.shoulderWidth = 1.12;
    pkg.setProfile(profile);
    const picky = makeManifest('top-tee-01', {
      shapeConstraints: { shoulderWidth: [0.9, 1.0] },
    });
    const before = pkg.getProfile().traits;
    const result = pkg.wearTrait(picky);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reasonCode).toBe('SHAPE_OUT_OF_RANGE');
    expect(pkg.getProfile().traits).toEqual(before);
    expect(pkg.getLoadedTraitIds()).toEqual([]);
    pkg.dispose();
  });

  it('未知衣物 id：TRAIT_NOT_FOUND 且状态不变', () => {
    const pkg = makePackage();
    const ghost = makeManifest('top-ghost-99');
    const result = pkg.wearTrait(ghost);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reasonCode).toBe('TRAIT_NOT_FOUND');
    expect(pkg.getLoadedTraitIds()).toEqual([]);
    pkg.dispose();
  });

  it('unwearTrait：卸载并恢复身体分区可见', () => {
    const pkg = makePackage();
    pkg.wearTrait(HOODIE);
    const result = pkg.unwearTrait('top-hoodie-01');
    expect(result.success).toBe(true);
    expect(pkg.getLoadedTraitIds()).toEqual([]);
    expect(pkg.getBaseAvatar()!.sections.body_torso.visible).toBe(true);
    expect(pkg.getProfile().traits.top).toBeNull();
    pkg.dispose();
  });

  it('computeBodyMask 汇总多件衣物', () => {
    const pkg = makePackage();
    pkg.wearTrait(HOODIE);
    pkg.wearTrait(JEANS);
    const mask = pkg.computeBodyMask();
    expect(mask).toContain('body_torso');
    expect(mask).toContain('body_hips');
    expect(mask).toContain('body_left_upper_leg');
    pkg.dispose();
  });

  it('POSE_ONLY 导入人物：IMPORTED_AVATAR_RESTRICTED', () => {
    const profile = createDefaultProfile();
    profile.assetSource = { type: 'imported', importId: 'imp-1', compatibility: 'POSE_ONLY' };
    const pkg = new AvatarPackage({ profile, knownGarments: makeCatalog() });
    const result = pkg.wearTrait(HOODIE);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reasonCode).toBe('IMPORTED_AVATAR_RESTRICTED');
    pkg.dispose();
  });
});

describe('程序化衣物', () => {
  it('12 件内置衣物均可构建并刚性绑定到骨架', () => {
    const avatar = createBaseAvatar();
    const ctx = { skeleton: avatar.skeleton, bones: avatar.bones };
    expect(PROCEDURAL_GARMENT_IDS).toHaveLength(12);
    for (const id of PROCEDURAL_GARMENT_IDS) {
      const group = createGarment(id, ctx);
      expect(group.name, id).toBe(`garment:${id}`);
      expect(group.children.length, id).toBeGreaterThan(0);
    }
  });
});

describe('预置动作', () => {
  it('八个预置 clip 轨道非空且时长正确', () => {
    const clips = createPresetClips();
    expect(clips.size).toBe(8);
    expect(clips.get('idle-01')!.duration).toBeCloseTo(3);
    expect(clips.get('wave-01')!.duration).toBeCloseTo(2);
    expect(clips.get('walk-01')!.duration).toBeCloseTo(1);
    expect(clips.get('sit-down-01')!.duration).toBeCloseTo(2);
    expect(clips.get('stand-up-01')!.duration).toBeCloseTo(2);
    expect(clips.get('belly-laugh-01')!.duration).toBeCloseTo(2.1);
    for (const [, clip] of clips) {
      expect(clip.tracks.length).toBeGreaterThan(0);
      for (const track of clip.tracks) {
        expect(track.values.length).toBeGreaterThan(0);
      }
    }
  });

  it('playAnimation 播放后骨骼离开 bind pose，stopAnimation 后回位', () => {
    const pkg = new AvatarPackage({ profile: createDefaultProfile() });
    const base = pkg.getBaseAvatar()!;
    expect(pkg.playAnimation('wave-01')).toBe(true);
    pkg.update(1.0); // 推进到挥手举起阶段
    const raised = base.bones.RightUpperArm.quaternion.angleTo(new Quaternion());
    expect(raised).toBeGreaterThan(0.5);

    pkg.stopAnimation();
    pkg.update(0.5); // 回位插值完成
    const restored = base.bones.RightUpperArm.quaternion.angleTo(new Quaternion());
    expect(restored).toBeLessThan(1e-3);
    pkg.dispose();
  });

  it('坐下末帧与站起首帧逐轨道完全连续', () => {
    const clips = createPresetClips();
    const sit = clips.get('sit-down-01')!;
    const stand = clips.get('stand-up-01')!;
    const standTracks = new Map(stand.tracks.map((track) => [track.name, track]));
    for (const sitTrack of sit.tracks) {
      const standTrack = standTracks.get(sitTrack.name)!;
      expect(standTrack, sitTrack.name).toBeDefined();
      const size = sitTrack.getValueSize();
      const sitEnd = Array.from(sitTrack.values.slice(-size));
      const standStart = Array.from(standTrack.values.slice(0, size));
      expect(standStart, sitTrack.name).toEqual(sitEnd);
    }
  });

  it('导入骨架存在非单位 bind rotation 时，重定向仍从 bind 起步并保持世界动作方向', () => {
    const { bones, rootBone } = buildStandardSkeleton();
    const root = new Group();
    root.add(rootBone);
    bones.Chest.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), 0.42);
    bones.RightShoulder.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), -0.18);
    root.updateMatrixWorld(true);
    const rigMap = new Map(
      STANDARD_RIG_BONES.map((bone) => [bone, bones[bone]] as const),
    );
    const bindChest = bones.Chest.quaternion.clone();
    const bindRightArmWorld = bones.RightUpperArm.getWorldQuaternion(new Quaternion());
    const source = createPresetClips().get('wave-01')!;
    const retargeted = retargetClipToRig(source, rigMap);

    const chestTrack = retargeted.tracks.find(
      (track) => track.name === 'Chest.quaternion',
    )!;
    const chestFirst = new Quaternion().fromArray(chestTrack.values, 0);
    expect(chestFirst.angleTo(bindChest)).toBeLessThan(1e-5);

    const mixer = new AnimationMixer(root);
    mixer.clipAction(retargeted).play();
    mixer.update(0.35);
    root.updateMatrixWorld(true);
    const actual = bones.RightUpperArm.getWorldQuaternion(new Quaternion());
    // t=0.35：Spine +3° 与 RightUpperArm -140° 同轴叠加，世界增量为 -137°。
    const standardDelta = new Quaternion().setFromAxisAngle(
      new Vector3(0, 0, 1),
      (-137 * Math.PI) / 180,
    );
    const expected = standardDelta.multiply(bindRightArmWorld);
    expect(actual.angleTo(expected)).toBeLessThan(0.02);
  });
});

describe('applyBoneRotations（骨骼驱动接口）', () => {
  it('世界系旋转增量正确写入骨骼', () => {
    const pkg = new AvatarPackage({ profile: createDefaultProfile() });
    const base = pkg.getBaseAvatar()!;
    // 左臂从 +X 抬到 +Y：绕 Z 轴 +90°
    const delta = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    pkg.applyBoneRotations({ LeftUpperArm: { x: delta.x, y: delta.y, z: delta.z, w: delta.w } });
    base.root.updateMatrixWorld(true);
    const angle = base.bones.LeftUpperArm.quaternion.angleTo(delta);
    expect(angle).toBeLessThan(1e-4);
    pkg.dispose();
  });
});
