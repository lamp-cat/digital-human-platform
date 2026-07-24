#!/usr/bin/env node
/**
 * 端到端离线校验：VRM 人物的手指驱动链路。
 *
 * 运行：npx vite-node scripts/verify-hand-drive.mjs
 * 前提：后端运行在 :8000（种子账号 demo@dhp.local / demo123456）。
 *
 * 校验内容（Seed-san = VRM 1.0，五指齐全）：
 * 1. 登录拿 token，取签名 modelUrl，fetch 模型字节并剥离贴图（Node 无法解码图片）；
 * 2. 走与运行时相同的 loadImportedAvatarFromBuffer → rigMap 含 ≥20 根手指扩展骨骼；
 * 3. 合成「右手握拳」HandFrame → mapHandFrameToBoneRotations → applyBoneRotations；
 * 4. 右食指尖（RightIndexDistal）相对掌心（RightHand）距离明显收缩，左手指纹丝不动。
 */
import { Quaternion, Vector3 } from 'three';
import { loadImportedAvatarFromBuffer } from '../packages/avatar-runtime/src/imported.ts';
import { applyBoneRotations } from '../packages/avatar-runtime/src/rig-driver.ts';
import { mapHandFrameToBoneRotations } from '../packages/rig-mapping/src/index.ts';
import { FINGER_EXTENSION_BONES } from '../packages/avatar-schema/src/hand.ts';

const API = process.env.DHP_API ?? 'http://localhost:8000';
const EMAIL = 'demo@dhp.local';
const PASSWORD = 'demo123456';

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

/** 剥离贴图引用并重打包 GLB（与 verify-imported-drive.mjs 相同做法）。 */
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

// ---------- 合成 HandFrame（平台世界坐标：角色面向 +Z、右手 -X、掌心 -Y） ----------
function rot(v, axis, deg) {
  const q = new Quaternion().setFromAxisAngle(new Vector3(...axis).normalize(), (deg * Math.PI) / 180);
  return new Vector3(...v).applyQuaternion(q);
}

const FINGERS = ['index_finger', 'middle_finger', 'ring_finger', 'pinky'];

/** 张开右手（f=-X、拇指 +Z、掌心 -Y）。 */
function openRight() {
  const pts = { wrist: new Vector3(0, 0, 0) };
  const mcps = {
    index_finger: [-0.085, 0, 0.025],
    middle_finger: [-0.09, 0, 0],
    ring_finger: [-0.085, 0, -0.012],
    pinky: [-0.078, 0, -0.025],
  };
  for (const [prefix, m] of Object.entries(mcps)) {
    pts[`${prefix}_mcp`] = new Vector3(...m);
    pts[`${prefix}_pip`] = new Vector3(m[0] - 0.03, m[1], m[2]);
    pts[`${prefix}_dip`] = new Vector3(m[0] - 0.055, m[1], m[2]);
    pts[`${prefix}_tip`] = new Vector3(m[0] - 0.075, m[1], m[2]);
  }
  const thumbDir = new Vector3(-0.3, 0, 1).normalize();
  const cmc = new Vector3(-0.02, 0, 0.03);
  pts.thumb_cmc = cmc;
  pts.thumb_mcp = cmc.clone().addScaledVector(thumbDir, 0.03);
  pts.thumb_ip = pts.thumb_mcp.clone().addScaledVector(thumbDir, 0.025);
  pts.thumb_tip = pts.thumb_ip.clone().addScaledVector(thumbDir, 0.02);
  return pts;
}

/** 右手握拳：四指绕 -Z 向掌心（-Y）弯 70/110/140°，拇指绕 +X 弯 40/70/90°。 */
function fistRight() {
  const pts = openRight();
  for (const prefix of FINGERS) {
    const mcp = pts[`${prefix}_mcp`];
    const d1 = rot([-1, 0, 0], [0, 0, 1], 70); // 绕 +Z +70° 等价绕 -Z -70°
    const d2 = rot([-1, 0, 0], [0, 0, 1], 110);
    const d3 = rot([-1, 0, 0], [0, 0, 1], 140);
    pts[`${prefix}_pip`] = mcp.clone().addScaledVector(d1, 0.03);
    pts[`${prefix}_dip`] = pts[`${prefix}_pip`].clone().addScaledVector(d2, 0.025);
    pts[`${prefix}_tip`] = pts[`${prefix}_dip`].clone().addScaledVector(d3, 0.02);
  }
  const t0 = new Vector3(-0.287, 0, 0.958);
  const t1 = rot(t0, [1, 0, 0], 40).normalize(); // 右手拇指屈曲 = 绕 +X 向掌心(-Y)
  const t2 = rot(t0, [1, 0, 0], 70).normalize();
  const t3 = rot(t0, [1, 0, 0], 90).normalize();
  pts.thumb_mcp = pts.thumb_cmc.clone().addScaledVector(t1, 0.03);
  pts.thumb_ip = pts.thumb_mcp.clone().addScaledVector(t2, 0.025);
  pts.thumb_tip = pts.thumb_ip.clone().addScaledVector(t3, 0.02);
  return pts;
}

/** 世界点集 → HandFrame（wx/wy/wz 走 worldToWorld 的 (x,-y,-z) 逆变换）。 */
function makeHandFrame(pts, handedness) {
  const landmarks = Object.entries(pts).map(([name, p]) => ({
    name,
    x: p.x + 0.5,
    y: 0.5 - p.y,
    z: -p.z,
    visibility: 0.99,
    wx: p.x,
    wy: -p.y,
    wz: -p.z,
  }));
  return { timestampMs: 0, source: 'verify', hands: [{ handedness, score: 0.95, landmarks }] };
}

// ---------- 主流程 ----------
const token = await login();
console.log(`登录成功（${EMAIL}）`);

const { imports } = await apiGet('/api/v1/imports', token);
const rec = imports.find((r) => r.displayName === 'Seed-san');
if (!rec) {
  console.error('未找到 Seed-san 导入记录');
  process.exit(1);
}
const { importRecord } = await apiGet(`/api/v1/imports/${rec.id}`, token);
console.log(`\n[Seed-san] ${importRecord.originalFilename}`);

const modelRes = await fetch(
  importRecord.modelUrl.startsWith('http') ? importRecord.modelUrl : `${API}${importRecord.modelUrl}`,
  { headers: { Authorization: `Bearer ${token}` } },
);
const bytes = await modelRes.arrayBuffer();
const imported = await loadImportedAvatarFromBuffer(stripTextures(bytes), importRecord.modelUrl);

// 1. rigMap 手指扩展骨骼
const fingerBones = FINGER_EXTENSION_BONES.filter((b) => imported.rigMap.has(b));
check(fingerBones.length >= 20, `rigMap 含 ${fingerBones.length}/30 根手指扩展骨骼（要求 ≥ 20）`);
console.log(`    手指骨骼：${fingerBones.slice(0, 6).join(', ')} …`);

// 2. 右手握拳 → 映射 → 写入
const rigBones = new Set(imported.rigMap.keys());
const fist = makeHandFrame(fistRight(), 'right');
const { rotations, present, curls } = mapHandFrameToBoneRotations(fist, { rigBones });
check(present.right === true && present.left === false, '仅检出右手');
check(Object.keys(rotations).every((k) => k.startsWith('Right')), '映射输出只含右侧骨骼');
console.log(
  `    五指屈曲度：${Object.entries(curls.right)
    .map(([f, c]) => `${f}=${c.toFixed(2)}`)
    .join(' ')}`,
);

const handR = imported.rigMap.get('RightHand');
const idxR = imported.rigMap.get('RightIndexDistal');
const idxL = imported.rigMap.get('LeftIndexDistal');
const handL = imported.rigMap.get('LeftHand');
if (!handR || !idxR || !idxL || !handL) {
  check(false, '右手 Hand/IndexDistal 与左手对照骨骼均在 rigMap 中');
} else {
  imported.root.updateMatrixWorld(true);
  const distBefore = idxR.getWorldPosition(new Vector3()).distanceTo(handR.getWorldPosition(new Vector3()));
  const leftBefore = idxL.getWorldPosition(new Vector3()).distanceTo(handL.getWorldPosition(new Vector3()));
  const tipBefore = idxR.getWorldPosition(new Vector3());

  applyBoneRotations(imported.driver, rotations);
  imported.root.updateMatrixWorld(true);

  const distAfter = idxR.getWorldPosition(new Vector3()).distanceTo(handR.getWorldPosition(new Vector3()));
  const leftAfter = idxL.getWorldPosition(new Vector3()).distanceTo(handL.getWorldPosition(new Vector3()));
  const tipDelta = idxR.getWorldPosition(new Vector3()).distanceTo(tipBefore);
  const shrink = (distBefore - distAfter) / distBefore;
  console.log(
    `    右食指尖-掌心距离：${(distBefore * 1000).toFixed(1)}mm → ${(distAfter * 1000).toFixed(1)}mm（收缩 ${(shrink * 100).toFixed(0)}%），指尖位移 ${(tipDelta * 1000).toFixed(1)}mm`,
  );
  console.log(
    `    左食指尖-掌心距离：${(leftBefore * 1000).toFixed(1)}mm → ${(leftAfter * 1000).toFixed(1)}mm（应不变）`,
  );
  check(tipDelta > 0.02, '右手握拳后指尖发生明显位移（> 20mm）');
  check(shrink > 0.25, '指尖相对掌心距离明显收缩（> 25%）');
  check(Math.abs(leftAfter - leftBefore) < 1e-6, '左手指完全不动（|Δ| < 1e-6）');
}

console.log(failed ? '\n校验失败 ✗' : '\n全部校验通过 ✓');
process.exit(failed ? 1 : 0);
