#!/usr/bin/env node
/**
 * 端到端离线校验：导入的 VRM 0.x / 1.0 人物在动作链路下"能动"。
 *
 * 运行：npx vite-node scripts/verify-imported-drive.mjs
 * 前提：后端运行在 :8000（种子账号 demo@dhp.local / demo123456）。
 *
 * 校验内容（两个导入模型：Seed-san=VRM 1.0、AvatarSample_A=VRM 0.x）：
 * 1. 登录拿 token，GET /api/v1/imports 找到导入记录，取签名 modelUrl（无扩展名）；
 * 2. fetch 模型字节，走与运行时相同的加载路径 loadImportedAvatarFromBuffer
 *    （内容嗅探 VRM 版本，与 URL 后缀无关）——贴图剥离仅供 Node 解析；
 * 3. rigMap 命中 >= 17 根核心骨骼；
 * 4. 预置动作（idle/walk 经 retargetClip + AnimationMixer，与 AvatarPackage 同路径）
 *    播放若干帧，双臂骨骼 local quaternion 与 Hips 位置随时间变化；
 * 5. rig-mapping 驱动（合成抬手 PoseFrame → calibrate → mapPoseFrameToBoneRotations
 *    → applyBoneRotations），右臂骨骼旋转生效且右手腕世界 y 增大。
 */
import { Quaternion, Vector3, AnimationMixer, LoopRepeat } from 'three';
import { loadImportedAvatarFromBuffer } from '../packages/avatar-runtime/src/imported.ts';
import { createPresetClips, retargetClip } from '../packages/avatar-runtime/src/animations.ts';
import { applyBoneRotations } from '../packages/avatar-runtime/src/rig-driver.ts';
import { calibrate, mapPoseFrameToBoneRotations } from '../packages/rig-mapping/src/index.ts';

const API = process.env.DHP_API ?? 'http://localhost:8000';
const EMAIL = 'demo@dhp.local';
const PASSWORD = 'demo123456';

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

// ---------- API ----------
async function login() {
  const res = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`登录失败 HTTP ${res.status}`);
  return (await res.json()).token;
}

async function apiGet(path, token) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
  return res.json();
}

async function fetchModelBytes(modelUrl, token) {
  const url = modelUrl.startsWith('http') ? modelUrl : `${API}${modelUrl}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`模型下载失败 HTTP ${res.status}（${url.slice(0, 60)}…）`);
  return res.arrayBuffer();
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
    // VRMC_materials_mtoon 等扩展内的贴图引用一并剥离
    for (const ext of Object.values(m.extensions ?? {})) {
      if (ext && typeof ext === 'object') {
        for (const key of Object.keys(ext)) {
          if (key.endsWith('Texture')) delete ext[key];
        }
      }
    }
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

// ---------- 合成 PoseFrame（图像归一化坐标，y 向下） ----------
const T_POSE = {
  nose: [0.5, 0.15],
  left_shoulder: [0.6, 0.3],
  right_shoulder: [0.4, 0.3],
  left_elbow: [0.7, 0.3],
  right_elbow: [0.3, 0.3],
  left_wrist: [0.8, 0.3],
  right_wrist: [0.2, 0.3],
  left_hip: [0.55, 0.52],
  right_hip: [0.45, 0.52],
  left_knee: [0.555, 0.72],
  right_knee: [0.445, 0.72],
  left_ankle: [0.56, 0.92],
  right_ankle: [0.44, 0.92],
};

function makeFrame(points) {
  return {
    timestampMs: 0,
    source: 'verify',
    confidence: 0.95,
    landmarks: Object.entries(points).map(([name, [x, y, z]]) => ({
      name,
      x,
      y,
      z: z ?? 0,
      visibility: 0.99,
    })),
  };
}

// ---------- 主流程 ----------
const token = await login();
console.log(`登录成功（${EMAIL}）`);

const { imports } = await apiGet('/api/v1/imports', token);
const targets = ['Seed-san', 'AvatarSample_A'];

for (const name of targets) {
  const rec = imports.find((r) => r.displayName === name);
  if (!rec) {
    check(false, `导入记录存在：${name}`);
    continue;
  }
  const { importRecord } = await apiGet(`/api/v1/imports/${rec.id}`, token);
  console.log(`\n[${name}] ${importRecord.originalFilename}（modelUrl 无扩展名：${!/\.(vrm|glb)/i.test(importRecord.modelUrl)}）`);

  // 1. 加载（内容嗅探路由，与运行时同路径）
  const bytes = await fetchModelBytes(importRecord.modelUrl, token);
  const imported = await loadImportedAvatarFromBuffer(stripTextures(bytes), importRecord.modelUrl);
  check(imported.rigMap.size >= 17, `rigMap 命中 ${imported.rigMap.size} 根骨骼（要求 >= 17）`);
  const missingCore = CORE_BONES.filter((b) => !imported.rigMap.has(b));
  check(missingCore.length === 0, missingCore.length === 0 ? '核心骨骼全部命中' : `缺少: ${missingCore.join(', ')}`);

  // 2. 预置动作驱动（retargetClip + AnimationMixer，与 AvatarPackage 同路径）
  const nameMap = new Map();
  for (const [bone, node] of imported.rigMap) nameMap.set(bone, node.name);
  const mixer = new AnimationMixer(imported.root);
  let animOk = true;
  for (const clipId of ['idle-01', 'walk-01']) {
    const clip = retargetClip(createPresetClips().get(clipId), nameMap);
    mixer.stopAllAction();
    const action = mixer.clipAction(clip);
    action.setLoop(LoopRepeat, Infinity);
    action.reset().play();

    const armL = imported.rigMap.get('LeftUpperArm');
    const armR = imported.rigMap.get('RightUpperArm');
    const hips = imported.rigMap.get('Hips');
    const qL0 = armL.quaternion.clone();
    const qR0 = armR.quaternion.clone();
    const pH0 = hips.position.clone();
    mixer.update(0.05);
    let maxArmDelta = 0;
    let maxHipsDelta = 0;
    for (let i = 0; i < 10; i++) {
      mixer.update(0.13);
      maxArmDelta = Math.max(maxArmDelta, qL0.angleTo(armL.quaternion), qR0.angleTo(armR.quaternion));
      maxHipsDelta = Math.max(maxHipsDelta, pH0.distanceTo(hips.position));
    }
    const armMoved = maxArmDelta > 0.01; // > ~0.6°
    const hipsMoved = maxHipsDelta > 0.001;
    animOk = animOk && armMoved && (clipId === 'walk-01' ? hipsMoved : true);
    console.log(
      `    ${clipId}: 双臂最大角位移 ${(maxArmDelta * 180 / Math.PI).toFixed(2)}°，Hips 位移 ${(maxHipsDelta * 1000).toFixed(1)}mm`,
    );
    if (!armMoved) check(false, `${clipId} 双臂骨骼随时间变化`);
    if (clipId === 'walk-01' && !hipsMoved) check(false, 'walk-01 Hips 位置随时间变化');
  }
  mixer.stopAllAction();
  check(animOk, '预置动作驱动有效（双臂旋转 / Hips 位移随时间变化）');

  // 3. rig-mapping 姿态驱动（合成抬手帧）
  const calibration = calibrate([makeFrame(T_POSE), makeFrame(T_POSE)]);
  const raised = makeFrame({ ...T_POSE, right_elbow: [0.4, 0.2], right_wrist: [0.4, 0.08] });
  const rotations = mapPoseFrameToBoneRotations(raised, calibration);
  check(!!rotations.RightUpperArm, 'mapPoseFrameToBoneRotations 输出 RightUpperArm');

  const armR = imported.rigMap.get('RightUpperArm');
  const handR = imported.rigMap.get('RightHand');
  imported.root.updateMatrixWorld(true);
  const qBefore = armR.quaternion.clone();
  const handYBefore = handR.getWorldPosition(new Vector3()).y;
  applyBoneRotations(imported.driver, rotations);
  imported.root.updateMatrixWorld(true);
  const angleDelta = qBefore.angleTo(armR.quaternion);
  const handYAfter = handR.getWorldPosition(new Vector3()).y;
  check(angleDelta > 0.05, `RightUpperArm 旋转生效（角位移 ${(angleDelta * 180 / Math.PI).toFixed(1)}°）`);
  check(handYAfter > handYBefore, `右手腕世界 y 增大（${handYBefore.toFixed(3)} → ${handYAfter.toFixed(3)}，方向不颠倒）`);
}

console.log(failed ? '\n校验失败 ✗' : '\n全部校验通过 ✓');
process.exit(failed ? 1 : 0);
