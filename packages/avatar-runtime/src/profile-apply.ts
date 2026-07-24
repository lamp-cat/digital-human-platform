import {
  BONE_SCALE_PARAM_KEYS,
  EYE_COLORS,
  MORPH_PARAM_KEYS,
  SKIN_TONES,
  boneScaleRange,
  type AvatarProfile,
  type BoneScaleParamKey,
} from '@dhp/avatar-schema';
import type { BaseAvatar } from './base-avatar.js';
import { resetSkeletonToBind } from './skeleton.js';

/** 脸型 morphs → body_head 的 morphTargetInfluences。 */
export function applyMorphs(avatar: BaseAvatar, morphs: AvatarProfile['morphs']): void {
  const mesh = avatar.headMesh;
  const dict = mesh.morphTargetDictionary ?? {};
  for (const key of MORPH_PARAM_KEYS) {
    const index = dict[key];
    if (index === undefined) continue;
    mesh.morphTargetInfluences![index] = morphs[key] ?? 0;
  }
}

/**
 * 体型参数 → 骨骼链缩放（先把整副骨架重置回绑定姿态，再施加，保证幂等）。
 * - height：Hips 整链均匀缩放（正值）
 * - shoulderWidth：左右 Shoulder 间距 + UpperChest/Chest 横向缩放
 * - torsoLength：Spine/Chest 链纵向缩放
 * - legLength：UpperLeg/LowerLeg 链纵向缩放
 */
export function applyBoneScales(
  avatar: BaseAvatar,
  boneScales: Partial<Record<BoneScaleParamKey, number>>,
): void {
  resetSkeletonToBind(avatar.bones);
  const valueOf = (key: BoneScaleParamKey): number => {
    const { min, max } = boneScaleRange(key);
    const v = boneScales[key] ?? 1;
    return Math.min(Math.max(v, min), max); // 限制在 schema 范围，保持正值
  };

  const height = valueOf('height');
  const shoulderWidth = valueOf('shoulderWidth');
  const torsoLength = valueOf('torsoLength');
  const legLength = valueOf('legLength');

  const { bones } = avatar;
  bones.Hips.scale.setScalar(height);

  // 肩宽：拉开左右肩关节间距，同时躯干上部横向微扩
  bones.LeftShoulder.position.x *= shoulderWidth;
  bones.RightShoulder.position.x *= shoulderWidth;
  const chestSpread = 1 + (shoulderWidth - 1) * 0.5;
  bones.UpperChest.scale.x = chestSpread;
  bones.Chest.scale.x = 1 + (shoulderWidth - 1) * 0.3;

  // 躯干长度：Spine/Chest 链分摊
  const torsoEach = Math.sqrt(torsoLength);
  bones.Spine.scale.y = torsoEach;
  bones.Chest.scale.y = torsoEach;

  // 腿长：UpperLeg/LowerLeg 链分摊
  const legEach = Math.sqrt(legLength);
  bones.LeftUpperLeg.scale.y = legEach;
  bones.LeftLowerLeg.scale.y = legEach;
  bones.RightUpperLeg.scale.y = legEach;
  bones.RightLowerLeg.scale.y = legEach;
}

/** 肤色 / 眼睛颜色 / 粗糙度。 */
export function applyMaterials(avatar: BaseAvatar, materials: AvatarProfile['materials']): void {
  const tone = SKIN_TONES.find((t) => t.id === materials.skinToneId) ?? SKIN_TONES[2];
  avatar.bodyMaterial.color.set(tone.color);
  avatar.bodyMaterial.roughness = materials.skinRoughness;

  const eye = EYE_COLORS.find((c) => c.id === materials.eyeColorId) ?? EYE_COLORS[0];
  avatar.eyeMaterial.color.set(eye.color);
}

/** 将 AvatarProfile 的可编辑部分全部应用到底模（仅供内置底模使用）。 */
export function applyProfile(avatar: BaseAvatar, profile: AvatarProfile): void {
  applyMorphs(avatar, profile.morphs);
  applyBoneScales(avatar, profile.boneScales);
  applyMaterials(avatar, profile.materials);
}
