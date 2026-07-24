import {
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  ColorRepresentation,
  Group,
  Material,
  Matrix4,
  MeshStandardMaterial,
  Skeleton,
  SphereGeometry,
  TorusGeometry,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { StandardRigBone } from '@dhp/avatar-schema';
import type { BoneMap } from './skeleton.js';
import { makeRigidSkinnedMesh } from './base-avatar.js';

/**
 * 程序化衣物：与底模共享同一副 StandardRig 骨架，逐件刚性蒙皮到最近骨骼。
 * 几何在绑定姿态世界坐标下构建，尺寸略大于身体对应分区以防穿透。
 */

export interface GarmentBuildContext {
  skeleton: Skeleton;
  bones: BoneMap;
}

export const PROCEDURAL_GARMENT_IDS = [
  'hair-short-01',
  'hair-long-01',
  'top-hoodie-01',
  'top-tee-01',
  'top-jacket-01',
  'bottom-jeans-01',
  'bottom-shorts-01',
  'shoes-sneaker-01',
  'shoes-leather-01',
  'acc-glasses-01',
  'acc-cap-01',
  'acc-watch-01',
] as const;

export function isProceduralGarment(id: string): boolean {
  return (PROCEDURAL_GARMENT_IDS as readonly string[]).includes(id);
}

function mat(color: ColorRepresentation, roughness = 0.7): MeshStandardMaterial {
  return new MeshStandardMaterial({ color, roughness, metalness: 0.05 });
}

function capsuleY(radius: number, length: number, cx: number, cy: number, cz: number, scaleZ = 1): BufferGeometry {
  const g = new CapsuleGeometry(radius, length, 6, 16);
  if (scaleZ !== 1) g.scale(1, 1, scaleZ);
  g.translate(cx, cy, cz);
  return g;
}

function capsuleX(radius: number, length: number, cx: number, cy: number, cz: number): BufferGeometry {
  const g = new CapsuleGeometry(radius, length, 6, 16);
  g.rotateZ(Math.PI / 2);
  g.translate(cx, cy, cz);
  return g;
}

function box(w: number, h: number, d: number, cx: number, cy: number, cz: number): BufferGeometry {
  const g = new BoxGeometry(w, h, d);
  g.translate(cx, cy, cz);
  return g;
}

function sphere(radius: number, cx: number, cy: number, cz: number, thetaLength?: number): BufferGeometry {
  const g = new SphereGeometry(radius, 24, 16, 0, Math.PI * 2, 0, thetaLength ?? Math.PI);
  g.translate(cx, cy, cz);
  return g;
}

type Add = (geometry: BufferGeometry, bone: StandardRigBone, material: MeshStandardMaterial) => void;

/** 每件衣物的构建函数。 */
const GARMENT_BUILDERS: Record<string, (add: Add) => void> = {
  // 头盔式短发块
  'hair-short-01': (add) => {
    const m = mat('#3d2c1e', 0.85);
    add(sphere(0.128, 0, 1.585, -0.01, Math.PI * 0.62), 'Head', m);
    add(box(0.17, 0.1, 0.07, 0, 1.545, -0.075), 'Head', m);
  },
  // 长发：发帽 + 后发长块
  'hair-long-01': (add) => {
    const m = mat('#241a12', 0.85);
    add(sphere(0.128, 0, 1.59, -0.01, Math.PI * 0.62), 'Head', m);
    add(box(0.18, 0.38, 0.08, 0, 1.38, -0.1), 'Head', m);
  },
  // 连帽卫衣：躯干罩 + 双上臂袖 + 帽子块
  'top-hoodie-01': (add) => {
    const m = mat('#c2502e', 0.85);
    const hood = mat('#a83f22', 0.85);
    add(capsuleY(0.168, 0.22, 0, 1.19, 0, 0.82), 'Chest', m);
    add(capsuleX(0.066, 0.19, 0.335, 1.41, 0), 'LeftUpperArm', m);
    add(capsuleX(0.066, 0.19, -0.335, 1.41, 0), 'RightUpperArm', m);
    add(sphere(0.09, 0, 1.45, -0.1, Math.PI * 0.7), 'Neck', hood);
  },
  // 短袖 T 恤
  'top-tee-01': (add) => {
    const m = mat('#2e8bc2', 0.8);
    add(capsuleY(0.16, 0.2, 0, 1.2, 0, 0.8), 'Chest', m);
    add(capsuleX(0.06, 0.08, 0.26, 1.41, 0), 'LeftUpperArm', m);
    add(capsuleX(0.06, 0.08, -0.26, 1.41, 0), 'RightUpperArm', m);
  },
  // 夹克：更大躯干罩 + 长袖 + 前襟分色
  'top-jacket-01': (add) => {
    const m = mat('#2e4a7a', 0.75);
    const placket = mat('#d8d8d8', 0.6);
    add(capsuleY(0.178, 0.26, 0, 1.18, 0, 0.85), 'Chest', m);
    add(capsuleX(0.07, 0.19, 0.335, 1.41, 0), 'LeftUpperArm', m);
    add(capsuleX(0.07, 0.19, -0.335, 1.41, 0), 'RightUpperArm', m);
    add(capsuleX(0.058, 0.17, 0.595, 1.41, 0), 'LeftLowerArm', m);
    add(capsuleX(0.058, 0.17, -0.595, 1.41, 0), 'RightLowerArm', m);
    add(box(0.045, 0.36, 0.02, 0.032, 1.2, 0.148), 'Chest', placket);
    add(box(0.045, 0.36, 0.02, -0.032, 1.2, 0.148), 'Chest', placket);
  },
  // 牛仔裤：双腿长管 + 腰
  'bottom-jeans-01': (add) => {
    const m = mat('#33507d', 0.9);
    add(capsuleY(0.158, 0.05, 0, 0.95, 0, 0.85), 'Hips', m);
    add(capsuleY(0.089, 0.27, 0.1, 0.67, 0), 'LeftUpperLeg', m);
    add(capsuleY(0.089, 0.27, -0.1, 0.67, 0), 'RightUpperLeg', m);
    add(capsuleY(0.068, 0.27, 0.1, 0.27, 0), 'LeftLowerLeg', m);
    add(capsuleY(0.068, 0.27, -0.1, 0.27, 0), 'RightLowerLeg', m);
  },
  // 短裤
  'bottom-shorts-01': (add) => {
    const m = mat('#a89468', 0.9);
    add(capsuleY(0.158, 0.05, 0, 0.95, 0, 0.85), 'Hips', m);
    add(capsuleY(0.092, 0.12, 0.1, 0.8, 0), 'LeftUpperLeg', m);
    add(capsuleY(0.092, 0.12, -0.1, 0.8, 0), 'RightUpperLeg', m);
  },
  // 运动鞋
  'shoes-sneaker-01': (add) => {
    const m = mat('#e8e8e8', 0.6);
    const sole = mat('#b8452e', 0.5);
    for (const s of [1, -1] as const) {
      add(box(0.11, 0.075, 0.26, 0.1 * s, 0.05, 0.055), s > 0 ? 'LeftFoot' : 'RightFoot', m);
      add(box(0.115, 0.025, 0.28, 0.1 * s, 0.013, 0.06), s > 0 ? 'LeftFoot' : 'RightFoot', sole);
    }
  },
  // 皮鞋
  'shoes-leather-01': (add) => {
    const m = mat('#5a3a22', 0.35);
    const sole = mat('#2b2018', 0.5);
    for (const s of [1, -1] as const) {
      add(box(0.105, 0.065, 0.25, 0.1 * s, 0.048, 0.055), s > 0 ? 'LeftFoot' : 'RightFoot', m);
      add(box(0.11, 0.02, 0.26, 0.1 * s, 0.011, 0.06), s > 0 ? 'LeftFoot' : 'RightFoot', sole);
    }
  },
  // 眼镜：双圆环 + 梁（绑 Head）
  'acc-glasses-01': (add) => {
    const m = mat('#1a1a1a', 0.4);
    const ringL = new TorusGeometry(0.028, 0.004, 8, 24);
    ringL.translate(0.045, 1.587, 0.112);
    const ringR = new TorusGeometry(0.028, 0.004, 8, 24);
    ringR.translate(-0.045, 1.587, 0.112);
    add(
      mergeGeometries([ringL, ringR, box(0.036, 0.005, 0.005, 0, 1.59, 0.113)])!,
      'Head',
      m,
    );
  },
  // 鸭舌帽：半球帽 + 帽檐（绑 Head）
  'acc-cap-01': (add) => {
    const m = mat('#b03030', 0.8);
    add(sphere(0.13, 0, 1.6, -0.005, Math.PI * 0.5), 'Head', m);
    add(box(0.15, 0.015, 0.1, 0, 1.612, 0.115), 'Head', m);
  },
  // 手表（绑 LeftLowerArm）
  'acc-watch-01': (add) => {
    const band = mat('#222831', 0.6);
    const face = mat('#c0c0c0', 0.25);
    add(box(0.05, 0.015, 0.055, 0.66, 1.455, 0), 'LeftLowerArm', band);
    add(box(0.032, 0.008, 0.038, 0.66, 1.466, 0), 'LeftLowerArm', face);
  },
};

/**
 * 构建程序化衣物，返回可挂到人物根节点的 Group（内部逐件刚性蒙皮到骨架）。
 * 不存在的 id 抛出异常（调用方在换装事务中捕获并保持原状态）。
 */
export function createGarment(id: string, ctx: GarmentBuildContext): Group {
  const builder = GARMENT_BUILDERS[id];
  if (!builder) throw new Error(`未知程序化衣物: ${id}`);
  const group = new Group();
  group.name = `garment:${id}`;
  const add: Add = (geometry, boneName, material) => {
    const boneIndex = ctx.skeleton.bones.indexOf(ctx.bones[boneName]);
    if (boneIndex < 0) throw new Error(`骨架中缺少骨骼: ${boneName}`);
    const mesh = makeRigidSkinnedMesh(`${id}:${boneName}`, geometry, material, boneIndex);
    mesh.bind(ctx.skeleton, new Matrix4());
    group.add(mesh);
  };
  builder(add);
  return group;
}

/** 释放衣物组的几何与材质。 */
export function disposeGarment(group: Group): void {
  group.traverse((obj) => {
    const mesh = obj as { geometry?: BufferGeometry; material?: Material | Material[] };
    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.material) {
      if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
      else mesh.material.dispose();
    }
  });
  group.removeFromParent();
}
