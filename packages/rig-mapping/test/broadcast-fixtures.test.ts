import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Object3D, Vector3 } from 'three';
import type { PoseFrame, StandardRigBone } from '@dhp/avatar-schema';
import { applyBoneRotations, buildStandardSkeleton, createRigDriver, resetSkeletonToBind } from '@dhp/avatar-runtime';
import { calibrate, imageToWorld, mapPoseFrameToBoneRotations, worldToWorld, hasWorldCoords } from '../src/index.js';

/**
 * 真实视频回归夹具（广播体操，heavy 模型采集，含 worldLandmarks）：
 * calibrate → mapPoseFrameToBoneRotations → applyBoneRotations（与线上同管线），
 * 断言骨骼世界方向与关键点世界方向夹角在阈值内、动作方向不颠倒。
 * 不依赖浏览器即可回归；夹具由 tmp/extract-fixtures.mjs 从 pose-lab 报告提取。
 *
 * 真值选择：主断言用 worldLandmarks（worldToWorld）——米制、髋部原点、
 * z 为真实深度估计，是 MediaPipe 输出中最可靠的方向来源（详见 pose-lab 报告：
 * 图像 z 对侧平举肢体会系统性偏向 +Z，image/world 两个头在 heavy 模型上
 * 前臂方向平均分歧 43.6°，故图像真值只作宽松护栏）。
 */

interface Fixture {
  name: string;
  tRange: [number, number];
  calibration: PoseFrame[];
  frames: PoseFrame[];
}

function loadFixture(name: string): Fixture {
  const url = new URL(`./fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Fixture;
}

const MIN_VIS = 0.6;

const SEGMENT_DEFS: Array<{
  id: string;
  bone: StandardRigBone;
  child: StandardRigBone;
  from: string[];
  to: string[];
  kind: 'arm' | 'leg' | 'spine';
}> = [
  { id: 'leftUpperArm', bone: 'LeftUpperArm', child: 'LeftLowerArm', from: ['left_shoulder'], to: ['left_elbow'], kind: 'arm' },
  { id: 'leftLowerArm', bone: 'LeftLowerArm', child: 'LeftHand', from: ['left_elbow'], to: ['left_wrist'], kind: 'arm' },
  { id: 'rightUpperArm', bone: 'RightUpperArm', child: 'RightLowerArm', from: ['right_shoulder'], to: ['right_elbow'], kind: 'arm' },
  { id: 'rightLowerArm', bone: 'RightLowerArm', child: 'RightHand', from: ['right_elbow'], to: ['right_wrist'], kind: 'arm' },
  { id: 'leftUpperLeg', bone: 'LeftUpperLeg', child: 'LeftLowerLeg', from: ['left_hip'], to: ['left_knee'], kind: 'leg' },
  { id: 'leftLowerLeg', bone: 'LeftLowerLeg', child: 'LeftFoot', from: ['left_knee'], to: ['left_ankle'], kind: 'leg' },
  { id: 'rightUpperLeg', bone: 'RightUpperLeg', child: 'RightLowerLeg', from: ['right_hip'], to: ['right_knee'], kind: 'leg' },
  { id: 'rightLowerLeg', bone: 'RightLowerLeg', child: 'RightFoot', from: ['right_knee'], to: ['right_ankle'], kind: 'leg' },
  { id: 'spine', bone: 'Spine', child: 'Neck', from: ['left_hip', 'right_hip'], to: ['left_shoulder', 'right_shoulder'], kind: 'spine' },
];

function truthPoint(frame: PoseFrame, names: string[], source: 'image' | 'world'): Vector3 | null {
  const acc = new Vector3();
  let n = 0;
  for (const name of names) {
    const lm = frame.landmarks.find((l) => l.name === name);
    if (!lm || lm.visibility < MIN_VIS) return null;
    if (source === 'world') {
      if (!hasWorldCoords(lm)) return null;
      acc.add(worldToWorld(lm, false));
    } else {
      acc.add(imageToWorld(lm, false));
    }
    n += 1;
  }
  return acc.multiplyScalar(1 / n);
}

function angleOf(q: { w: number }): number {
  return (2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180) / Math.PI;
}

/** 跑完整管线，返回各肢体段误差序列（两种真值）与每帧旋转。 */
function runPipeline(fixture: Fixture) {
  const calibration = calibrate(fixture.calibration);
  const { bones, rootBone } = buildStandardSkeleton();
  const root = new Object3D();
  root.add(rootBone);
  root.updateMatrixWorld(true);
  const driver = createRigDriver(new Map(Object.entries(bones) as [StandardRigBone, Object3D][]), root);

  const segErrWorld = new Map<string, number[]>(SEGMENT_DEFS.map((d) => [d.id, []]));
  const segErrImage = new Map<string, number[]>(SEGMENT_DEFS.map((d) => [d.id, []]));
  const rotationsPerFrame: ReturnType<typeof mapPoseFrameToBoneRotations>[] = [];
  for (const frame of fixture.frames) {
    resetSkeletonToBind(bones);
    const rotations = mapPoseFrameToBoneRotations(frame, calibration);
    rotationsPerFrame.push(rotations);
    applyBoneRotations(driver, rotations);
    root.updateMatrixWorld(true);
    for (const def of SEGMENT_DEFS) {
      const boneDir = bones[def.child]
        .getWorldPosition(new Vector3())
        .sub(bones[def.bone].getWorldPosition(new Vector3()))
        .normalize();
      const wa = truthPoint(frame, def.from, 'world');
      const wb = truthPoint(frame, def.to, 'world');
      if (wa && wb) segErrWorld.get(def.id)!.push((boneDir.angleTo(wb.sub(wa).normalize()) * 180) / Math.PI);
      const ia = truthPoint(frame, def.from, 'image');
      const ib = truthPoint(frame, def.to, 'image');
      if (ia && ib) segErrImage.get(def.id)!.push((boneDir.angleTo(ib.sub(ia).normalize()) * 180) / Math.PI);
    }
  }
  const meanOf = (kind: 'arm' | 'leg' | 'spine', errs: Map<string, number[]>) => {
    const vals = SEGMENT_DEFS.filter((d) => d.kind === kind).flatMap((d) => errs.get(d.id)!);
    return vals.reduce((s, v) => s + v, 0) / (vals.length || 1);
  };
  return {
    calibration,
    bones,
    root,
    driver,
    rotationsPerFrame,
    meanWorld: (kind: 'arm' | 'leg' | 'spine') => meanOf(kind, segErrWorld),
    meanImage: (kind: 'arm' | 'leg' | 'spine') => meanOf(kind, segErrImage),
  };
}

/** 绑定姿态下某骨骼的世界坐标。 */
function bindWorldPos(name: StandardRigBone): Vector3 {
  const { bones, rootBone } = buildStandardSkeleton();
  const root = new Object3D();
  root.add(rootBone);
  root.updateMatrixWorld(true);
  return bones[name].getWorldPosition(new Vector3());
}

describe('广播体操真实视频夹具回归', () => {
  it('双臂上举段：上肢方向误差 <15°（world 真值），举手后手腕世界 y 增大（方向不颠倒）', () => {
    const fixture = loadFixture('broadcast-arms-up');
    const { bones, root, driver, rotationsPerFrame, meanWorld, meanImage } = runPipeline(fixture);
    expect(meanWorld('arm')).toBeLessThan(15);
    expect(meanWorld('spine')).toBeLessThan(20);
    expect(meanImage('arm')).toBeLessThan(75); // 图像真值噪声大，仅作防颠覆护栏

    let maxGainL = -Infinity;
    let maxGainR = -Infinity;
    const bindL = bindWorldPos('LeftHand');
    const bindR = bindWorldPos('RightHand');
    for (const rotations of rotationsPerFrame) {
      resetSkeletonToBind(bones);
      applyBoneRotations(driver, rotations);
      root.updateMatrixWorld(true);
      maxGainL = Math.max(maxGainL, bones.LeftHand.getWorldPosition(new Vector3()).y - bindL.y);
      maxGainR = Math.max(maxGainR, bones.RightHand.getWorldPosition(new Vector3()).y - bindR.y);
    }
    expect(maxGainL).toBeGreaterThan(0.15); // 左手世界 y 明显增大
    expect(maxGainR).toBeGreaterThan(0.15); // 右手同理
  });

  it('扩胸段：上肢方向误差 <15°（world 真值），双手保持在髋部以上', () => {
    const fixture = loadFixture('broadcast-chest-expansion');
    const { bones, root, driver, rotationsPerFrame, meanWorld, meanImage } = runPipeline(fixture);
    expect(meanWorld('arm')).toBeLessThan(15);
    expect(meanImage('arm')).toBeLessThan(75);

    const bindHips = bindWorldPos('Hips');
    let minHandY = Infinity;
    for (const rotations of rotationsPerFrame) {
      resetSkeletonToBind(bones);
      applyBoneRotations(driver, rotations);
      root.updateMatrixWorld(true);
      minHandY = Math.min(
        minHandY,
        bones.LeftHand.getWorldPosition(new Vector3()).y,
        bones.RightHand.getWorldPosition(new Vector3()).y,
      );
    }
    // 扩胸双臂侧平举/前伸，手不应掉到髋部以下（上下颠倒回归）
    expect(minHandY).toBeGreaterThan(bindHips.y);
  });

  it('踢腿段：下肢方向误差 <15°（world 真值），脚踝世界 y 增大', () => {
    const fixture = loadFixture('broadcast-kick');
    const { bones, root, driver, rotationsPerFrame, meanWorld, meanImage } = runPipeline(fixture);
    expect(meanWorld('leg')).toBeLessThan(15);
    expect(meanImage('leg')).toBeLessThan(60);

    const bindLF = bindWorldPos('LeftFoot');
    const bindRF = bindWorldPos('RightFoot');
    let maxGain = -Infinity;
    for (const rotations of rotationsPerFrame) {
      resetSkeletonToBind(bones);
      applyBoneRotations(driver, rotations);
      root.updateMatrixWorld(true);
      maxGain = Math.max(
        maxGain,
        bones.LeftFoot.getWorldPosition(new Vector3()).y - bindLF.y,
        bones.RightFoot.getWorldPosition(new Vector3()).y - bindRF.y,
      );
    }
    expect(maxGain).toBeGreaterThan(0.2); // 踢腿后脚踝世界 y 明显增大
  });

  it('体转段：Hips 产生明显 yaw 旋转（>15°），上肢误差 <15°（world 真值）', () => {
    const fixture = loadFixture('broadcast-torso-turn');
    const { rotationsPerFrame, meanWorld } = runPipeline(fixture);
    expect(meanWorld('arm')).toBeLessThan(15);

    const maxHips = Math.max(...rotationsPerFrame.map((r) => (r.Hips ? angleOf(r.Hips) : 0)));
    expect(maxHips).toBeGreaterThan(15); // 体转必须驱动骨盆旋转（v1 基本不转）
  });
});
