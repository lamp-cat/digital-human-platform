import {
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  Skeleton,
  SkinnedMesh,
  SphereGeometry,
  Uint16BufferAttribute,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  BODY_SECTIONS,
  SKIN_TONES,
  STANDARD_RIG_BONES,
  type BodySection,
  type StandardRigBone,
} from '@dhp/avatar-schema';
import { buildStandardSkeleton, type BoneMap } from './skeleton.js';
import { addHeadMorphTargets, HEAD_CENTER_Y, HEAD_RADIUS } from './morphs.js';

/** 内置程序化底模。 */
export interface BaseAvatar {
  /** 场景根节点（骨架 + 所有身体子网格）。 */
  root: Group;
  bones: BoneMap;
  skeleton: Skeleton;
  /** 14 个身体分区子网格，命名与 BODY_SECTIONS 一致。 */
  sections: Record<BodySection, SkinnedMesh>;
  headMesh: SkinnedMesh;
  /** 贴在 Head 骨骼上的眼球。 */
  eyeMeshes: { left: Mesh; right: Mesh };
  /** 内置底模的简化嘴部，用于实时口型反馈。 */
  mouthMesh: Mesh;
  bodyMaterial: MeshStandardMaterial;
  eyeMaterial: MeshStandardMaterial;
  mouthMaterial: MeshStandardMaterial;
}

/** 每个分区刚性绑定的骨骼。 */
export const SECTION_BONE: Record<BodySection, StandardRigBone> = {
  body_head: 'Head',
  body_neck: 'Neck',
  body_torso: 'Chest',
  body_left_upper_arm: 'LeftUpperArm',
  body_left_lower_arm: 'LeftLowerArm',
  body_right_upper_arm: 'RightUpperArm',
  body_right_lower_arm: 'RightLowerArm',
  body_hips: 'Hips',
  body_left_upper_leg: 'LeftUpperLeg',
  body_left_lower_leg: 'LeftLowerLeg',
  body_left_foot: 'LeftFoot',
  body_right_upper_leg: 'RightUpperLeg',
  body_right_lower_leg: 'RightLowerLeg',
  body_right_foot: 'RightFoot',
};

// ---------- 几何构建辅助（均在绑定姿态世界坐标下） ----------

function capsuleY(radius: number, length: number, cx: number, cy: number, cz: number, scaleZ = 1): BufferGeometry {
  const g = new CapsuleGeometry(radius, length, 6, 16);
  if (scaleZ !== 1) g.scale(1, 1, scaleZ);
  g.translate(cx, cy, cz);
  return g;
}

function capsuleX(radius: number, length: number, cx: number, cy: number, cz: number): BufferGeometry {
  const g = new CapsuleGeometry(radius, length, 6, 16);
  g.rotateZ(Math.PI / 2); // 轴从 Y 转到 X
  g.translate(cx, cy, cz);
  return g;
}

function box(w: number, h: number, d: number, cx: number, cy: number, cz: number): BufferGeometry {
  const g = new BoxGeometry(w, h, d);
  g.translate(cx, cy, cz);
  return g;
}

function headGeometry(): BufferGeometry {
  const g = new SphereGeometry(HEAD_RADIUS, 32, 24);
  g.scale(1, 1.12, 1); // 略长的头部椭球
  g.translate(0, HEAD_CENTER_Y, 0);
  return g;
}

/** 分区几何（左右对称处分别生成）。 */
const SECTION_GEOMETRY: Record<BodySection, () => BufferGeometry> = {
  body_head: headGeometry,
  body_neck: () => capsuleY(0.045, 0.08, 0, 1.44, 0),
  body_torso: () => capsuleY(0.14, 0.18, 0, 1.21, 0, 0.78),
  body_hips: () => capsuleY(0.145, 0.06, 0, 0.93, 0, 0.82),
  body_left_upper_arm: () => capsuleX(0.048, 0.17, 0.335, 1.41, 0),
  body_left_lower_arm: () =>
    mergeGeometries([
      capsuleX(0.042, 0.16, 0.595, 1.41, 0),
      box(0.1, 0.035, 0.06, 0.755, 1.41, 0), // 手
    ])!,
  body_right_upper_arm: () => capsuleX(0.048, 0.17, -0.335, 1.41, 0),
  body_right_lower_arm: () =>
    mergeGeometries([
      capsuleX(0.042, 0.16, -0.595, 1.41, 0),
      box(0.1, 0.035, 0.06, -0.755, 1.41, 0),
    ])!,
  body_left_upper_leg: () => capsuleY(0.078, 0.26, 0.1, 0.67, 0),
  body_left_lower_leg: () => capsuleY(0.056, 0.26, 0.1, 0.27, 0),
  body_left_foot: () =>
    mergeGeometries([
      box(0.095, 0.07, 0.22, 0.1, 0.04, 0.045),
      box(0.095, 0.05, 0.08, 0.1, 0.028, 0.17), // 脚尖
    ])!,
  body_right_upper_leg: () => capsuleY(0.078, 0.26, -0.1, 0.67, 0),
  body_right_lower_leg: () => capsuleY(0.056, 0.26, -0.1, 0.27, 0),
  body_right_foot: () =>
    mergeGeometries([
      box(0.095, 0.07, 0.22, -0.1, 0.04, 0.045),
      box(0.095, 0.05, 0.08, -0.1, 0.028, 0.17),
    ])!,
};

/**
 * 构建刚性蒙皮子网格：全部顶点权重 1.0 绑到指定骨骼（权重归一化）。
 */
export function makeRigidSkinnedMesh(
  name: string,
  geometry: BufferGeometry,
  material: MeshStandardMaterial,
  boneIndex: number,
): SkinnedMesh {
  const count = geometry.getAttribute('position').count;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    skinIndex[i * 4] = boneIndex;
    skinWeight[i * 4] = 1;
  }
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(skinWeight, 4));
  const mesh = new SkinnedMesh(geometry, material);
  mesh.name = name;
  mesh.frustumCulled = false; // 蒙皮变形后包围球失效，禁用剔除
  return mesh;
}

/**
 * 创建程序化 BaseAvatar：T-Pose、面向 +Z、总高 1.70m。
 * 14 个分区子网格各自刚性绑定到对应骨骼；头部含 11 个脸型 morph target。
 */
export function createBaseAvatar(): BaseAvatar {
  const { bones, boneList, rootBone } = buildStandardSkeleton();

  const root = new Group();
  root.name = 'BaseAvatar';
  root.add(rootBone);

  const defaultTone = SKIN_TONES.find((t) => t.id === 'warm-03') ?? SKIN_TONES[0];
  const bodyMaterial = new MeshStandardMaterial({
    color: defaultTone.color,
    roughness: 0.52,
    metalness: 0,
  });

  const sections = {} as Record<BodySection, SkinnedMesh>;
  for (const section of BODY_SECTIONS) {
    const geometry = SECTION_GEOMETRY[section]();
    if (section === 'body_head') addHeadMorphTargets(geometry);
    const boneIndex = STANDARD_RIG_BONES.indexOf(SECTION_BONE[section]);
    const mesh = makeRigidSkinnedMesh(section, geometry, bodyMaterial, boneIndex);
    sections[section] = mesh;
    root.add(mesh);
  }

  // 骨架需先更新世界矩阵再创建 Skeleton（自动计算 boneInverses）
  root.updateMatrixWorld(true);
  const skeleton = new Skeleton(boneList);
  for (const section of BODY_SECTIONS) {
    sections[section].bind(skeleton, sections[section].matrixWorld);
  }

  // 眼球：贴在 Head 骨骼上（Head 世界坐标 (0, 1.50, 0)）
  const eyeMaterial = new MeshStandardMaterial({ color: '#5b3a24', roughness: 0.3, metalness: 0 });
  const eyeGeo = new SphereGeometry(0.016, 16, 12);
  const leftEye = new Mesh(eyeGeo, eyeMaterial);
  leftEye.name = 'eye_left';
  leftEye.position.set(0.042, 0.085, 0.1);
  const rightEye = new Mesh(eyeGeo, eyeMaterial);
  rightEye.name = 'eye_right';
  rightEye.position.set(-0.042, 0.085, 0.1);
  bones.Head.add(leftEye, rightEye);

  // 简化嘴部：中性时为细椭圆；面捕通过缩放表达张嘴/圆唇/微笑。
  const mouthMaterial = new MeshStandardMaterial({ color: '#4b1f25', roughness: 0.48, metalness: 0 });
  const mouthGeo = new SphereGeometry(0.026, 20, 12);
  mouthGeo.scale(1.2, 0.25, 0.2);
  const mouth = new Mesh(mouthGeo, mouthMaterial);
  mouth.name = 'mouth';
  mouth.position.set(0, 0.025, 0.112);
  bones.Head.add(mouth);

  return {
    root,
    bones,
    skeleton,
    sections,
    headMesh: sections.body_head,
    eyeMeshes: { left: leftEye, right: rightEye },
    mouthMesh: mouth,
    bodyMaterial,
    eyeMaterial,
    mouthMaterial,
  };
}
