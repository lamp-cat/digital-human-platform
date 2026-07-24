import {
  AnimationClip,
  Euler,
  Object3D,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
} from 'three';
import {
  RIG_HIERARCHY,
  STANDARD_RIG_BONES,
  type StandardRigBone,
} from '@dhp/avatar-schema';
import { BONE_LOCAL_POSITIONS } from './skeleton.js';

/** 预置动作 id。 */
export const PRESET_ANIMATION_IDS = [
  'idle-01',
  'wave-01',
  'walk-01',
  'sit-down-01',
  'stand-up-01',
  'belly-laugh-01',
  'cheer-01',
  'bow-01',
] as const;
export type PresetAnimationId = (typeof PRESET_ANIMATION_IDS)[number];

export const PRESET_ANIMATION_DEFINITIONS: readonly {
  id: PresetAnimationId;
  label: string;
  loop: boolean;
  stance: 'standing' | 'seated' | 'transition';
}[] = [
  { id: 'idle-01', label: '待机', loop: true, stance: 'standing' },
  { id: 'wave-01', label: '右手挥手', loop: true, stance: 'standing' },
  { id: 'walk-01', label: '走路', loop: true, stance: 'standing' },
  { id: 'sit-down-01', label: '坐下', loop: false, stance: 'transition' },
  { id: 'stand-up-01', label: '站起', loop: false, stance: 'transition' },
  { id: 'belly-laugh-01', label: '捧腹大笑', loop: true, stance: 'standing' },
  { id: 'cheer-01', label: '欢呼', loop: true, stance: 'standing' },
  { id: 'bow-01', label: '鞠躬', loop: true, stance: 'standing' },
] as const;

export const PRESET_ANIMATION_PLAYBACK = Object.fromEntries(
  PRESET_ANIMATION_DEFINITIONS.map(({ id, loop }) => [id, { loop }]),
) as Record<PresetAnimationId, { loop: boolean }>;

const DEG = Math.PI / 180;
const LEFT_ARM_RELAXED_Z = -72;
const RIGHT_ARM_RELAXED_Z = 72;
const LEFT_ARM_RAISED_Z = 58;
const RIGHT_ARM_RAISED_Z = -58;

function quatOf(xDeg: number, yDeg: number, zDeg: number): Quaternion {
  return new Quaternion().setFromEuler(new Euler(xDeg * DEG, yDeg * DEG, zDeg * DEG));
}

/** 以欧拉角（度）序列生成四元数轨道。 */
function quatTrack(bone: StandardRigBone, times: number[], eulers: [number, number, number][]): QuaternionKeyframeTrack {
  const values: number[] = [];
  for (const [x, y, z] of eulers) {
    const q = quatOf(x, y, z);
    values.push(q.x, q.y, q.z, q.w);
  }
  return new QuaternionKeyframeTrack(`${bone}.quaternion`, times, values);
}

function vecTrack(bone: StandardRigBone, times: number[], positions: [number, number, number][]): VectorKeyframeTrack {
  const values: number[] = [];
  for (const [x, y, z] of positions) values.push(x, y, z);
  return new VectorKeyframeTrack(`${bone}.position`, times, values);
}

const HIPS_POS = BONE_LOCAL_POSITIONS.Hips;

/** 待机：呼吸式脊柱起伏与手臂微摆，3s 循环。 */
function makeIdleClip(): AnimationClip {
  const tracks = [
    quatTrack('Spine', [0, 1.5, 3], [[0, 0, 0], [1.5, 0, 0], [0, 0, 0]]),
    quatTrack('Chest', [0, 1.5, 3], [[0, 0, 0], [2, 0, 0], [0, 0, 0]]),
    quatTrack('LeftUpperArm', [0, 1.5, 3], [
      [0, 0, LEFT_ARM_RELAXED_Z],
      [1, 0, -69],
      [0, 0, LEFT_ARM_RELAXED_Z],
    ]),
    quatTrack('RightUpperArm', [0, 1.5, 3], [
      [0, 0, RIGHT_ARM_RELAXED_Z],
      [1, 0, 69],
      [0, 0, RIGHT_ARM_RELAXED_Z],
    ]),
    quatTrack('LeftLowerArm', [0, 1.5, 3], [[0, 0, -8], [0, 0, -11], [0, 0, -8]]),
    quatTrack('RightLowerArm', [0, 1.5, 3], [[0, 0, 8], [0, 0, 11], [0, 0, 8]]),
    vecTrack('Hips', [0, 1.5, 3], [
      HIPS_POS,
      [HIPS_POS[0], HIPS_POS[1] - 0.005, HIPS_POS[2]],
      HIPS_POS,
    ]),
  ];
  return new AnimationClip('idle-01', 3, tracks);
}

/** 右手挥手：始终保持在人物自身右侧，不越过身体中线。 */
function makeWaveClip(): AnimationClip {
  const t = [0, 0.35, 1.7, 2];
  const tracks = [
    quatTrack('LeftUpperArm', t, [
      [0, 0, LEFT_ARM_RELAXED_Z],
      [0, 0, LEFT_ARM_RELAXED_Z],
      [0, 0, LEFT_ARM_RELAXED_Z],
      [0, 0, LEFT_ARM_RELAXED_Z],
    ]),
    // 右臂从自然下垂转到右上方。旧值 -140° 会把右臂甩到人物左侧。
    quatTrack('RightUpperArm', t, [
      [0, 0, RIGHT_ARM_RELAXED_Z],
      [0, 0, RIGHT_ARM_RAISED_Z],
      [0, 0, RIGHT_ARM_RAISED_Z],
      [0, 0, RIGHT_ARM_RELAXED_Z],
    ]),
    // 前臂来回摆动（挥手）
    quatTrack(
      'RightLowerArm',
      [0, 0.35, 0.65, 0.95, 1.25, 1.55, 2],
      [[0, 0, 8], [0, 0, -24], [0, 0, -46], [0, 0, -24], [0, 0, -46], [0, 0, -24], [0, 0, 8]],
    ),
    // 头部轻微向人物右侧（画面左侧）回应挥手。
    quatTrack('Head', t, [[0, 0, 0], [0, 0, 6], [0, 0, 6], [0, 0, 0]]),
    quatTrack('Spine', [0, 0.35, 2], [[0, 0, 0], [0, 0, 3], [0, 0, 0]]),
  ];
  return new AnimationClip('wave-01', 2, tracks);
}

/** 走路：双腿交替 + 手臂摆动 + 轻微上下，1s 循环。 */
function makeWalkClip(): AnimationClip {
  const half = [0, 0.5, 1];
  const tracks = [
    quatTrack('LeftUpperLeg', half, [[-28, 0, 0], [28, 0, 0], [-28, 0, 0]]),
    quatTrack('RightUpperLeg', half, [[28, 0, 0], [-28, 0, 0], [28, 0, 0]]),
    quatTrack('LeftLowerLeg', half, [[10, 0, 0], [45, 0, 0], [10, 0, 0]]),
    quatTrack('RightLowerLeg', half, [[45, 0, 0], [10, 0, 0], [45, 0, 0]]),
    quatTrack('LeftUpperArm', half, [
      [22, 0, LEFT_ARM_RELAXED_Z],
      [-22, 0, LEFT_ARM_RELAXED_Z],
      [22, 0, LEFT_ARM_RELAXED_Z],
    ]),
    quatTrack('RightUpperArm', half, [
      [-22, 0, RIGHT_ARM_RELAXED_Z],
      [22, 0, RIGHT_ARM_RELAXED_Z],
      [-22, 0, RIGHT_ARM_RELAXED_Z],
    ]),
    quatTrack('Spine', half, [[2, 0, 0], [2, 0, 0], [2, 0, 0]]),
    vecTrack('Hips', [0, 0.25, 0.5, 0.75, 1], [
      HIPS_POS,
      [HIPS_POS[0], HIPS_POS[1] - 0.025, HIPS_POS[2]],
      HIPS_POS,
      [HIPS_POS[0], HIPS_POS[1] - 0.025, HIPS_POS[2]],
      HIPS_POS,
    ]),
  ];
  return new AnimationClip('walk-01', 1, tracks);
}

const SIT_TIMES = [0, 0.65, 1.35, 2.0];
const STAND_TIMES = [0, 0.65, 1.35, 2.0];

/** 坐下：全链路渐进到稳定坐姿，结尾由 LoopOnce + clampWhenFinished 保持。 */
function makeSitDownClip(): AnimationClip {
  const tracks = [
    vecTrack('Hips', SIT_TIMES, [
      HIPS_POS,
      [HIPS_POS[0], HIPS_POS[1] - 0.12, HIPS_POS[2] - 0.02],
      [HIPS_POS[0], HIPS_POS[1] - 0.38, HIPS_POS[2] - 0.06],
      [HIPS_POS[0], HIPS_POS[1] - 0.48, HIPS_POS[2] - 0.08],
    ]),
    quatTrack('Hips', SIT_TIMES, [[0, 0, 0], [4, 0, 0], [8, 0, 0], [6, 0, 0]]),
    quatTrack('Spine', SIT_TIMES, [[0, 0, 0], [4, 0, 0], [10, 0, 0], [6, 0, 0]]),
    quatTrack('Chest', SIT_TIMES, [[0, 0, 0], [2, 0, 0], [6, 0, 0], [3, 0, 0]]),
    quatTrack('LeftUpperLeg', SIT_TIMES, [[0, 0, 0], [-28, 0, 0], [-68, 0, 0], [-82, 0, 0]]),
    quatTrack('RightUpperLeg', SIT_TIMES, [[0, 0, 0], [-28, 0, 0], [-68, 0, 0], [-82, 0, 0]]),
    quatTrack('LeftLowerLeg', SIT_TIMES, [[0, 0, 0], [20, 0, 0], [58, 0, 0], [78, 0, 0]]),
    quatTrack('RightLowerLeg', SIT_TIMES, [[0, 0, 0], [20, 0, 0], [58, 0, 0], [78, 0, 0]]),
    quatTrack('LeftUpperArm', SIT_TIMES, [[0, 0, -72], [0, 0, -66], [-8, 0, -62], [-8, 0, -62]]),
    quatTrack('RightUpperArm', SIT_TIMES, [[0, 0, 72], [0, 0, 66], [-8, 0, 62], [-8, 0, 62]]),
    quatTrack('LeftLowerArm', SIT_TIMES, [[0, 0, -8], [0, 0, -24], [0, 0, -48], [0, 0, -62]]),
    quatTrack('RightLowerArm', SIT_TIMES, [[0, 0, 8], [0, 0, 24], [0, 0, 48], [0, 0, 62]]),
    quatTrack('Head', SIT_TIMES, [[0, 0, 0], [-2, 0, 0], [-5, 0, 0], [0, 0, 0]]),
  ];
  return new AnimationClip('sit-down-01', 2, tracks);
}

/** 站起：坐姿轨道严格反向，保证与坐下终态连续，不会在切换时抽动。 */
function makeStandUpClip(): AnimationClip {
  const seated = makeSitDownClip();
  const tracks = seated.tracks.map((source) => {
    const track = source.clone();
    const valueSize = track.getValueSize();
    const reversed: number[] = [];
    for (let frame = track.times.length - 1; frame >= 0; frame--) {
      const start = frame * valueSize;
      for (let i = 0; i < valueSize; i++) reversed.push(track.values[start + i]);
    }
    track.times = new Float32Array(STAND_TIMES);
    track.values = new Float32Array(reversed);
    return track;
  });
  return new AnimationClip('stand-up-01', 2, tracks);
}

/** 捧腹大笑：双手收向腹部，胸腹与头部错峰起伏。 */
function makeBellyLaughClip(): AnimationClip {
  const t = [0, 0.35, 0.7, 1.05, 1.4, 1.75, 2.1];
  return new AnimationClip('belly-laugh-01', 2.1, [
    quatTrack('LeftUpperArm', t, [
      [-8, 0, -62], [-14, 0, -68], [-8, 0, -62], [-16, 0, -70], [-8, 0, -62], [-14, 0, -68], [-8, 0, -62],
    ]),
    quatTrack('RightUpperArm', t, [
      [-8, 0, 62], [-14, 0, 68], [-8, 0, 62], [-16, 0, 70], [-8, 0, 62], [-14, 0, 68], [-8, 0, 62],
    ]),
    quatTrack('LeftLowerArm', t, [
      [0, 0, -105], [0, 0, -112], [0, 0, -105], [0, 0, -115], [0, 0, -105], [0, 0, -112], [0, 0, -105],
    ]),
    quatTrack('RightLowerArm', t, [
      [0, 0, 105], [0, 0, 112], [0, 0, 105], [0, 0, 115], [0, 0, 105], [0, 0, 112], [0, 0, 105],
    ]),
    quatTrack('Spine', t, [[8, 0, 0], [18, 0, 0], [7, 0, 0], [20, 0, 0], [7, 0, 0], [17, 0, 0], [8, 0, 0]]),
    quatTrack('Chest', t, [[4, 0, 0], [10, 0, 0], [2, 0, 0], [12, 0, 0], [2, 0, 0], [9, 0, 0], [4, 0, 0]]),
    quatTrack('Head', t, [[-10, 0, 0], [-16, 0, 2], [-8, 0, -2], [-18, 0, 2], [-8, 0, -2], [-15, 0, 2], [-10, 0, 0]]),
    vecTrack('Hips', t, [
      HIPS_POS,
      [HIPS_POS[0], HIPS_POS[1] - 0.025, HIPS_POS[2]],
      HIPS_POS,
      [HIPS_POS[0], HIPS_POS[1] - 0.03, HIPS_POS[2]],
      HIPS_POS,
      [HIPS_POS[0], HIPS_POS[1] - 0.02, HIPS_POS[2]],
      HIPS_POS,
    ]),
  ]);
}

/** 欢呼：双臂在各自身体侧上举，身体轻微弹跳。 */
function makeCheerClip(): AnimationClip {
  const t = [0, 0.35, 0.7, 1.05, 1.4];
  return new AnimationClip('cheer-01', 1.4, [
    // 旧值 ±135°/±150° 会让双臂互相穿过胸口；±58° 保持左右解剖侧。
    quatTrack('LeftUpperArm', t, [
      [0, 0, LEFT_ARM_RELAXED_Z],
      [0, 0, 38],
      [0, 0, LEFT_ARM_RAISED_Z],
      [0, 0, 38],
      [0, 0, LEFT_ARM_RELAXED_Z],
    ]),
    quatTrack('RightUpperArm', t, [
      [0, 0, RIGHT_ARM_RELAXED_Z],
      [0, 0, -38],
      [0, 0, RIGHT_ARM_RAISED_Z],
      [0, 0, -38],
      [0, 0, RIGHT_ARM_RELAXED_Z],
    ]),
    quatTrack('LeftLowerArm', t, [[0, 0, -8], [0, 0, 18], [0, 0, 8], [0, 0, 18], [0, 0, -8]]),
    quatTrack('RightLowerArm', t, [[0, 0, 8], [0, 0, -18], [0, 0, -8], [0, 0, -18], [0, 0, 8]]),
    quatTrack('Chest', t, [[0, 0, 0], [-5, 0, 0], [-8, 0, 0], [-5, 0, 0], [0, 0, 0]]),
    vecTrack('Hips', t, [
      HIPS_POS,
      [HIPS_POS[0], HIPS_POS[1] - 0.035, HIPS_POS[2]],
      [HIPS_POS[0], HIPS_POS[1] + 0.045, HIPS_POS[2]],
      [HIPS_POS[0], HIPS_POS[1] - 0.035, HIPS_POS[2]],
      HIPS_POS,
    ]),
  ]);
}

/** 鞠躬：对称上身前倾，手臂自然下垂。 */
function makeBowClip(): AnimationClip {
  const t = [0, 0.55, 1.35, 1.9];
  return new AnimationClip('bow-01', 1.9, [
    quatTrack('Hips', t, [[0, 0, 0], [18, 0, 0], [18, 0, 0], [0, 0, 0]]),
    quatTrack('Spine', t, [[0, 0, 0], [22, 0, 0], [22, 0, 0], [0, 0, 0]]),
    quatTrack('Chest', t, [[0, 0, 0], [12, 0, 0], [12, 0, 0], [0, 0, 0]]),
    quatTrack('Head', t, [[0, 0, 0], [-8, 0, 0], [-8, 0, 0], [0, 0, 0]]),
    quatTrack('LeftUpperArm', t, [[0, 0, -72], [0, 0, -68], [0, 0, -68], [0, 0, -72]]),
    quatTrack('RightUpperArm', t, [[0, 0, 72], [0, 0, 68], [0, 0, 68], [0, 0, 72]]),
  ]);
}

/** 生成全部预置动作（轨道名使用 StandardRig 骨骼名）。 */
export function createPresetClips(): Map<PresetAnimationId, AnimationClip> {
  return new Map<PresetAnimationId, AnimationClip>([
    ['idle-01', makeIdleClip()],
    ['wave-01', makeWaveClip()],
    ['walk-01', makeWalkClip()],
    ['sit-down-01', makeSitDownClip()],
    ['stand-up-01', makeStandUpClip()],
    ['belly-laugh-01', makeBellyLaughClip()],
    ['cheer-01', makeCheerClip()],
    ['bow-01', makeBowClip()],
  ]);
}

/**
 * 将轨道名中的 StandardRig 骨骼名替换为实际节点名（供导入人物复用预置动作）。
 */
export function retargetClip(clip: AnimationClip, nameMap: Map<StandardRigBone, string>): AnimationClip {
  const tracks = clip.tracks.map((track) => {
    const [boneName, ...rest] = track.name.split('.');
    const actual = nameMap.get(boneName as StandardRigBone);
    if (!actual) return track;
    const cloned = track.clone();
    cloned.name = `${actual}.${rest.join('.')}`;
    return cloned;
  });
  return new AnimationClip(clip.name, clip.duration, tracks);
}

/**
 * 将 StandardRig 动作按“世界旋转增量”重定向到任意导入骨架。
 *
 * 与只改轨道名称不同，这里先采样标准骨架的完整父子链世界旋转，再结合导入模型每根
 * 骨骼的绑定世界姿态反求目标局部四元数。这样 VRM/GLB 的 bind rotation 不为单位时，
 * 动作首帧仍严格落在其绑定姿态，不会出现换动作瞬间扭曲或抽动。
 */
export function retargetClipToRig(
  clip: AnimationClip,
  rigMap: ReadonlyMap<StandardRigBone, Object3D>,
  positionScale = 1,
): AnimationClip {
  const quaternionTracks = new Map<StandardRigBone, QuaternionKeyframeTrack>();
  const positionTracks = new Map<StandardRigBone, VectorKeyframeTrack>();
  const times = new Set<number>([0, clip.duration]);
  for (const track of clip.tracks) {
    const [boneName, property] = track.name.split('.');
    if (!(STANDARD_RIG_BONES as readonly string[]).includes(boneName)) continue;
    for (const time of track.times) times.add(time);
    if (property === 'quaternion') {
      quaternionTracks.set(boneName as StandardRigBone, track as QuaternionKeyframeTrack);
    } else if (property === 'position') {
      positionTracks.set(boneName as StandardRigBone, track as VectorKeyframeTrack);
    }
  }
  const sampleTimes = [...times].sort((a, b) => a - b);
  const quaternionInterpolants = new Map(
    [...quaternionTracks].map(([bone, track]) => [
      bone,
      track.createInterpolant(),
    ]),
  );
  const positionInterpolants = new Map(
    [...positionTracks].map(([bone, track]) => [
      bone,
      track.createInterpolant(),
    ]),
  );

  const bindWorld = new Map<StandardRigBone, Quaternion>();
  const reverseRig = new Map<Object3D, StandardRigBone>();
  for (const [bone, obj] of rigMap) {
    bindWorld.set(bone, obj.getWorldQuaternion(new Quaternion()));
    reverseRig.set(obj, bone);
  }

  const nearestMappedAncestor = (obj: Object3D): StandardRigBone | null => {
    let parent = obj.parent;
    while (parent) {
      const bone = reverseRig.get(parent);
      if (bone) return bone;
      parent = parent.parent;
    }
    return null;
  };

  const values = new Map<StandardRigBone, number[]>();
  for (const bone of rigMap.keys()) values.set(bone, []);

  for (const time of sampleTimes) {
    const standardWorld = new Map<StandardRigBone, Quaternion>();
    for (const bone of STANDARD_RIG_BONES) {
      const interpolant = quaternionInterpolants.get(bone);
      const local = interpolant
        ? new Quaternion().fromArray(interpolant.evaluate(time) as ArrayLike<number>).normalize()
        : new Quaternion();
      const parent = RIG_HIERARCHY[bone];
      const world = parent
        ? standardWorld.get(parent)!.clone().multiply(local)
        : local;
      standardWorld.set(bone, world);
    }

    for (const [bone, obj] of rigMap) {
      const boneBindWorld = bindWorld.get(bone)!;
      const desiredBoneWorld = standardWorld.get(bone)!.clone().multiply(boneBindWorld);
      const directParentBind = obj.parent?.getWorldQuaternion(new Quaternion()) ?? new Quaternion();
      const ancestorBone = nearestMappedAncestor(obj);
      let desiredParentWorld = directParentBind;
      if (ancestorBone) {
        const ancestorBindWorld = bindWorld.get(ancestorBone)!;
        const desiredAncestorWorld = standardWorld
          .get(ancestorBone)!
          .clone()
          .multiply(ancestorBindWorld);
        const helperRelative = ancestorBindWorld
          .clone()
          .invert()
          .multiply(directParentBind);
        // 若骨骼间存在未映射 helper 节点，保留它们的绑定相对朝向。
        desiredParentWorld = desiredAncestorWorld.multiply(helperRelative);
      }
      const local = desiredParentWorld.invert().multiply(desiredBoneWorld).normalize();
      values.get(bone)!.push(local.x, local.y, local.z, local.w);
    }
  }

  const tracks: (QuaternionKeyframeTrack | VectorKeyframeTrack)[] = [...rigMap].map(
    ([bone, obj]) =>
      new QuaternionKeyframeTrack(
        `${obj.name}.quaternion`,
        sampleTimes,
        values.get(bone)!,
      ),
  );

  // 位置轨道仅用于 Hips 上下移动；按人物身高比例叠加到导入模型自己的 bind position。
  const hips = rigMap.get('Hips');
  const hipsPosition = positionInterpolants.get('Hips');
  if (hips && hipsPosition) {
    const bind = hips.position.clone();
    const standardBind = new Vector3(...BONE_LOCAL_POSITIONS.Hips);
    const positionValues: number[] = [];
    for (const time of sampleTimes) {
      const sampled = new Vector3().fromArray(
        hipsPosition.evaluate(time) as ArrayLike<number>,
      );
      const target = bind.clone().add(sampled.sub(standardBind).multiplyScalar(positionScale));
      positionValues.push(target.x, target.y, target.z);
    }
    tracks.push(new VectorKeyframeTrack(`${hips.name}.position`, sampleTimes, positionValues));
  }

  return new AnimationClip(clip.name, clip.duration, tracks);
}

/** 供测试使用：轨道涉及的骨骼名集合。 */
export function clipBoneNames(clip: AnimationClip): Set<string> {
  return new Set(clip.tracks.map((t) => t.name.split('.')[0]));
}
