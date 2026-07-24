import { Matrix4, Object3D, Quaternion } from 'three';
import {
  FINGER_EXTENSION_BONES,
  STANDARD_RIG_BONES,
  type ExtendedRigBone,
} from '@dhp/avatar-schema';

/** 骨骼旋转输出格式（与 rig-mapping 的输出一致）。 */
export interface QuatLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * 骨骼驱动接口：内置底模与导入人物共用。
 * rotations 语义：相对绑定姿态的「世界系旋转增量」，
 * 即 boneWorldQuat_new = delta ⊗ boneWorldQuat_bind。
 */
export interface RigDriver {
  /** StandardRig（含手指扩展骨骼）→ 实际骨骼节点。 */
  bones: Map<ExtendedRigBone, Object3D>;
  /** 绑定姿态下每根骨骼的世界朝向。 */
  bindWorldQuat: Map<ExtendedRigBone, Quaternion>;
}

/** 在绑定姿态下捕获世界朝向，构建驱动句柄。调用前需确保处于绑定姿态。 */
export function createRigDriver(bones: Map<ExtendedRigBone, Object3D>, root: Object3D): RigDriver {
  root.updateMatrixWorld(true);
  const bindWorldQuat = new Map<ExtendedRigBone, Quaternion>();
  for (const [name, obj] of bones) {
    bindWorldQuat.set(name, obj.getWorldQuaternion(new Quaternion()));
  }
  return { bones, bindWorldQuat };
}

/** 写入顺序：22 根最小骨架在前，手指扩展骨骼在后（父先子后，Hand 先于指节）。 */
const DRIVEN_BONE_ORDER: readonly ExtendedRigBone[] = [
  ...STANDARD_RIG_BONES,
  ...FINGER_EXTENSION_BONES,
];

const _delta = new Quaternion();
const _targetWorld = new Quaternion();
const _parentInv = new Quaternion();
const _m = new Matrix4();

/**
 * 将世界系旋转增量写入骨骼（父先子后顺序）。
 * 未包含在 rotations 中的骨骼保持当前姿态；rigMap 中不存在的骨骼自动跳过
 * （内置底模无手指骨骼时手指旋转被忽略）。
 */
export function applyBoneRotations(
  driver: RigDriver,
  rotations: Partial<Record<ExtendedRigBone, QuatLike>>,
): void {
  for (const name of DRIVEN_BONE_ORDER) {
    const q = rotations[name];
    const obj = driver.bones.get(name);
    if (!q || !obj || !obj.parent) continue;
    const bindWorld = driver.bindWorldQuat.get(name);
    if (!bindWorld) continue;

    _delta.set(q.x, q.y, q.z, q.w);
    _targetWorld.copy(_delta).multiply(bindWorld); // 世界系：delta ⊗ bind
    obj.parent.updateWorldMatrix(true, false);
    _parentInv.setFromRotationMatrix(_m.extractRotation(obj.parent.matrixWorld)).invert();
    obj.quaternion.copy(_parentInv).multiply(_targetWorld);
  }
}
