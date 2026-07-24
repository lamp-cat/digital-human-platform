import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import {
  VRM_FINGER_TO_RIG,
  VRM_HUMANOID_TO_RIG,
  createDefaultProfile,
  type StandardRigBone,
} from '@dhp/avatar-schema';
import {
  collectGltfNodesByIndex,
  correctVrm0Facing,
  extractVrm0ExpressionGroups,
  extractVrm0RigMap,
  loadImportedAvatarFromBuffer,
  readGlbJson,
  VRM_LOADER_OPTIONS,
} from '../src/imported.js';
import { AvatarPackage } from '../src/avatar-package.js';

const SAMPLE_A_URL = new URL('../../../assets/base-avatars/samples/AvatarSample_A.vrm', import.meta.url);
const SEED_SAN_URL = new URL('../../../assets/base-avatars/samples/Seed-san.vrm', import.meta.url);

function readFile(url: URL): ArrayBuffer {
  const buf = readFileSync(url);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * 剥离 GLB 中的贴图/图片引用并重打包。
 * Node 环境无法解码图片，仅用于测试与离线校验脚本。
 */
function stripTextures(buffer: ArrayBuffer): ArrayBuffer {
  const dv = new DataView(buffer);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLen)));
  delete json.images;
  delete json.textures;
  delete json.samplers;
  for (const m of json.materials ?? []) {
    const pbr = m.pbrMetallicRoughness ?? {};
    delete pbr.baseColorTexture;
    delete pbr.metallicRoughnessTexture;
    delete m.normalTexture;
    delete m.occlusionTexture;
    delete m.emissiveTexture;
  }
  // VRM 1.0 的 MToon 扩展还会在 extensions 内引用纹理；Node 测试需一并剥离。
  const removeExtensionTextureRefs = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(removeExtensionTextureRefs);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/texture$/i.test(key)) delete (value as Record<string, unknown>)[key];
      else removeExtensionTextureRefs(child);
    }
  };
  removeExtensionTextureRefs(json.extensions);
  removeExtensionTextureRefs(json.materials);
  json.extensionsUsed = (json.extensionsUsed ?? []).filter(
    (name: string) => name !== 'KHR_texture_basisu',
  );
  json.extensionsRequired = (json.extensionsRequired ?? []).filter(
    (name: string) => name !== 'KHR_texture_basisu',
  );
  const newJson = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (newJson.length % 4)) % 4;
  const jsonChunk = new Uint8Array(newJson.length + pad);
  jsonChunk.set(newJson);
  jsonChunk.fill(0x20, newJson.length);
  const rest = new Uint8Array(buffer, 20 + jsonLen);
  const out = new ArrayBuffer(12 + 8 + jsonChunk.length + rest.length);
  const odv = new DataView(out);
  const ou8 = new Uint8Array(out);
  odv.setUint32(0, 0x46546c67, true);
  odv.setUint32(4, 2, true);
  odv.setUint32(8, out.byteLength, true);
  odv.setUint32(12, jsonChunk.length, true);
  odv.setUint32(16, 0x4e4f534a, true);
  ou8.set(jsonChunk, 20);
  ou8.set(rest, 20 + jsonChunk.length);
  return out;
}

function parseGltf(buffer: ArrayBuffer): Promise<GLTF> {
  return new Promise((resolve, reject) => new GLTFLoader().parse(buffer, '', resolve, reject));
}

/** 核心骨骼（动作模式驱动所需的最小集合）。 */
const CORE_BONES: StandardRigBone[] = [
  'Hips', 'Spine', 'Chest', 'Neck', 'Head',
  'LeftUpperArm', 'LeftLowerArm', 'LeftHand',
  'RightUpperArm', 'RightLowerArm', 'RightHand',
  'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot',
  'RightUpperLeg', 'RightLowerLeg', 'RightFoot',
];

describe('readGlbJson（VRM 版本检测）', () => {
  it('AvatarSample_A 是 VRM 0.x：extensions.VRM 存在且无 VRMC_vrm', () => {
    const json = readGlbJson(readFile(SAMPLE_A_URL));
    expect(json?.extensions?.VRM).toBeDefined();
    expect(json?.extensions?.VRMC_vrm).toBeUndefined();
    const humanBones = json?.extensions?.VRM?.humanoid?.humanBones;
    expect(Array.isArray(humanBones)).toBe(true);
    expect(humanBones.length).toBeGreaterThan(0);
    expect(humanBones[0]).toHaveProperty('bone');
    expect(humanBones[0]).toHaveProperty('node');
  });

  it('Seed-san 是 VRM 1.0：extensions.VRMC_vrm 存在且无 VRM（不回归 0.x 路径）', () => {
    const json = readGlbJson(readFile(SEED_SAN_URL));
    expect(json?.extensions?.VRMC_vrm).toBeDefined();
    expect(json?.extensions?.VRM).toBeUndefined();
  });
});

describe('VRM 1.0 原始骨骼驱动', () => {
  it('关闭 normalized → raw bones 自动回写，避免 vrm.update 覆盖头部姿态', () => {
    expect(VRM_LOADER_OPTIONS.autoUpdateHumanBones).toBe(false);
  });

  it('预设动作使用 normalized T-Pose 骨架，再安全回写 raw 蒙皮骨骼', async () => {
    const imported = await loadImportedAvatarFromBuffer(
      stripTextures(readFile(SEED_SAN_URL)),
      'Seed-san.vrm',
    );
    expect(imported.vrm).toBeDefined();
    expect(imported.animationRigMap?.size).toBeGreaterThanOrEqual(17);
    expect(imported.animationRigMap?.get('LeftUpperArm')).not.toBe(
      imported.rigMap.get('LeftUpperArm'),
    );

    const pkg = new AvatarPackage({
      profile: createDefaultProfile(),
      imported,
    });
    expect(pkg.playAnimation('idle-01')).toBe(true);
    pkg.update(0.6);
    imported.root.updateMatrixWorld(true);

    const leftDirection = imported.rigMap
      .get('LeftLowerArm')!
      .getWorldPosition(new Vector3())
      .sub(imported.rigMap.get('LeftUpperArm')!.getWorldPosition(new Vector3()))
      .normalize();
    const rightDirection = imported.rigMap
      .get('RightLowerArm')!
      .getWorldPosition(new Vector3())
      .sub(imported.rigMap.get('RightUpperArm')!.getWorldPosition(new Vector3()))
      .normalize();
    expect(imported.vrm!.humanoid.autoUpdateHumanBones).toBe(true);
    expect(leftDirection.x).toBeGreaterThan(0);
    expect(rightDirection.x).toBeLessThan(0);
    expect(leftDirection.y).toBeLessThan(-0.5);
    expect(rightDirection.y).toBeLessThan(-0.5);
    pkg.dispose();
  });
});

describe('extractVrm0RigMap（纯函数映射）', () => {
  const gltfJson = readGlbJson(readFile(SAMPLE_A_URL));

  it('从真实 humanBones 数组映射出全部 22 根 StandardRig 骨骼', () => {
    const nodeCount = (gltfJson!.nodes as unknown[]).length;
    const nodes = Array.from({ length: nodeCount }, (_, i) => {
      const obj = new Object3D();
      obj.name = `node-${i}`;
      return obj;
    });
    const rigMap = extractVrm0RigMap(gltfJson, nodes);
    // VRM_HUMANOID_TO_RIG 的全部键（22 根）都应在样例文件中命中；
    // AvatarSample_A 还带全部 30 根手指扩展骨骼（VRM_FINGER_TO_RIG）
    expect(rigMap.size).toBeGreaterThanOrEqual(17);
    expect(rigMap.size).toBe(
      Object.keys(VRM_HUMANOID_TO_RIG).length + Object.keys(VRM_FINGER_TO_RIG).length,
    );
    for (const bone of CORE_BONES) {
      expect(rigMap.get(bone), bone).toBeDefined();
    }
    // 手指扩展骨骼也命中
    expect(rigMap.get('LeftIndexProximal')).toBeDefined();
    expect(rigMap.get('RightThumbDistal')).toBeDefined();
    // node 索引正确取到对应 Object3D
    const hipsEntry = (gltfJson!.extensions.VRM.humanoid.humanBones as { bone: string; node: number }[])
      .find((h) => h.bone === 'hips')!;
    expect(rigMap.get('Hips')!.name).toBe(`node-${hipsEntry.node}`);
  });

  it('非法输入返回空表（不抛错）', () => {
    expect(extractVrm0RigMap(null, []).size).toBe(0);
    expect(extractVrm0RigMap({}, []).size).toBe(0);
    expect(extractVrm0RigMap({ extensions: { VRM: { humanoid: { humanBones: 'x' } } } }, []).size).toBe(0);
    // 缺 node 引用 / 未知 bone 名 → 跳过
    const weird = {
      extensions: {
        VRM: {
          humanoid: {
            humanBones: [
              { bone: 'hips', node: 99 },
              { bone: 'notABone', node: 0 },
              { bone: 'head' },
            ],
          },
        },
      },
    };
    expect(extractVrm0RigMap(weird, [new Object3D()]).size).toBe(0);
  });
});

describe('VRM 0.x 完整加载链路（GLTFLoader.parse，无 VRMLoaderPlugin）', () => {
  it('AvatarSample_A 解析出真实骨骼节点，且朝向校正为面向 +Z', async () => {
    const gltf = await parseGltf(stripTextures(readFile(SAMPLE_A_URL)));
    const root = gltf.scene;
    root.updateMatrixWorld(true);

    const nodes = collectGltfNodesByIndex(gltf);
    const rigMap = extractVrm0RigMap(gltf.parser.json, nodes);
    expect(rigMap.size).toBeGreaterThanOrEqual(17);
    for (const bone of CORE_BONES) {
      const node = rigMap.get(bone);
      expect(node, bone).toBeDefined();
      expect(root.getObjectById(node!.id), bone).toBe(node); // 确实是场景里的节点
    }

    // 原始数据面向 -Z（脚尖在脚踝 -Z 侧）→ 需要绕 Y 转 π
    const rotated = correctVrm0Facing(root, rigMap);
    expect(rotated).toBe(true);
    expect(Math.abs(Math.abs(root.rotation.y) - Math.PI)).toBeLessThan(1e-6);

    // 旋转后脚尖应在脚踝 +Z 侧（面向平台约定的 +Z / 相机）
    const foot = rigMap.get('LeftFoot')!.getWorldPosition(new Vector3());
    const toes = rigMap.get('LeftToes')!.getWorldPosition(new Vector3());
    expect(toes.z).toBeGreaterThan(foot.z);
  });

  it('AvatarSample_A 的 VRM 0.x BlendShapeGroup 映射到标准表情', async () => {
    const gltf = await parseGltf(stripTextures(readFile(SAMPLE_A_URL)));
    const groups = extractVrm0ExpressionGroups(gltf);
    for (const expression of ['aa', 'ih', 'ee', 'oh', 'ou', 'blink', 'happy', 'sad', 'surprised'] as const) {
      expect(groups.get(expression)?.length, expression).toBeGreaterThan(0);
    }
    const blink = groups.get('blink')![0];
    expect(blink.index).toBeGreaterThanOrEqual(0);
    expect(blink.scale).toBeGreaterThan(0);
    expect(blink.mesh.morphTargetInfluences).toBeDefined();
  });
});
