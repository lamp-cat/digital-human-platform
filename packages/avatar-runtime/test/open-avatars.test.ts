import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Group, Object3D } from 'three';
import {
  VRM1_FINGER_TO_RIG,
  VRM_FINGER_TO_RIG,
  VRM_HUMANOID_TO_RIG,
  type ExtendedRigBone,
} from '@dhp/avatar-schema';
import {
  extractVrm0RigMap,
  matchGlbBones,
  readGlbJson,
} from '../src/imported.js';

const MODEL_ROOT = new URL(
  '../../../apps/web/public/open-avatars/models/',
  import.meta.url,
);

const MODELS = [
  'quaternius-male.glb',
  'quaternius-female.glb',
  'kaykit-mage.glb',
  'kaykit-knight.glb',
  'avatar-sample-a.vrm',
  'seed-san.vrm',
  'chibi-bear.vrm',
  'chibi-fox.vrm',
  'chibi-dog.vrm',
] as const;

function readModel(name: string): ArrayBuffer {
  const buf = readFileSync(new URL(name, MODEL_ROOT));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function fakeNodes(json: Record<string, any>): Object3D[] {
  return (json.nodes ?? []).map((node: { name?: string }) => {
    const object = new Object3D();
    object.name = node.name ?? '';
    return object;
  });
}

function vrmRigBones(json: Record<string, any>): Set<ExtendedRigBone> {
  if (json.extensions?.VRM) {
    return new Set(
      extractVrm0RigMap(json, fakeNodes(json)).keys(),
    );
  }
  const humanBones = json.extensions?.VRMC_vrm?.humanoid?.humanBones ?? {};
  const mapped = new Set<ExtendedRigBone>();
  for (const name of Object.keys(humanBones)) {
    const bone =
      VRM_HUMANOID_TO_RIG[name] ??
      VRM1_FINGER_TO_RIG[name];
    if (bone) mapped.add(bone);
  }
  return mapped;
}

describe('随平台发布的开源人物模型', () => {
  it('VRM 1.0 拇指三节按 Metacarpal / Proximal / Distal 正确映射', () => {
    expect(VRM1_FINGER_TO_RIG.leftThumbMetacarpal).toBe('LeftThumbProximal');
    expect(VRM1_FINGER_TO_RIG.leftThumbProximal).toBe('LeftThumbIntermediate');
    expect(VRM1_FINGER_TO_RIG.rightThumbMetacarpal).toBe('RightThumbProximal');
    expect(VRM1_FINGER_TO_RIG.rightThumbProximal).toBe('RightThumbIntermediate');
  });

  it.each(MODELS)('%s 是带网格和节点的有效 GLB 2.0 容器', (name) => {
    const json = readGlbJson(readModel(name));
    expect(json?.asset?.version).toBe('2.0');
    expect(json?.nodes?.length).toBeGreaterThan(0);
    expect(json?.meshes?.length).toBeGreaterThan(0);
  });

  it.each([
    ['avatar-sample-a.vrm', 52, true],
    ['seed-san.vrm', 51, true],
    ['chibi-bear.vrm', 22, false],
    ['chibi-fox.vrm', 40, true],
    ['chibi-dog.vrm', 34, true],
  ] as const)('%s 提供可驱动的左右骨骼', (name, minimum, hasFingerBones) => {
    const json = readGlbJson(readModel(name))!;
    const bones = vrmRigBones(json);
    expect(bones.size).toBeGreaterThanOrEqual(minimum);
    for (const bone of [
      'LeftUpperArm',
      'RightUpperArm',
      'LeftUpperLeg',
      'RightUpperLeg',
    ] as const) {
      expect(bones.has(bone), `${name}: ${bone}`).toBe(true);
    }
    expect(bones.has('LeftIndexProximal')).toBe(hasFingerBones);
    expect(bones.has('RightIndexProximal')).toBe(hasFingerBones);
  });

  it.each([
    ['quaternius-male.glb', 52, true],
    ['quaternius-female.glb', 52, true],
    ['kaykit-mage.glb', 17, false],
    ['kaykit-knight.glb', 17, false],
  ] as const)('%s 显式映射左右骨骼，不依赖模糊猜测', (name, minimum, hasFingers) => {
    const json = readGlbJson(readModel(name))!;
    const root = new Group();
    for (const node of fakeNodes(json)) root.add(node);
    const rigMap = matchGlbBones(root);
    expect(rigMap.size).toBeGreaterThanOrEqual(minimum);
    expect(rigMap.get('LeftUpperArm')?.name).toMatch(/[._]l$/);
    expect(rigMap.get('RightUpperArm')?.name).toMatch(/[._]r$/);
    expect(rigMap.get('LeftHand')?.name).toMatch(/[._]l$/);
    expect(rigMap.get('RightHand')?.name).toMatch(/[._]r$/);
    expect(rigMap.has('LeftIndexProximal')).toBe(hasFingers);
    expect(rigMap.has('RightIndexProximal')).toBe(hasFingers);
  });
});
