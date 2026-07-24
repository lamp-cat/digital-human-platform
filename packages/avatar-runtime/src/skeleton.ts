import { Bone, Quaternion, Vector3 } from 'three';
import {
  RIG_HIERARCHY,
  STANDARD_RIG_BONES,
  type StandardRigBone,
} from '@dhp/avatar-schema';

/**
 * 绑定姿态（T-Pose，面向 +Z，Y 向上，单位米，总高 1.70）下每根骨骼的局部位置。
 * 比例：髋高 0.95，肩高 1.39，头顶约 1.70。
 */
export const BONE_LOCAL_POSITIONS: Record<StandardRigBone, [number, number, number]> = {
  Hips: [0, 0.95, 0],
  Spine: [0, 0.1, 0],
  Chest: [0, 0.12, 0],
  UpperChest: [0, 0.12, 0],
  Neck: [0, 0.11, 0],
  Head: [0, 0.1, 0],
  LeftShoulder: [0.07, 0.1, 0],
  LeftUpperArm: [0.13, 0.02, 0],
  LeftLowerArm: [0.27, 0, 0],
  LeftHand: [0.25, 0, 0],
  RightShoulder: [-0.07, 0.1, 0],
  RightUpperArm: [-0.13, 0.02, 0],
  RightLowerArm: [-0.27, 0, 0],
  RightHand: [-0.25, 0, 0],
  LeftUpperLeg: [0.1, -0.05, 0],
  LeftLowerLeg: [0, -0.42, 0],
  LeftFoot: [0, -0.4, 0],
  LeftToes: [0, -0.05, 0.1],
  RightUpperLeg: [-0.1, -0.05, 0],
  RightLowerLeg: [0, -0.42, 0],
  RightFoot: [0, -0.4, 0],
  RightToes: [0, -0.05, 0.1],
};

export type BoneMap = Record<StandardRigBone, Bone>;

/** 按 RIG_HIERARCHY 构建 StandardRig 骨架（T-Pose 绑定姿态）。 */
export function buildStandardSkeleton(): { bones: BoneMap; boneList: Bone[]; rootBone: Bone } {
  const bones = {} as BoneMap;
  for (const name of STANDARD_RIG_BONES) {
    const bone = new Bone();
    bone.name = name;
    const [x, y, z] = BONE_LOCAL_POSITIONS[name];
    bone.position.set(x, y, z);
    bones[name] = bone;
  }
  for (const name of STANDARD_RIG_BONES) {
    const parent = RIG_HIERARCHY[name];
    if (parent) bones[parent].add(bones[name]);
  }
  return { bones, boneList: STANDARD_RIG_BONES.map((n) => bones[n]), rootBone: bones.Hips };
}

/** 绑定姿态下的世界坐标（沿父链累加），供程序化几何构建使用。 */
export function bindWorldPosition(name: StandardRigBone): Vector3 {
  const p = new Vector3();
  let cur: StandardRigBone | null = name;
  while (cur) {
    const [x, y, z] = BONE_LOCAL_POSITIONS[cur];
    p.x += x;
    p.y += y;
    p.z += z;
    cur = RIG_HIERARCHY[cur];
  }
  return p;
}

/** 将单根骨骼重置为绑定姿态（局部位置/旋转/缩放还原）。 */
export function resetBoneToBind(bone: Bone, name: StandardRigBone): void {
  const [x, y, z] = BONE_LOCAL_POSITIONS[name];
  bone.position.set(x, y, z);
  bone.quaternion.identity();
  bone.scale.set(1, 1, 1);
}

/** 整副骨架重置为绑定姿态。 */
export function resetSkeletonToBind(bones: BoneMap): void {
  for (const name of STANDARD_RIG_BONES) resetBoneToBind(bones[name], name);
}

/** 便捷：世界方向四元数缓存键。 */
export const IDENTITY_QUAT = new Quaternion();
