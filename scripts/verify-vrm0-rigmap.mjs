#!/usr/bin/env node
/**
 * 离线校验：VRM 0.x（AvatarSample_A.vrm）humanoid 骨骼映射。
 *
 * 运行：npx vite-node scripts/verify-vrm0-rigmap.mjs
 *
 * 校验内容：
 * 1. JSON chunk 中存在 extensions.VRM.humanoid.humanBones 数组（0.x 格式 { bone, node }）；
 * 2. 经 extractVrm0RigMap 能映射出 >= 17 根核心 StandardRig 骨骼并打印映射表；
 * 3. 朝向校正：0.x 原始数据面向 -Z，correctVrm0Facing 应绕 Y 转 π；
 * 4. Seed-san（VRM 1.0）检测为 VRMC_vrm，不走 0.x 路径（回归检查）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRM_HUMANOID_TO_RIG } from '@dhp/avatar-schema';
import {
  collectGltfNodesByIndex,
  correctVrm0Facing,
  extractVrm0RigMap,
  readGlbJson,
} from '../packages/avatar-runtime/src/imported.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SAMPLE_A = `${ROOT}/assets/base-avatars/samples/AvatarSample_A.vrm`;
const SEED_SAN = `${ROOT}/assets/base-avatars/samples/Seed-san.vrm`;

const CORE_BONES = [
  'Hips', 'Spine', 'Chest', 'Neck', 'Head',
  'LeftUpperArm', 'LeftLowerArm', 'LeftHand',
  'RightUpperArm', 'RightLowerArm', 'RightHand',
  'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot',
  'RightUpperLeg', 'RightLowerLeg', 'RightFoot',
];

let failed = false;
const check = (ok, label) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}`);
  if (!ok) failed = true;
};

function readFile(path) {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** 剥离贴图引用并重打包 GLB（Node 无法解码图片，仅用于离线校验）。 */
function stripTextures(buffer) {
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

const parseGltf = (buffer) =>
  new Promise((resolve, reject) => new GLTFLoader().parse(buffer, '', resolve, reject));

// ---------- 1. JSON chunk 结构 ----------
console.log('\n[1] AvatarSample_A.vrm JSON chunk');
const gltfJson = readGlbJson(readFile(SAMPLE_A));
const humanBones = gltfJson?.extensions?.VRM?.humanoid?.humanBones;
check(!!gltfJson?.extensions?.VRM, '存在 extensions.VRM（VRM 0.x）');
check(!gltfJson?.extensions?.VRMC_vrm, '不存在 extensions.VRMC_vrm（非 1.0）');
check(Array.isArray(humanBones) && humanBones.length > 0, `humanBones 为数组（${humanBones?.length} 条）`);
check(
  humanBones.every((h) => typeof h.bone === 'string' && typeof h.node === 'number'),
  '元素形如 { bone, node }（0.x 格式）',
);

// ---------- 2. GLTFLoader 解析 + extractVrm0RigMap ----------
console.log('\n[2] GLTFLoader 解析（无 VRMLoaderPlugin）+ 骨骼映射');
const gltf = await parseGltf(stripTextures(readFile(SAMPLE_A)));
gltf.scene.updateMatrixWorld(true);
const nodes = collectGltfNodesByIndex(gltf);
const rigMap = extractVrm0RigMap(gltf.parser.json, nodes);
check(rigMap.size >= 17, `映射出 ${rigMap.size} 根骨骼（要求 >= 17）`);

const nodeDefs = gltf.parser.json.nodes;
console.log('\n  StandardRig 骨骼映射表：');
for (const bone of Object.values(VRM_HUMANOID_TO_RIG)) {
  const node = rigMap.get(bone);
  const entry = humanBones.find((h) => VRM_HUMANOID_TO_RIG[h.bone] === bone);
  const gltfNodeName = entry ? nodeDefs[entry.node]?.name : undefined;
  console.log(
    `  ${node ? '✓' : '✗'} ${bone.padEnd(14)} ← node[${entry?.node ?? '-'}] "${gltfNodeName ?? '-'}" (Object3D: "${node?.name ?? '-'}")`,
  );
  if (!node && CORE_BONES.includes(bone)) failed = true;
}
const missingCore = CORE_BONES.filter((b) => !rigMap.has(b));
check(missingCore.length === 0, missingCore.length === 0 ? '核心骨骼（头/脊柱/双臂/双腿）全部命中' : `缺少: ${missingCore.join(', ')}`);

// ---------- 3. 朝向校正 ----------
console.log('\n[3] 朝向校正（0.x 面向 -Z → 绕 Y 转 π）');
const footBefore = rigMap.get('LeftFoot').getWorldPosition(new Vector3());
const toesBefore = rigMap.get('LeftToes').getWorldPosition(new Vector3());
console.log(`  原始：左脚踝 z=${footBefore.z.toFixed(4)}，左脚尖 z=${toesBefore.z.toFixed(4)}（脚尖在 -Z 侧 → 背对相机）`);
const rotated = correctVrm0Facing(gltf.scene, rigMap);
check(rotated === true, 'correctVrm0Facing 判定需要旋转并已绕 Y 转 π');
const footAfter = rigMap.get('LeftFoot').getWorldPosition(new Vector3());
const toesAfter = rigMap.get('LeftToes').getWorldPosition(new Vector3());
check(toesAfter.z > footAfter.z, `旋转后脚尖在 +Z 侧（z=${toesAfter.z.toFixed(4)} > ${footAfter.z.toFixed(4)}），面向相机`);

// ---------- 4. Seed-san 回归 ----------
console.log('\n[4] Seed-san.vrm 回归检查');
const seedJson = readGlbJson(readFile(SEED_SAN));
check(!!seedJson?.extensions?.VRMC_vrm, '存在 extensions.VRMC_vrm（VRM 1.0，走 three-vrm 路径）');
check(!seedJson?.extensions?.VRM, '不存在 extensions.VRM（不会误入 0.x 路径）');

console.log(failed ? '\n校验失败 ✗' : '\n全部校验通过 ✓');
process.exit(failed ? 1 : 0);
