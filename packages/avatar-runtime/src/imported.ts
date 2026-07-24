import { Group, Object3D, Skeleton, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, type VRM, type VRMHumanBoneName } from '@pixiv/three-vrm';
import {
  FINGER_EXTENSION_BONES,
  STANDARD_RIG_BONES,
  VRM_FINGER_TO_RIG,
  VRM_HUMANOID_TO_RIG,
  type ExtendedRigBone,
  type FaceExpressionName,
  type StandardRigBone,
} from '@dhp/avatar-schema';
import { createRigDriver, type RigDriver } from './rig-driver.js';

/**
 * 外部 3D 人物导入加载（.vrm / .glb）。
 * 返回统一的骨骼驱动接口，动作模式可复用 applyBoneRotations。
 */
export interface ImportedAvatar {
  kind: 'vrm' | 'glb';
  root: Group;
  /** StandardRig（含手指扩展骨骼）→ 实际骨骼节点。 */
  rigMap: Map<ExtendedRigBone, Object3D>;
  driver: RigDriver;
  /** 第一个 SkinnedMesh 的骨架（存在时）。 */
  skeleton: Skeleton | null;
  vrm?: VRM;
  /** VRM 0.x BlendShapeGroup → 实际 morph target 绑定。 */
  legacyExpressionGroups?: Map<FaceExpressionName, MorphTargetBinding[]>;
}

export interface MorphTargetBinding {
  mesh: Object3D & { morphTargetInfluences?: number[] };
  index: number;
  /** VRM 0.x bind weight 为 0–100，进入此结构时已归一化到 0–1。 */
  scale: number;
}

/** VRM 1.0 必须保留平台直接写入的 raw human bones，禁止 normalized 骨架自动回写。 */
export const VRM_LOADER_OPTIONS = {
  autoUpdateHumanBones: false,
} as const;

/** mixamo 常见命名 → StandardRig（显式映射，不靠猜测）。 */
export const MIXAMO_TO_RIG: Record<string, StandardRigBone> = {
  mixamorigHips: 'Hips',
  mixamorigSpine: 'Spine',
  mixamorigSpine1: 'Chest',
  mixamorigSpine2: 'UpperChest',
  mixamorigNeck: 'Neck',
  mixamorigHead: 'Head',
  mixamorigLeftShoulder: 'LeftShoulder',
  mixamorigLeftArm: 'LeftUpperArm',
  mixamorigLeftForeArm: 'LeftLowerArm',
  mixamorigLeftHand: 'LeftHand',
  mixamorigRightShoulder: 'RightShoulder',
  mixamorigRightArm: 'RightUpperArm',
  mixamorigRightForeArm: 'RightLowerArm',
  mixamorigRightHand: 'RightHand',
  mixamorigLeftUpLeg: 'LeftUpperLeg',
  mixamorigLeftLeg: 'LeftLowerLeg',
  mixamorigLeftFoot: 'LeftFoot',
  mixamorigLeftToeBase: 'LeftToes',
  mixamorigRightUpLeg: 'RightUpperLeg',
  mixamorigRightLeg: 'RightLowerLeg',
  mixamorigRightFoot: 'RightFoot',
  mixamorigRightToeBase: 'RightToes',
};

/** 候选名称 → StandardRig（含手指扩展骨骼）的反查表（含大小写/冒号变体）。 */
function buildAliasTable(): Map<string, ExtendedRigBone> {
  const table = new Map<string, ExtendedRigBone>();
  const put = (alias: string, bone: ExtendedRigBone) => {
    table.set(alias, bone);
    table.set(alias.toLowerCase(), bone);
  };
  for (const bone of STANDARD_RIG_BONES) put(bone, bone);
  for (const bone of FINGER_EXTENSION_BONES) put(bone, bone);
  for (const [mixamo, bone] of Object.entries(MIXAMO_TO_RIG)) {
    put(mixamo, bone);
    put(mixamo.replace('mixamorig', 'mixamorig:'), bone);
  }
  // VRM humanoid 小驼峰名（含手指）
  for (const [vrmName, bone] of Object.entries(VRM_HUMANOID_TO_RIG)) put(vrmName, bone);
  for (const [vrmName, bone] of Object.entries(VRM_FINGER_TO_RIG)) put(vrmName, bone);
  return table;
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`模型下载失败（HTTP ${res.status}）`);
  return res.arrayBuffer();
}

/**
 * 读取 GLB 文件的 JSON chunk（.vrm 即 GLB）。非 GLB 时尝试按 .gltf JSON 解析。
 * 解析失败返回 null（调用方按默认路径处理）。
 */
export function readGlbJson(buffer: ArrayBuffer): Record<string, any> | null {
  try {
    if (buffer.byteLength >= 20) {
      const dv = new DataView(buffer);
      if (dv.getUint32(0, true) === 0x46546c67 && dv.getUint32(16, true) === 0x4e4f534a) {
        const jsonLen = dv.getUint32(12, true);
        return JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLen)));
      }
    }
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    return null;
  }
}

/**
 * 从 VRM 0.x 的 glTF JSON 提取 humanoid 骨骼映射（纯函数，可单测）。
 * 0.x 的 humanBones 是数组 [{ bone: 'hips', node: 12 }, ...]，
 * bone 名称经 VRM_HUMANOID_TO_RIG（22 根最小骨架）与 VRM_FINGER_TO_RIG
 * （手指扩展骨骼）显式映射，node 为 glTF 节点索引。
 */
export function extractVrm0RigMap(
  gltfJson: { extensions?: { VRM?: { humanoid?: { humanBones?: unknown } } } } | null | undefined,
  nodes: readonly (Object3D | undefined)[],
): Map<ExtendedRigBone, Object3D> {
  const rigMap = new Map<ExtendedRigBone, Object3D>();
  const humanBones = gltfJson?.extensions?.VRM?.humanoid?.humanBones;
  if (!Array.isArray(humanBones)) return rigMap;
  for (const entry of humanBones) {
    const boneName = (entry as { bone?: unknown } | null)?.bone;
    const nodeIndex = (entry as { node?: unknown } | null)?.node;
    if (typeof boneName !== 'string' || typeof nodeIndex !== 'number') continue;
    const rigBone: ExtendedRigBone | undefined =
      VRM_HUMANOID_TO_RIG[boneName] ?? VRM_FINGER_TO_RIG[boneName];
    const node = nodes[nodeIndex];
    if (!rigBone || !node || rigMap.has(rigBone)) continue;
    rigMap.set(rigBone, node);
  }
  return rigMap;
}

/** 按 glTF 节点索引收集已加载场景中的 Object3D（依赖 GLTFLoader 的 associations）。 */
export function collectGltfNodesByIndex(gltf: GLTF): (Object3D | undefined)[] {
  const nodes: (Object3D | undefined)[] = [];
  const visit = (obj: Object3D) => {
    const nodeIndex = gltf.parser.associations.get(obj)?.nodes;
    if (typeof nodeIndex === 'number') nodes[nodeIndex] = obj;
  };
  for (const scene of gltf.scenes) scene.traverse(visit);
  return nodes;
}

const VRM0_EXPRESSION_PRESETS: Record<string, FaceExpressionName> = {
  a: 'aa',
  aa: 'aa',
  i: 'ih',
  ih: 'ih',
  e: 'ee',
  ee: 'ee',
  o: 'oh',
  oh: 'oh',
  u: 'ou',
  ou: 'ou',
  blink: 'blink',
  blink_l: 'blinkLeft',
  blinkleft: 'blinkLeft',
  blink_r: 'blinkRight',
  blinkright: 'blinkRight',
  joy: 'happy',
  happy: 'happy',
  angry: 'angry',
  sorrow: 'sad',
  sad: 'sad',
  fun: 'relaxed',
  relaxed: 'relaxed',
  surprised: 'surprised',
  surprise: 'surprised',
  lookup: 'lookUp',
  lookdown: 'lookDown',
  lookleft: 'lookLeft',
  lookright: 'lookRight',
};

function normalizeExpressionName(name: string): string {
  return name.toLowerCase().replace(/[\s.-]+/g, '_');
}

/**
 * 解析 VRM 0.x `blendShapeMaster.blendShapeGroups`。
 * bind.mesh 指 glTF mesh 索引；通过 GLTFLoader associations 找到实际场景对象。
 */
export function extractVrm0ExpressionGroups(
  gltf: GLTF,
): Map<FaceExpressionName, MorphTargetBinding[]> {
  const result = new Map<FaceExpressionName, MorphTargetBinding[]>();
  const meshObjects = new Map<number, (Object3D & { morphTargetInfluences?: number[] })[]>();
  gltf.scene.traverse((obj) => {
    const meshIndex = gltf.parser.associations.get(obj)?.meshes;
    const morph = obj as Object3D & { morphTargetInfluences?: number[] };
    if (typeof meshIndex !== 'number' || !morph.morphTargetInfluences) return;
    const list = meshObjects.get(meshIndex) ?? [];
    list.push(morph);
    meshObjects.set(meshIndex, list);
  });

  const groups = (gltf.parser.json as {
    extensions?: {
      VRM?: {
        blendShapeMaster?: {
          blendShapeGroups?: unknown;
        };
      };
    };
  })?.extensions?.VRM?.blendShapeMaster?.blendShapeGroups;
  if (!Array.isArray(groups)) return result;

  for (const raw of groups) {
    const group = raw as {
      name?: unknown;
      presetName?: unknown;
      binds?: unknown;
    };
    const candidates = [group.presetName, group.name].filter((value): value is string => typeof value === 'string');
    let expression: FaceExpressionName | undefined;
    for (const candidate of candidates) {
      expression = VRM0_EXPRESSION_PRESETS[normalizeExpressionName(candidate)];
      if (expression) break;
    }
    if (!expression || !Array.isArray(group.binds)) continue;
    const bindings = result.get(expression) ?? [];
    for (const rawBind of group.binds) {
      const bind = rawBind as { mesh?: unknown; index?: unknown; weight?: unknown };
      if (typeof bind.mesh !== 'number' || typeof bind.index !== 'number') continue;
      for (const mesh of meshObjects.get(bind.mesh) ?? []) {
        if (
          bind.index < 0 ||
          !mesh.morphTargetInfluences ||
          bind.index >= mesh.morphTargetInfluences.length
        ) continue;
        bindings.push({
          mesh,
          index: bind.index,
          scale: Math.min(1, Math.max(0, typeof bind.weight === 'number' ? bind.weight / 100 : 1)),
        });
      }
    }
    if (bindings.length > 0) result.set(expression, bindings);
  }
  return result;
}

/**
 * VRM 0.x 坐标约定：角色面向 -Z（1.0 为面向 +Z，平台约定同 1.0）。
 * 实测样例（VRoid 官方 AvatarSample_A）：脚尖世界坐标在脚踝 -Z 侧，即背对相机。
 * 若确认背对（或无法判断，按 0.x 约定）则把模型根节点绕 Y 转 π，
 * 与 three-vrm v2 对 0.x 的处理（rotateVRM0）一致。返回是否发生了旋转。
 */
export function correctVrm0Facing(root: Object3D, rigMap: Map<ExtendedRigBone, Object3D>): boolean {
  let rotate = true; // 无法判断时按 0.x 约定（面向 -Z）处理
  const foot = rigMap.get('LeftFoot') ?? rigMap.get('RightFoot');
  const toes = rigMap.get('LeftToes') ?? rigMap.get('RightToes');
  if (foot && toes) {
    const footPos = foot.getWorldPosition(new Vector3());
    const toesPos = toes.getWorldPosition(new Vector3());
    const dz = toesPos.z - footPos.z;
    if (Math.abs(dz) > 1e-4) rotate = dz < 0;
  }
  if (rotate) {
    root.rotation.y += Math.PI;
    root.updateMatrixWorld(true);
  }
  return rotate;
}

/** 按名称在 GLB 场景里匹配骨骼（含手指扩展骨骼）。 */
function matchGlbBones(root: Object3D): Map<ExtendedRigBone, Object3D> {
  const alias = buildAliasTable();
  const rigMap = new Map<ExtendedRigBone, Object3D>();
  const maxBones = STANDARD_RIG_BONES.length + FINGER_EXTENSION_BONES.length;
  root.traverse((obj) => {
    if (rigMap.size >= maxBones) return;
    const bone = alias.get(obj.name) ?? alias.get(obj.name.toLowerCase());
    if (bone && !rigMap.has(bone)) rigMap.set(bone, obj);
  });
  return rigMap;
}

/** 模型格式判定结果。 */
export interface ModelFormatInfo {
  /** VRM 0.x（extensions.VRM，无 VRMC_vrm）。 */
  isVrm0: boolean;
  /** VRM 1.0（extensions.VRMC_vrm）。 */
  isVrm1: boolean;
}

/**
 * 按文件内容（GLB JSON chunk 的 extensions）判定 VRM 版本。
 * 平台的签名模型 URL 形如 /api/v1/imports/{id}/model?token=...，没有扩展名，
 * 所以 URL 后缀只能在内容无法判定时（JSON chunk 解析失败）作兜底提示。
 */
export function detectModelFormat(buffer: ArrayBuffer, hintUrl = ''): ModelFormatInfo {
  const gltfJson = readGlbJson(buffer);
  const isVrm0 = !!gltfJson?.extensions?.VRM && !gltfJson?.extensions?.VRMC_vrm;
  const isVrm1 = !!gltfJson?.extensions?.VRMC_vrm;
  if (isVrm0 || isVrm1) return { isVrm0, isVrm1 };
  // 内容不可判定（非 GLB / JSON 解析失败）：退回 URL 后缀提示
  return { isVrm0: false, isVrm1: /\.vrm($|[?#])/i.test(hintUrl) };
}

/**
 * 从已取得的模型字节构建 ImportedAvatar（内容嗅探为准）。
 * 浏览器与离线校验脚本共用此路径，保证行为一致。
 */
export async function loadImportedAvatarFromBuffer(
  buffer: ArrayBuffer,
  hintUrl = '',
): Promise<ImportedAvatar> {
  const { isVrm0, isVrm1 } = detectModelFormat(buffer, hintUrl);
  const isVrm = isVrm0 || isVrm1;

  const loader = new GLTFLoader();
  // three-vrm v3 的 VRMLoaderPlugin 只支持 VRM 1.0（VRMC_vrm）；
  // VRM 0.x（extensions.VRM）必须走普通 GLTFLoader，否则 humanoid 解析失败。
  if (isVrm1) {
    loader.register(
      (parser) =>
        // 默认 true 会在 vrm.update() 时把 normalized bones 回写到 raw bones，
        // 覆盖平台刚写入的头部/肢体姿态。
        new VRMLoaderPlugin(parser, VRM_LOADER_OPTIONS),
    );
  }
  // 0.x 的 MToon 材质扩展不在 extensionsRequired 中，
  // 会回退到 pbrMetallicRoughness 基础材质（显示效果可接受）。
  const gltf = await loader.parseAsync(buffer, '');

  const root = gltf.scene;
  root.updateMatrixWorld(true);

  const rigMap = new Map<ExtendedRigBone, Object3D>();
  let vrm: VRM | undefined;
  let legacyExpressionGroups: Map<FaceExpressionName, MorphTargetBinding[]> | undefined;
  if (isVrm0) {
    // VRM 0.x：手动从 extensions.VRM.humanoid.humanBones 建映射（含手指）
    const nodes = collectGltfNodesByIndex(gltf);
    const mapped = extractVrm0RigMap(gltf.parser.json, nodes);
    for (const [bone, node] of mapped) rigMap.set(bone, node);
    legacyExpressionGroups = extractVrm0ExpressionGroups(gltf);
    correctVrm0Facing(root, rigMap);
  } else if (isVrm1) {
    vrm = gltf.userData.vrm as VRM | undefined;
    if (vrm) {
      // 通过 VRM Humanoid 显式映射取骨（22 根最小骨架 + 手指扩展骨骼）
      for (const [vrmName, rigBone] of Object.entries(VRM_HUMANOID_TO_RIG)) {
        const node = vrm.humanoid.getBoneNode(vrmName as VRMHumanBoneName);
        if (node) rigMap.set(rigBone, node);
      }
      for (const [vrmName, rigBone] of Object.entries(VRM_FINGER_TO_RIG)) {
        const node = vrm.humanoid.getBoneNode(vrmName as VRMHumanBoneName);
        if (node && !rigMap.has(rigBone)) rigMap.set(rigBone, node);
      }
    }
  }
  if (rigMap.size === 0) {
    const matched = matchGlbBones(root);
    for (const [bone, node] of matched) rigMap.set(bone, node);
  }

  let skeleton: Skeleton | null = null;
  root.traverse((obj) => {
    if (!skeleton && (obj as SkinnedMesh).isSkinnedMesh) {
      skeleton = (obj as SkinnedMesh).skeleton;
    }
  });

  const driver = createRigDriver(rigMap, root);
  return {
    kind: isVrm ? 'vrm' : 'glb',
    root,
    rigMap,
    driver,
    skeleton,
    vrm,
    legacyExpressionGroups,
  };
}

/**
 * 加载 .vrm / .glb 人物模型。
 * 始终先取文件本体按内容嗅探版本：签名 URL / blob: URL 都没有扩展名，
 * 按 URL 后缀路由会让 VRM 模型走错分支（0.x 建不出骨骼映射，人物完全不动）。
 * @param url 模型地址（可为 blob: URL）
 */
export async function loadImportedAvatar(url: string): Promise<ImportedAvatar> {
  const buffer = await fetchArrayBuffer(url);
  return loadImportedAvatarFromBuffer(buffer, url);
}
