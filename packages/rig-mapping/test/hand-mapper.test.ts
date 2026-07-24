import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import type { HandData, HandFrame, HandLandmark, PoseFrame } from '@dhp/avatar-schema';
import {
  HandDriveManager,
  computeHandCurls,
  mapHandFrameToBoneRotations,
} from '../src/hand-mapper.js';

/**
 * 合成手部数据（解剖学 T-Pose 手掌朝下为基准）：
 * 左手掌心方向 +X、拇指 +Z、掌心 -Y；右手为左手 x 镜像。
 * 握拳 = 各指节朝掌心（-Y）逐级弯曲。
 */

type V3 = [number, number, number];

const OPEN_LEFT: Record<string, V3> = (() => {
  const pts: Record<string, V3> = { wrist: [0, 0, 0] };
  const mcps: Record<string, V3> = {
    index_finger: [0.085, 0, 0.025],
    middle_finger: [0.09, 0, 0],
    ring_finger: [0.085, 0, -0.012],
    pinky: [0.078, 0, -0.025],
  };
  for (const [prefix, mcp] of Object.entries(mcps)) {
    pts[`${prefix}_mcp`] = mcp;
    pts[`${prefix}_pip`] = [mcp[0] + 0.03, mcp[1], mcp[2]];
    pts[`${prefix}_dip`] = [mcp[0] + 0.055, mcp[1], mcp[2]];
    pts[`${prefix}_tip`] = [mcp[0] + 0.075, mcp[1], mcp[2]];
  }
  const thumbDir = new Vector3(0.3, 0, 1).normalize();
  const cmc = new Vector3(0.02, 0, 0.03);
  pts.thumb_cmc = [cmc.x, cmc.y, cmc.z];
  const mcp = cmc.clone().addScaledVector(thumbDir, 0.03);
  const ip = mcp.clone().addScaledVector(thumbDir, 0.025);
  const tip = ip.clone().addScaledVector(thumbDir, 0.02);
  pts.thumb_mcp = [mcp.x, mcp.y, mcp.z];
  pts.thumb_ip = [ip.x, ip.y, ip.z];
  pts.thumb_tip = [tip.x, tip.y, tip.z];
  return pts;
})();

/** 绕 axis（单位向量）旋转 v 角度 deg。 */
function rot(v: V3, axis: V3, deg: number): V3 {
  const q = new Quaternion().setFromAxisAngle(new Vector3(...axis).normalize(), (deg * Math.PI) / 180);
  const r = new Vector3(...v).applyQuaternion(q);
  return [r.x, r.y, r.z];
}

const FINGERS = ['index_finger', 'middle_finger', 'ring_finger', 'pinky'] as const;

/** 握拳（左手）：四指绕 +Z 向 -Y 弯 50/100/130°，拇指绕 +X 向掌心弯 30/60/85°。 */
function fistLeft(): Record<string, V3> {
  const pts: Record<string, V3> = { ...OPEN_LEFT };
  const base = new Vector3(1, 0, 0);
  for (const prefix of FINGERS) {
    const mcp = OPEN_LEFT[`${prefix}_mcp`];
    const d1 = rot([1, 0, 0], [0, 0, 1], -50);
    const d2 = rot([1, 0, 0], [0, 0, 1], -100);
    const d3 = rot([1, 0, 0], [0, 0, 1], -130);
    const pip = new Vector3(...mcp).addScaledVector(new Vector3(...d1), 0.03);
    const dip = pip.clone().addScaledVector(new Vector3(...d2), 0.025);
    const tip = dip.clone().addScaledVector(new Vector3(...d3), 0.02);
    pts[`${prefix}_pip`] = [pip.x, pip.y, pip.z];
    pts[`${prefix}_dip`] = [dip.x, dip.y, dip.z];
    pts[`${prefix}_tip`] = [tip.x, tip.y, tip.z];
  }
  void base;
  const cmc = new Vector3(...OPEN_LEFT.thumb_cmc);
  const t1 = rot([0.287, 0, 0.958], [1, 0, 0], 30);
  const t2 = rot([0.287, 0, 0.958], [1, 0, 0], 60);
  const t3 = rot([0.287, 0, 0.958], [1, 0, 0], 85);
  const mcp = cmc.clone().addScaledVector(new Vector3(...t1).normalize(), 0.03);
  const ip = mcp.clone().addScaledVector(new Vector3(...t2).normalize(), 0.025);
  const tip = ip.clone().addScaledVector(new Vector3(...t3).normalize(), 0.02);
  pts.thumb_mcp = [mcp.x, mcp.y, mcp.z];
  pts.thumb_ip = [ip.x, ip.y, ip.z];
  pts.thumb_tip = [tip.x, tip.y, tip.z];
  return pts;
}

/** 带明显景深分量的食指弯曲：模拟斜对摄像头时单目深度导致的屈曲低估。 */
function obliqueIndexLeft(): Record<string, V3> {
  const pts: Record<string, V3> = { ...OPEN_LEFT };
  const mcp = new Vector3(...OPEN_LEFT.index_finger_mcp);
  const direction = (curlDeg: number) =>
    new Vector3(1, 0, 0)
      .applyAxisAngle(new Vector3(0, 0, 1), (-curlDeg * Math.PI) / 180)
      .applyAxisAngle(new Vector3(0, 1, 0), (40 * Math.PI) / 180)
      .normalize();
  const pip = mcp.clone().addScaledVector(direction(25), 0.03);
  const dip = pip.clone().addScaledVector(direction(55), 0.025);
  const tip = dip.clone().addScaledVector(direction(85), 0.02);
  pts.index_finger_pip = [pip.x, pip.y, pip.z];
  pts.index_finger_dip = [dip.x, dip.y, dip.z];
  pts.index_finger_tip = [tip.x, tip.y, tip.z];
  return pts;
}

function mirrorX(pts: Record<string, V3>): Record<string, V3> {
  return Object.fromEntries(Object.entries(pts).map(([k, [x, y, z]]) => [k, [-x, y, z]]));
}

/** 平台世界坐标 → HandLandmark（wx/wy/wz 走 worldToWorld 的 (x,-y,-z) 逆变换）。 */
function toLandmarks(pts: Record<string, V3>): HandLandmark[] {
  return Object.entries(pts).map(([name, [px, py, pz]]) => ({
    name,
    x: px + 0.5,
    y: 0.5 - py,
    z: -pz,
    visibility: 0.99,
    wx: px,
    wy: -py,
    wz: -pz,
  }));
}

function makeHand(side: 'left' | 'right', kind: 'open' | 'fist', score = 0.95): HandData {
  const left = kind === 'open' ? OPEN_LEFT : fistLeft();
  const pts = side === 'left' ? left : mirrorX(left);
  return { handedness: side, score, landmarks: toLandmarks(pts) };
}

function makeFrame(hands: HandData[], timestampMs = 0): HandFrame {
  return { timestampMs, source: 'test', hands };
}

function transformPoints(pts: Record<string, V3>, q: Quaternion): Record<string, V3> {
  return Object.fromEntries(
    Object.entries(pts).map(([name, value]) => {
      const p = new Vector3(...value).applyQuaternion(q);
      return [name, [p.x, p.y, p.z] as V3];
    }),
  );
}

function handFromPoints(side: 'left' | 'right', pts: Record<string, V3>): HandData {
  return { handedness: side, score: 0.95, landmarks: toLandmarks(pts) };
}

function posePalmFrame(
  side: 'left' | 'right',
  pts: Record<string, V3>,
  timestampMs: number,
): PoseFrame {
  const names = {
    wrist: 'wrist',
    index: 'index_finger_mcp',
    pinky: 'pinky_mcp',
  } as const;
  return {
    timestampMs,
    source: 'test-pose',
    confidence: 0.99,
    landmarks: Object.entries(names).map(([posePart, handPart]) => {
      const [x, y, z] = pts[handPart];
      return {
        name: `${side}_${posePart}`,
        x: x + 0.5,
        y: 0.5 - y,
        z: -z,
        visibility: 0.99,
        wx: x,
        wy: -y,
        wz: -z,
      };
    }),
  };
}

function quatOf(value: { x: number; y: number; z: number; w: number }): Quaternion {
  return new Quaternion(value.x, value.y, value.z, value.w).normalize();
}

const FIVE = ['thumb', 'index', 'middle', 'ring', 'little'];

describe('hand-mapper：手指屈伸', () => {
  it('张开手掌五指 curl 接近 0，握拳五指 curl 显著增大', () => {
    const open = computeHandCurls(makeFrame([makeHand('left', 'open')]));
    const fist = computeHandCurls(makeFrame([makeHand('left', 'fist')]));
    for (const f of FIVE) {
      expect(open.left[f], `open ${f}`).toBeLessThan(0.15);
      expect(fist.left[f], `fist ${f}`).toBeGreaterThan(0.5);
    }
  });

  it('右手握拳同样测得五指屈曲（手性符号正确）', () => {
    const fist = computeHandCurls(makeFrame([makeHand('right', 'fist')]));
    for (const f of FIVE) {
      expect(fist.right[f], `right fist ${f}`).toBeGreaterThan(0.5);
    }
  });

  it('拇指对掌：握拳时拇指 curl 明显（> 0.6）', () => {
    const fist = computeHandCurls(makeFrame([makeHand('left', 'fist')]));
    expect(fist.left.thumb).toBeGreaterThan(0.6);
  });

  it('左右手互不串扰：右手数据不驱动左手骨骼', () => {
    const { rotations } = mapHandFrameToBoneRotations(makeFrame([makeHand('right', 'fist')]));
    const keys = Object.keys(rotations);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.startsWith('Right'))).toBe(true);

    const left = mapHandFrameToBoneRotations(makeFrame([makeHand('left', 'fist')]));
    expect(Object.keys(left.rotations).every((k) => k.startsWith('Left'))).toBe(true);
  });

  it('只输出 rigBones 集合中存在的骨骼', () => {
    const rigBones = new Set(['RightHand', 'RightIndexProximal']);
    const { rotations } = mapHandFrameToBoneRotations(makeFrame([makeHand('right', 'fist')]), { rigBones });
    expect(Object.keys(rotations).sort()).toEqual(['RightHand', 'RightIndexProximal']);
  });

  it('内置底模场景（rigBones 仅 22 根）：手指骨骼自动跳过，仅 Hand 生效', () => {
    const rigBones = new Set(['LeftHand']);
    const { rotations } = mapHandFrameToBoneRotations(makeFrame([makeHand('left', 'fist')]), { rigBones });
    expect(Object.keys(rotations)).toEqual(['LeftHand']);
  });

  it('握拳时 Hand 骨骼保持小增量（手掌朝向未变），指节旋转量大', () => {
    const { rotations } = mapHandFrameToBoneRotations(makeFrame([makeHand('left', 'fist')]));
    const hand = rotations.LeftHand!;
    const handAngle = 2 * Math.acos(Math.min(1, Math.abs(hand.w)));
    const idx = rotations.LeftIndexDistal!;
    const idxAngle = 2 * Math.acos(Math.min(1, Math.abs(idx.w)));
    expect(handAngle).toBeLessThan((30 * Math.PI) / 180);
    expect(idxAngle).toBeGreaterThan((60 * Math.PI) / 180);
  });

  it.each(['left', 'right'] as const)(
    '%s 手掌绕世界轴转动后保持同向，不产生镜像反射',
    (side) => {
      const turn = new Quaternion().setFromAxisAngle(
        new Vector3(0.3, 0.7, 0.2).normalize(),
        (40 * Math.PI) / 180,
      );
      const base = side === 'left' ? OPEN_LEFT : mirrorX(OPEN_LEFT);
      const hand = handFromPoints(side, transformPoints(base, turn));
      const { rotations } = mapHandFrameToBoneRotations(makeFrame([hand]));
      const value = side === 'left' ? rotations.LeftHand! : rotations.RightHand!;
      expect(quatOf(value).angleTo(turn)).toBeLessThan(0.02);
    },
  );

  it('KalidoKit 链式角先验补偿斜对镜头时的指节屈曲低估', () => {
    const hand: HandData = {
      handedness: 'left',
      score: 0.95,
      landmarks: toLandmarks(obliqueIndexLeft()),
    };
    const frame = makeFrame([hand]);
    const native = computeHandCurls(frame, { kinematicPriorWeight: 0 });
    const hybrid = computeHandCurls(frame, { kinematicPriorWeight: 1 });
    expect(hybrid.left.index).toBeGreaterThan(native.left.index + 0.05);
    expect(hybrid.left.index).toBeLessThanOrEqual(1);
  });
});

describe('HandDriveManager：丢失回退', () => {
  it('手丢失后先定格、再平滑回放松微屈，无跳变无 NaN', () => {
    const mgr = new HandDriveManager({ freezeDelayMs: 400, blendDurationMs: 800 });
    const fist = makeFrame([makeHand('right', 'fist')], 0);
    const good = mgr.update(fist, 0);
    const prox0 = good.RightIndexProximal!;
    expect(prox0).toBeDefined();
    const angle0 = 2 * Math.acos(Math.min(1, Math.abs(prox0.w)));

    // 短暂丢失：沿用最近可信姿态（定格）
    const frozen = mgr.update(null, 200);
    expect(frozen.RightIndexProximal).toEqual(prox0);

    // 长时丢失：向放松微屈混合（角度明显减小、有限且单位化）
    const blended = mgr.update(null, 2000);
    const proxB = blended.RightIndexProximal!;
    const angleB = 2 * Math.acos(Math.min(1, Math.abs(proxB.w)));
    expect(angleB).toBeLessThan(angle0);
    expect(angleB).toBeGreaterThan(0);
    const norm = Math.hypot(proxB.x, proxB.y, proxB.z, proxB.w);
    expect(norm).toBeCloseTo(1, 5);
    expect(Number.isFinite(angleB)).toBe(true);

    // 最终收敛到放松微屈（约 15°）
    const final = mgr.update(null, 5000);
    const proxF = final.RightIndexProximal!;
    const angleF = 2 * Math.acos(Math.min(1, Math.abs(proxF.w)));
    expect((angleF * 180) / Math.PI).toBeCloseTo(15, 0);
  });

  it('从未检出的手不输出任何骨骼（保持绑定姿态）', () => {
    const mgr = new HandDriveManager();
    const out = mgr.update(null, 1000);
    expect(Object.keys(out)).toHaveLength(0);
  });
});

describe('HandDriveManager：手掌方向标定与分级抗抖', () => {
  it('用 Pose 掌根消除固定坐标偏差，向内/向外旋转方向不反转', () => {
    const bias = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (35 * Math.PI) / 180);
    const inward = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (30 * Math.PI) / 180);
    const biasedNeutral = transformPoints(OPEN_LEFT, bias);
    const movedRaw = transformPoints(biasedNeutral, inward);
    const movedPose = transformPoints(OPEN_LEFT, inward);
    const mgr = new HandDriveManager({
      handOrientationCalibrationFrames: 1,
      temporalSmoothingMs: 1,
      maxAngularVelocityDegPerSec: 10000,
      rotationDeadbandDeg: 0,
      handTemporalSmoothingMs: 1,
      handMaxAngularVelocityDegPerSec: 10000,
      handRotationDeadbandDeg: 0,
    });

    const neutral = mgr.update(
      makeFrame([handFromPoints('left', biasedNeutral)], 0),
      0,
      posePalmFrame('left', OPEN_LEFT, 0),
    );
    expect(quatOf(neutral.LeftHand!).angleTo(new Quaternion())).toBeLessThan(0.02);

    const moved = mgr.update(
      makeFrame([handFromPoints('left', movedRaw)], 100),
      100,
      posePalmFrame('left', movedPose, 100),
    );
    expect(quatOf(moved.LeftHand!).angleTo(inward)).toBeLessThan(0.03);
  });

  it('同样的突发角度下手掌步进小于手指，掌部不会把深度噪声放大成抽搐', () => {
    const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (45 * Math.PI) / 180);
    const mgr = new HandDriveManager({
      handOrientationCalibrationFrames: 0,
      temporalSmoothingMs: 35,
      maxAngularVelocityDegPerSec: 900,
      rotationDeadbandDeg: 0,
      handTemporalSmoothingMs: 140,
      handMaxAngularVelocityDegPerSec: 240,
      handRotationDeadbandDeg: 0,
    });
    mgr.update(makeFrame([makeHand('left', 'open')], 0), 0);
    const moved = mgr.update(
      makeFrame([handFromPoints('left', transformPoints(OPEN_LEFT, turn))], 42),
      42,
    );
    const palmAngle = new Quaternion().angleTo(quatOf(moved.LeftHand!));
    const fingerAngle = new Quaternion().angleTo(quatOf(moved.LeftIndexProximal!));
    expect(palmAngle).toBeLessThan(fingerAngle * 0.65);
  });
});
