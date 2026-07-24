import { Matrix4, Quaternion, Vector3 } from 'three';
import type { ExtendedRigBone, HandData, HandFrame } from '@dhp/avatar-schema';
import { landmarkToWorld } from './coords.js';
import { clampQuaternionAngle } from './mapper.js';

/**
 * 手部关键点 → 骨骼旋转（v2 绝对方向风格，与姿态映射同一语义）：
 * - 手掌朝向：wrist→middle_mcp 为掌心方向、index_mcp→pinky_mcp 为掌横轴，
 *   构建手掌坐标系，输出 Hand 骨骼的世界系旋转增量（相对绑定姿态，限幅防翻转）；
 * - 手指屈伸：每指三段关节方向相对「手掌当前朝向下的绑定参考方向」的有符号夹角，
 *   绕掌横轴（拇指绕掌纵轴）旋转写入 Proximal/Intermediate/Distal；
 * - 只输出 rigBones 集合里存在的骨骼（内置底模无手指骨骼 → 自动跳过）。
 *
 * 镜像语义：始终 mirror=false（解剖学对应，用户右手 → 数字人右手）。
 * HandFrame.handedness 已在 vision-runtime 完成「前置未镜像画面 → 解剖学」转换。
 */

export type ExtendedBoneRotationMap = Partial<
  Record<ExtendedRigBone, { x: number; y: number; z: number; w: number }>
>;

export interface MapHandOptions {
  /** 整只手的置信度阈值，默认 0.5 */
  scoreThreshold?: number;
  /** 关键点可见性阈值，默认 0.4（MediaPipe 手部关键点一般无 visibility，按 1 处理） */
  visibilityThreshold?: number;
  /** 手掌相对绑定姿态的最大转角（度），默认 150（防止坏帧整手翻转） */
  maxHandTurnDeg?: number;
  /** 四指单关节最大屈曲角（度），默认 120 */
  maxCurlDeg?: number;
  /** 拇指单关节最大屈曲角（度），默认 100 */
  maxThumbCurlDeg?: number;
  /** 允许的过伸角（度，负方向），默认 15 */
  hyperextendDeg?: number;
  /** 合理掌宽范围（worldLandmarks 米制；回退图像坐标时同样可过滤塌缩坏帧）。 */
  minPalmSpan?: number;
  maxPalmSpan?: number;
  /** 只输出该集合内的骨骼（一般为人物 rigMap 键集），缺省不过滤 */
  rigBones?: ReadonlySet<string>;
}

const DEG = Math.PI / 180;
const IDENTITY = new Quaternion();

type Side = 'left' | 'right';

/** 解剖学 T-Pose（面向 +Z、掌心向下）下，手掌绑定坐标系的常量方向。 */
const SIDE_BIND = {
  left: {
    sign: 1,
    f: new Vector3(1, 0, 0), // 掌心方向（wrist→middle_mcp）
    u: new Vector3(0, 0, -1), // 掌横轴（index_mcp→pinky_mcp）
    thumbRef: new Vector3(0, 0, 1), // 拇指伸展参考方向
  },
  right: {
    sign: -1,
    f: new Vector3(-1, 0, 0),
    u: new Vector3(0, 0, -1),
    thumbRef: new Vector3(0, 0, 1),
  },
} as const;

/** 手指定义：VRM 骨名段 + MediaPipe 关键点链（近→远）。 */
const FINGER_DEFS = [
  { finger: 'Thumb', chain: ['thumb_cmc', 'thumb_mcp', 'thumb_ip', 'thumb_tip'] },
  { finger: 'Index', chain: ['index_finger_mcp', 'index_finger_pip', 'index_finger_dip', 'index_finger_tip'] },
  { finger: 'Middle', chain: ['middle_finger_mcp', 'middle_finger_pip', 'middle_finger_dip', 'middle_finger_tip'] },
  { finger: 'Ring', chain: ['ring_finger_mcp', 'ring_finger_pip', 'ring_finger_dip', 'ring_finger_tip'] },
  { finger: 'Little', chain: ['pinky_mcp', 'pinky_pip', 'pinky_dip', 'pinky_tip'] },
] as const;
const JOINT_NAMES = ['Proximal', 'Intermediate', 'Distal'] as const;

/** 放松微屈（手丢失时的回退姿态）：四指 15°、拇指 10°。 */
const RELAX_CURL_DEG = 15;
const RELAX_THUMB_CURL_DEG = 10;

/** 由掌心方向 f 与掌横轴 u 构建手掌坐标系（返回四元数与各轴）。 */
function palmFrame(f: Vector3, u: Vector3, sign: 1 | -1) {
  const fn = f.clone().normalize();
  // 掌心外法线：左手 u×f，右手取反（双手互为镜像，叉积方向相反）
  const n = u.clone().cross(fn).normalize().multiplyScalar(sign);
  const t = n.clone().cross(fn).normalize(); // 第三轴（横向）
  const m = new Matrix4().makeBasis(t, fn, n);
  return { quat: new Quaternion().setFromRotationMatrix(m), f: fn, n, t };
}

/** 有符号夹角：from → to 绕 axis（度）。 */
function signedAngleDeg(from: Vector3, to: Vector3, axis: Vector3): number {
  const cross = from.clone().cross(to);
  return Math.atan2(cross.dot(axis), from.dot(to)) / DEG;
}

interface HandPoints {
  get(name: string): Vector3 | null;
}

function makePointGetter(hand: HandData, visibilityThreshold: number): HandPoints {
  const map = new Map(hand.landmarks.map((lm) => [lm.name, lm]));
  return {
    get(name: string) {
      const lm = map.get(name);
      if (!lm || (lm.visibility ?? 1) < visibilityThreshold) return null;
      // 手部只认解剖学对应（mirror=false）；worldLandmarks 优先（米制、深度稳）
      return landmarkToWorld(lm, false);
    },
  };
}

/** 单手映射（纯函数）：返回该侧 Hand 与手指骨骼的世界系旋转增量。 */
function mapOneHand(
  hand: HandData,
  side: Side,
  opts: Required<Omit<MapHandOptions, 'rigBones' | 'scoreThreshold'>>,
): { rotations: ExtendedBoneRotationMap; curls: Record<string, number> } {
  const {
    visibilityThreshold,
    maxHandTurnDeg,
    maxCurlDeg,
    maxThumbCurlDeg,
    hyperextendDeg,
    minPalmSpan,
    maxPalmSpan,
  } = opts;
  const bind = SIDE_BIND[side];
  const sidePrefix = side === 'left' ? 'Left' : 'Right';
  const point = makePointGetter(hand, visibilityThreshold).get;

  const rotations: ExtendedBoneRotationMap = {};
  const curls: Record<string, number> = {};

  // ---- 手掌坐标系（当前帧） ----
  const wrist = point('wrist');
  const middleMcp = point('middle_finger_mcp');
  const indexMcp = point('index_finger_mcp');
  const pinkyMcp = point('pinky_mcp');
  if (!wrist || !middleMcp || !indexMcp || !pinkyMcp) return { rotations, curls };
  const fCur = middleMcp.clone().sub(wrist);
  const uCur = pinkyMcp.clone().sub(indexMcp);
  if (fCur.lengthSq() < 1e-12 || uCur.lengthSq() < 1e-12) return { rotations, curls };
  const palmSpan = uCur.length();
  if (palmSpan < minPalmSpan || palmSpan > maxPalmSpan) return { rotations, curls };

  const cur = palmFrame(fCur, uCur, bind.sign);
  const bindFrame = palmFrame(bind.f.clone(), bind.u.clone(), bind.sign);

  // Hand 骨骼世界增量 = 当前掌系 ⊗ 绑定掌系⁻¹（限幅防翻转）
  const handDelta = bindFrame.quat.clone().invert().premultiply(cur.quat);
  clampQuaternionAngle(handDelta, maxHandTurnDeg * DEG);
  rotations[`${sidePrefix}Hand` as ExtendedRigBone] = {
    x: handDelta.x, y: handDelta.y, z: handDelta.z, w: handDelta.w,
  };

  // ---- 手指屈伸 ----
  for (const def of FINGER_DEFS) {
    const isThumb = def.finger === 'Thumb';
    // 关节旋转轴 / 伸展参考方向（绑定姿态世界方向，随当前手掌一起转）
    const axisBind = isThumb ? bind.f.clone() : bindFrame.t.clone();
    const refBind = isThumb ? bind.thumbRef.clone() : bind.f.clone();
    const axisCur = axisBind.clone().applyQuaternion(handDelta);
    const refCur = refBind.clone().applyQuaternion(handDelta);

    const pts = def.chain.map((name) => point(name));
    const fingerCurls: number[] = [];
    for (let j = 0; j < 3; j++) {
      const boneName = `${sidePrefix}${def.finger}${JOINT_NAMES[j]}` as ExtendedRigBone;
      const a = pts[j];
      const b = pts[j + 1];
      if (!a || !b) {
        fingerCurls.push(0);
        continue;
      }
      const seg = b.clone().sub(a);
      if (seg.lengthSq() < 1e-12) {
        fingerCurls.push(0);
        continue;
      }
      seg.normalize();
      // 相对「随手掌转动的绑定参考」的有符号夹角。
      // 屈曲正方向：四指为负角（双手一致）；拇指因 flexion 轴（掌纵轴 f）随手性
      // 翻转，左手为正角、右手为负角 —— 用 bind.sign 统一换算成「屈曲为正」。
      const bend = signedAngleDeg(refCur, seg, axisCur);
      const maxCurlDegVal = isThumb ? maxThumbCurlDeg : maxCurlDeg;
      const flexSign = isThumb ? bind.sign : -1;
      const flex = bend * flexSign;
      const clampedFlex = Math.min(Math.max(flex, -hyperextendDeg), maxCurlDegVal);
      const appliedBend = clampedFlex * flexSign;
      const q = new Quaternion().setFromAxisAngle(axisCur, appliedBend * DEG).multiply(handDelta);
      rotations[boneName] = { x: q.x, y: q.y, z: q.z, w: q.w };
      fingerCurls.push(Math.min(Math.max(clampedFlex / maxCurlDegVal, 0), 1));
    }
    curls[def.finger.toLowerCase()] = Math.max(...fingerCurls);
  }

  return { rotations, curls };
}

/** 放松微屈姿态（单手，绑定朝向）：手丢失时手指平滑回到的目标。 */
function buildRelaxRotations(side: Side, opts: { maxCurlDeg: number; maxThumbCurlDeg: number }): ExtendedBoneRotationMap {
  const bind = SIDE_BIND[side];
  const sidePrefix = side === 'left' ? 'Left' : 'Right';
  const bindFrame = palmFrame(bind.f.clone(), bind.u.clone(), bind.sign);
  const rotations: ExtendedBoneRotationMap = {};
  for (const def of FINGER_DEFS) {
    const isThumb = def.finger === 'Thumb';
    const axis = isThumb ? bind.f.clone() : bindFrame.t.clone();
    const curlDeg = Math.min(isThumb ? RELAX_THUMB_CURL_DEG : RELAX_CURL_DEG, isThumb ? opts.maxThumbCurlDeg : opts.maxCurlDeg);
    // 屈曲正方向与 mapOneHand 一致（四指负角、拇指随手性）
    const flexSign = isThumb ? bind.sign : -1;
    const appliedBend = curlDeg * flexSign;
    for (const joint of JOINT_NAMES) {
      const boneName = `${sidePrefix}${def.finger}${joint}` as ExtendedRigBone;
      const q = new Quaternion().setFromAxisAngle(axis, appliedBend * DEG);
      rotations[boneName] = { x: q.x, y: q.y, z: q.z, w: q.w };
    }
  }
  return rotations;
}

/** 按权重把每根骨骼旋转向目标图混合（w=1 完全取 target）。 */
function blendRotationMaps(
  from: ExtendedBoneRotationMap,
  target: ExtendedBoneRotationMap,
  w: number,
): ExtendedBoneRotationMap {
  if (w <= 0) return { ...from };
  const out: ExtendedBoneRotationMap = {};
  const keys = new Set([...Object.keys(from), ...Object.keys(target)] as ExtendedRigBone[]);
  for (const bone of keys) {
    const qa = from[bone];
    const qb = target[bone];
    const a = qa ? new Quaternion(qa.x, qa.y, qa.z, qa.w) : IDENTITY.clone();
    const b = qb ? new Quaternion(qb.x, qb.y, qb.z, qb.w) : IDENTITY.clone();
    const m = a.slerp(b, w);
    out[bone] = { x: m.x, y: m.y, z: m.z, w: m.w };
  }
  return out;
}

export interface HandFrameMappingResult {
  rotations: ExtendedBoneRotationMap;
  /** 该帧中置信度达标的手（UI 状态显示用）。 */
  present: Record<Side, boolean>;
  /** 五指屈曲度 0–1（测试与调试用；拇指含对掌）。 */
  curls: Record<Side, Record<string, number>>;
}

/**
 * 单帧 HandFrame → 骨骼旋转（纯函数，不做丢失平滑；平滑见 HandDriveManager）。
 * 只输出 rigBones 里存在的骨骼。
 */
export function mapHandFrameToBoneRotations(
  frame: HandFrame,
  opts: MapHandOptions = {},
): HandFrameMappingResult {
  const scoreThreshold = opts.scoreThreshold ?? 0.5;
  const subOpts = {
    visibilityThreshold: opts.visibilityThreshold ?? 0.4,
    maxHandTurnDeg: opts.maxHandTurnDeg ?? 150,
    maxCurlDeg: opts.maxCurlDeg ?? 120,
    maxThumbCurlDeg: opts.maxThumbCurlDeg ?? 100,
    hyperextendDeg: opts.hyperextendDeg ?? 15,
    minPalmSpan: opts.minPalmSpan ?? 0.018,
    maxPalmSpan: opts.maxPalmSpan ?? 0.25,
  };
  const allow = (bone: ExtendedRigBone) => !opts.rigBones || opts.rigBones.has(bone);

  const rotations: ExtendedBoneRotationMap = {};
  const present: Record<Side, boolean> = { left: false, right: false };
  const curls: HandFrameMappingResult['curls'] = { left: {}, right: {} };

  for (const hand of frame.hands) {
    const side = hand.handedness;
    if (hand.score < scoreThreshold || hand.landmarks.length === 0) continue;
    const mapped = mapOneHand(hand, side, subOpts);
    for (const [bone, q] of Object.entries(mapped.rotations) as [ExtendedRigBone, NonNullable<ExtendedBoneRotationMap[ExtendedRigBone]>][]) {
      if (allow(bone)) rotations[bone] = q;
    }
    present[side] = true;
    curls[side] = mapped.curls;
  }
  return { rotations, present, curls };
}

/** 五指屈曲度（0=伸展，1=完全屈曲），供测试与 UI 调试。 */
export function computeHandCurls(frame: HandFrame, opts: MapHandOptions = {}): Record<Side, Record<string, number>> {
  return mapHandFrameToBoneRotations(frame, opts).curls;
}

export interface HandDriveOptions extends MapHandOptions {
  /** 手丢失后短暂容忍（沿用最近可信姿态），默认 400ms */
  freezeDelayMs?: number;
  /** 回退到放松微屈的混合时长，默认 800ms */
  blendDurationMs?: number;
  /** 四元数低通时间常数，默认 45ms。 */
  temporalSmoothingMs?: number;
  /** 单骨骼最大角速度，默认 900°/s，用于抑制翻转坏帧。 */
  maxAngularVelocityDegPerSec?: number;
  /** 小于该角度的抖动保持上一姿态，默认 0.6°。 */
  rotationDeadbandDeg?: number;
}

/**
 * 手部驱动状态机（每侧手独立）：
 * - 检出正常 → 输出当帧映射；
 * - 丢失 < freezeDelay → 沿用最近可信姿态；
 * - 之后按 blendDuration 平滑混合到「放松微屈绑定姿态」（不定格、不跳变）。
 */
export class HandDriveManager {
  private freezeDelayMs: number;
  private blendDurationMs: number;
  private states: Record<Side, {
    lastGood: ExtendedBoneRotationMap;
    lastGoodMs: number | null;
    lastOutput: ExtendedBoneRotationMap;
    lastOutputMs: number | null;
  }> = {
    left: { lastGood: {}, lastGoodMs: null, lastOutput: {}, lastOutputMs: null },
    right: { lastGood: {}, lastGoodMs: null, lastOutput: {}, lastOutputMs: null },
  };

  constructor(private opts: HandDriveOptions = {}) {
    this.freezeDelayMs = opts.freezeDelayMs ?? 400;
    this.blendDurationMs = opts.blendDurationMs ?? 800;
  }

  /** 每帧调用；frame 可为 null（本帧两只手都未检出）。 */
  update(frame: HandFrame | null, nowMs: number): ExtendedBoneRotationMap {
    const mapped = mapHandFrameToBoneRotations(
      frame ?? { timestampMs: nowMs, source: 'none', hands: [] },
      this.opts,
    );
    const out: ExtendedBoneRotationMap = {};
    for (const side of ['left', 'right'] as Side[]) {
      const state = this.states[side];
      const sideBones = (map: ExtendedBoneRotationMap) =>
        Object.fromEntries(
          Object.entries(map).filter(([bone]) =>
            side === 'left' ? bone.startsWith('Left') : bone.startsWith('Right'),
          ),
        ) as ExtendedBoneRotationMap;

      if (mapped.present[side]) {
        state.lastGood = this.stabilizeRotations(state, sideBones(mapped.rotations), nowMs);
        state.lastGoodMs = nowMs;
        Object.assign(out, state.lastGood);
        continue;
      }
      if (state.lastGoodMs === null) continue; // 从未检出过：不输出（保持绑定姿态）
      const dt = nowMs - state.lastGoodMs;
      if (dt < this.freezeDelayMs) {
        Object.assign(out, state.lastGood);
        continue;
      }
      const w = Math.min(1, (dt - this.freezeDelayMs) / this.blendDurationMs);
      const relax = buildRelaxRotations(side, {
        maxCurlDeg: this.opts.maxCurlDeg ?? 120,
        maxThumbCurlDeg: this.opts.maxThumbCurlDeg ?? 100,
      });
      const allowedRelax = Object.fromEntries(
        Object.entries(relax).filter(([bone]) => !this.opts.rigBones || this.opts.rigBones.has(bone)),
      ) as ExtendedBoneRotationMap;
      // Hand 骨骼向单位旋转（绑定朝向）混合，手指向微屈混合
      const target: ExtendedBoneRotationMap = {
        ...allowedRelax,
        [`${side === 'left' ? 'Left' : 'Right'}Hand` as ExtendedRigBone]: { x: 0, y: 0, z: 0, w: 1 },
      };
      Object.assign(out, blendRotationMaps(state.lastGood, target, w));
    }
    return out;
  }

  reset(): void {
    this.states = {
      left: { lastGood: {}, lastGoodMs: null, lastOutput: {}, lastOutputMs: null },
      right: { lastGood: {}, lastGoodMs: null, lastOutput: {}, lastOutputMs: null },
    };
  }

  private stabilizeRotations(
    state: {
      lastGood: ExtendedBoneRotationMap;
      lastGoodMs: number | null;
      lastOutput: ExtendedBoneRotationMap;
      lastOutputMs: number | null;
    },
    target: ExtendedBoneRotationMap,
    nowMs: number,
  ): ExtendedBoneRotationMap {
    if (state.lastOutputMs === null) {
      state.lastOutput = { ...target };
      state.lastOutputMs = nowMs;
      return { ...target };
    }
    const dt = Math.max((nowMs - state.lastOutputMs) / 1000, 1 / 120);
    const tau = Math.max((this.opts.temporalSmoothingMs ?? 45) / 1000, 1e-3);
    const baseAlpha = 1 - Math.exp(-dt / tau);
    const maxStep = (this.opts.maxAngularVelocityDegPerSec ?? 900) * DEG * dt;
    const deadband = (this.opts.rotationDeadbandDeg ?? 0.6) * DEG;
    const output: ExtendedBoneRotationMap = {};

    for (const [bone, value] of Object.entries(target) as [
      ExtendedRigBone,
      NonNullable<ExtendedBoneRotationMap[ExtendedRigBone]>,
    ][]) {
      const previousValue = state.lastOutput[bone];
      if (!previousValue) {
        output[bone] = value;
        continue;
      }
      const previous = new Quaternion(
        previousValue.x,
        previousValue.y,
        previousValue.z,
        previousValue.w,
      ).normalize();
      let next = new Quaternion(value.x, value.y, value.z, value.w).normalize();
      const dot = Math.min(1, Math.abs(previous.dot(next)));
      const angle = 2 * Math.acos(dot);
      if (angle <= deadband) {
        next = previous;
      } else if (angle > maxStep) {
        next = previous.clone().slerp(next, maxStep / angle);
      }
      // 大动作提高响应，静态/小动作保持更强平滑。
      const motionBoost = Math.min(0.72, angle / (35 * DEG));
      const alpha = Math.min(1, baseAlpha + (1 - baseAlpha) * motionBoost);
      const smoothed = previous.slerp(next, alpha);
      output[bone] = { x: smoothed.x, y: smoothed.y, z: smoothed.z, w: smoothed.w };
    }
    state.lastOutput = output;
    state.lastOutputMs = nowMs;
    return output;
  }
}
