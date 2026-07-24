import {
  AnimationClip,
  Euler,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
} from 'three';
import { STANDARD_RIG_BONES, type StandardRigBone } from '@dhp/avatar-schema';
import { BONE_LOCAL_POSITIONS } from './skeleton.js';

/** 预置动作 id。 */
export const PRESET_ANIMATION_IDS = ['idle-01', 'wave-01', 'walk-01'] as const;
export type PresetAnimationId = (typeof PRESET_ANIMATION_IDS)[number];

const DEG = Math.PI / 180;

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
    quatTrack('LeftUpperArm', [0, 1.5, 3], [[0, 0, 0], [0, 0, 3], [0, 0, 0]]),
    quatTrack('RightUpperArm', [0, 1.5, 3], [[0, 0, 0], [0, 0, -3], [0, 0, 0]]),
    vecTrack('Hips', [0, 1.5, 3], [
      HIPS_POS,
      [HIPS_POS[0], HIPS_POS[1] - 0.005, HIPS_POS[2]],
      HIPS_POS,
    ]),
  ];
  return new AnimationClip('idle-01', 3, tracks);
}

/** 挥手：右臂举起挥动，2s。 */
function makeWaveClip(): AnimationClip {
  const t = [0, 0.35, 1.7, 2];
  const tracks = [
    // 右臂绕 Z 轴抬起至头顶侧
    quatTrack('RightUpperArm', t, [[0, 0, 0], [0, 0, -140], [0, 0, -140], [0, 0, 0]]),
    // 前臂来回摆动（挥手）
    quatTrack(
      'RightLowerArm',
      [0, 0.35, 0.65, 0.95, 1.25, 1.55, 2],
      [[0, 0, 0], [0, 0, -20], [0, 0, -55], [0, 0, -20], [0, 0, -55], [0, 0, -20], [0, 0, 0]],
    ),
    quatTrack('Head', t, [[0, 0, 0], [0, 0, -6], [0, 0, -6], [0, 0, 0]]),
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
    quatTrack('LeftUpperArm', half, [[22, 0, 0], [-22, 0, 0], [22, 0, 0]]),
    quatTrack('RightUpperArm', half, [[-22, 0, 0], [22, 0, 0], [-22, 0, 0]]),
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

/** 生成全部预置动作（轨道名使用 StandardRig 骨骼名）。 */
export function createPresetClips(): Map<PresetAnimationId, AnimationClip> {
  return new Map<PresetAnimationId, AnimationClip>([
    ['idle-01', makeIdleClip()],
    ['wave-01', makeWaveClip()],
    ['walk-01', makeWalkClip()],
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

/** 供测试使用：轨道涉及的骨骼名集合。 */
export function clipBoneNames(clip: AnimationClip): Set<string> {
  return new Set(clip.tracks.map((t) => t.name.split('.')[0]));
}
