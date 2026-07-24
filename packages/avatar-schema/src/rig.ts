/**
 * StandardRig：平台统一人形骨架规范（开发文档 §6.2 最小骨架清单）。
 * 所有人物、衣物、动作共享同一套骨骼命名。运行时内部必须显式映射，禁止名称猜测。
 */

export const RIG_VERSION = 'standard-rig-1' as const;

export const STANDARD_RIG_BONES = [
  'Hips',
  'Spine',
  'Chest',
  'UpperChest',
  'Neck',
  'Head',
  'LeftShoulder',
  'LeftUpperArm',
  'LeftLowerArm',
  'LeftHand',
  'RightShoulder',
  'RightUpperArm',
  'RightLowerArm',
  'RightHand',
  'LeftUpperLeg',
  'LeftLowerLeg',
  'LeftFoot',
  'LeftToes',
  'RightUpperLeg',
  'RightLowerLeg',
  'RightFoot',
  'RightToes',
] as const;

export type StandardRigBone = (typeof STANDARD_RIG_BONES)[number];

/** 最小骨架集：V1 换装与桌面动捕只依赖这些骨骼。 */
export const MINIMAL_RIG_BONES: readonly StandardRigBone[] = STANDARD_RIG_BONES;

/** 骨架父子关系（绑定姿态：T-Pose，角色面向 +Z，Y 轴向上，单位米，基准身高 1.70m）。 */
export const RIG_HIERARCHY: Record<StandardRigBone, StandardRigBone | null> = {
  Hips: null,
  Spine: 'Hips',
  Chest: 'Spine',
  UpperChest: 'Chest',
  Neck: 'UpperChest',
  Head: 'Neck',
  LeftShoulder: 'UpperChest',
  LeftUpperArm: 'LeftShoulder',
  LeftLowerArm: 'LeftUpperArm',
  LeftHand: 'LeftLowerArm',
  RightShoulder: 'UpperChest',
  RightUpperArm: 'RightShoulder',
  RightLowerArm: 'RightUpperArm',
  RightHand: 'RightLowerArm',
  LeftUpperLeg: 'Hips',
  LeftLowerLeg: 'LeftUpperLeg',
  LeftFoot: 'LeftLowerLeg',
  LeftToes: 'LeftFoot',
  RightUpperLeg: 'Hips',
  RightLowerLeg: 'RightUpperLeg',
  RightFoot: 'RightLowerLeg',
  RightToes: 'RightFoot',
};

/** BodyMask 身体逻辑分区（开发文档 §7.5）。BaseAvatar 的每个身体子网格必须以此命名。 */
export const BODY_SECTIONS = [
  'body_head',
  'body_neck',
  'body_torso',
  'body_left_upper_arm',
  'body_left_lower_arm',
  'body_right_upper_arm',
  'body_right_lower_arm',
  'body_hips',
  'body_left_upper_leg',
  'body_left_lower_leg',
  'body_left_foot',
  'body_right_upper_leg',
  'body_right_lower_leg',
  'body_right_foot',
] as const;

export type BodySection = (typeof BODY_SECTIONS)[number];

/** VRM Humanoid 名称 → StandardRig 显式映射表（§6.2：不允许仅靠名称猜测）。 */
export const VRM_HUMANOID_TO_RIG: Record<string, StandardRigBone> = {
  hips: 'Hips',
  spine: 'Spine',
  chest: 'Chest',
  upperChest: 'UpperChest',
  neck: 'Neck',
  head: 'Head',
  leftShoulder: 'LeftShoulder',
  leftUpperArm: 'LeftUpperArm',
  leftLowerArm: 'LeftLowerArm',
  leftHand: 'LeftHand',
  rightShoulder: 'RightShoulder',
  rightUpperArm: 'RightUpperArm',
  rightLowerArm: 'RightLowerArm',
  rightHand: 'RightHand',
  leftUpperLeg: 'LeftUpperLeg',
  leftLowerLeg: 'LeftLowerLeg',
  leftFoot: 'LeftFoot',
  leftToes: 'LeftToes',
  rightUpperLeg: 'RightUpperLeg',
  rightLowerLeg: 'RightLowerLeg',
  rightFoot: 'RightFoot',
  rightToes: 'RightToes',
};
