import { useCallback, useEffect, useRef, useState } from 'react';
import { Object3D, Vector3 } from 'three';
import type { PoseFrame, PoseLandmark, StandardRigBone } from '@dhp/avatar-schema';
import {
  LandmarkSmoother,
  MAPPER_VERSION,
  calibrate,
  hasWorldCoords,
  imageToWorld,
  mapPoseFrameToBoneRotations,
  worldToWorld,
  type CalibrationData,
} from '@dhp/rig-mapping';
import {
  applyBoneRotations,
  buildStandardSkeleton,
  createRigDriver,
  resetSkeletonToBind,
  type RigDriver,
} from '@dhp/avatar-runtime';
import { VideoFilePoseTracker } from '@dhp/vision-runtime';

/**
 * /pose-lab（隐藏调试路由，不进主导航）：
 * 用与生产完全相同的管线（同 wasm/模型/mapper）分析本地视频文件，
 * 量化「骨骼世界方向 vs 关键点世界方向」的夹角误差，输出到 window.__poseLabResult。
 *
 * Query 参数（auto=1 时自动开跑，供 scripts/pose-video-lab.mjs 驱动）：
 * - video：视频 URL（默认 /samples/broadcast-gymnastics.mp4）
 * - start/end/interval：采样区间与间隔（秒，默认 0–120/0.1）
 * - calibSec/calibWin：校准中心与半窗（秒，默认 2/±0.5，窗口内取逐关键点中位帧）
 * - model：full|heavy（默认 heavy）；delegate：GPU|CPU（默认 CPU，headless 可用）
 * - mirror：0|1（默认 0，解剖学对应）；smooth：0|1（默认 0）；minCutoff/beta：滤波参数
 * - minVis：误差统计的关键点可见性门槛（默认 0.6）；dump：1 时把全部 PoseFrame 一并输出
 */

interface SegmentError {
  mean: number;
  p95: number;
  max: number;
  count: number;
}

export interface PoseLabResult {
  meta: {
    video: string;
    duration: number;
    start: number;
    end: number;
    interval: number;
    calibSec: number;
    calibWin: number;
    model: string;
    delegate: string;
    mirror: boolean;
    smooth: boolean;
    minCutoff: number;
    beta: number;
    minVis: number;
    sampledFrames: number;
    mapperVersion: string;
    ranAt: string;
  };
  /** worldLandmarks 朝向自检（校准中位帧原始值，判断 y/z 轴方向用） */
  worldSanity: Record<string, number | undefined>;
  /** 主指标：骨骼世界方向 vs 图像关键点方向（imageToWorld） */
  errors: Record<string, SegmentError>;
  /** 副指标（自检）：骨骼世界方向 vs worldLandmarks 方向（worldToWorld） */
  errorsWorld: Record<string, SegmentError>;
  overall: SegmentError;
  overallWorld: SegmentError;
  worstFrames: Array<{ t: number; meanErr: number }>;
  calibration: CalibrationData;
  frames?: PoseFrame[];
}

declare global {
  interface Window {
    __poseLabResult?: PoseLabResult;
    __poseLabProgress?: number;
    __poseLabError?: string;
  }
}

/** 误差统计的肢体段：骨骼对（世界坐标差）vs 关键点对（世界方向）。 */
const SEGMENT_DEFS: Array<{
  id: string;
  bone: StandardRigBone;
  child: StandardRigBone;
  from: string[];
  to: string[];
}> = [
  { id: 'leftUpperArm', bone: 'LeftUpperArm', child: 'LeftLowerArm', from: ['left_shoulder'], to: ['left_elbow'] },
  { id: 'leftLowerArm', bone: 'LeftLowerArm', child: 'LeftHand', from: ['left_elbow'], to: ['left_wrist'] },
  { id: 'rightUpperArm', bone: 'RightUpperArm', child: 'RightLowerArm', from: ['right_shoulder'], to: ['right_elbow'] },
  { id: 'rightLowerArm', bone: 'RightLowerArm', child: 'RightHand', from: ['right_elbow'], to: ['right_wrist'] },
  { id: 'leftUpperLeg', bone: 'LeftUpperLeg', child: 'LeftLowerLeg', from: ['left_hip'], to: ['left_knee'] },
  { id: 'leftLowerLeg', bone: 'LeftLowerLeg', child: 'LeftFoot', from: ['left_knee'], to: ['left_ankle'] },
  { id: 'rightUpperLeg', bone: 'RightUpperLeg', child: 'RightLowerLeg', from: ['right_hip'], to: ['right_knee'] },
  { id: 'rightLowerLeg', bone: 'RightLowerLeg', child: 'RightFoot', from: ['right_knee'], to: ['right_ankle'] },
  { id: 'spine', bone: 'Spine', child: 'Neck', from: ['left_hip', 'right_hip'], to: ['left_shoulder', 'right_shoulder'] },
];

/** 2D 叠加画的骨架连线（MediaPipe 关键点名对）。 */
const SKELETON_EDGES: Array<[string, string]> = [
  ['left_shoulder', 'right_shoulder'],
  ['left_shoulder', 'left_elbow'], ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'], ['right_elbow', 'right_wrist'],
  ['left_shoulder', 'left_hip'], ['right_shoulder', 'right_hip'],
  ['left_hip', 'right_hip'],
  ['left_hip', 'left_knee'], ['left_knee', 'left_ankle'],
  ['right_hip', 'right_knee'], ['right_knee', 'right_ankle'],
  ['nose', 'left_shoulder'], ['nose', 'right_shoulder'],
];

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 校准窗口内逐关键点取中位坐标，合成一个中位帧。 */
function buildMedianFrame(frames: PoseFrame[]): PoseFrame {
  const byName = new Map<string, PoseLandmark[]>();
  for (const f of frames) {
    for (const lm of f.landmarks) {
      const arr = byName.get(lm.name) ?? [];
      arr.push(lm);
      byName.set(lm.name, arr);
    }
  }
  const landmarks: PoseLandmark[] = [];
  for (const [name, arr] of byName) {
    const pick = (k: 'x' | 'y' | 'z' | 'wx' | 'wy' | 'wz') => {
      const vals = arr.map((lm) => lm[k]).filter((v): v is number => v !== undefined);
      return vals.length ? median(vals) : undefined;
    };
    const lm: PoseLandmark = {
      name,
      x: pick('x')!,
      y: pick('y')!,
      z: pick('z')!,
      visibility: arr.reduce((s, l) => s + l.visibility, 0) / arr.length,
    };
    const wx = pick('wx');
    const wy = pick('wy');
    const wz = pick('wz');
    if (wx !== undefined && wy !== undefined && wz !== undefined) {
      lm.wx = wx;
      lm.wy = wy;
      lm.wz = wz;
    }
    landmarks.push(lm);
  }
  const last = frames[frames.length - 1];
  return { timestampMs: last?.timestampMs ?? 0, source: 'pose-lab-median', confidence: 1, landmarks };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function summarize(values: number[]): SegmentError {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / (values.length || 1);
  return { mean, p95: percentile(sorted, 95), max: sorted[sorted.length - 1] ?? 0, count: values.length };
}

interface LabParams {
  video: string;
  start: number;
  end: number;
  interval: number;
  calibSec: number;
  calibWin: number;
  model: 'full' | 'heavy';
  delegate: 'GPU' | 'CPU';
  mirror: boolean;
  smooth: boolean;
  minCutoff: number;
  beta: number;
  minVis: number;
  dump: boolean;
  auto: boolean;
}

function parseParams(): LabParams {
  const q = new URLSearchParams(window.location.search);
  const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
  return {
    video: q.get('video') ?? '/samples/broadcast-gymnastics.mp4',
    start: num('start', 0),
    end: num('end', 120),
    interval: num('interval', 0.1),
    calibSec: num('calibSec', 2),
    calibWin: num('calibWin', 0.5),
    model: q.get('model') === 'full' ? 'full' : 'heavy',
    delegate: q.get('delegate') === 'GPU' ? 'GPU' : 'CPU',
    mirror: q.get('mirror') === '1',
    smooth: q.get('smooth') === '1',
    minCutoff: num('minCutoff', 1.5),
    beta: num('beta', 0.3),
    minVis: num('minVis', 0.6),
    dump: q.get('dump') === '1',
    auto: q.get('auto') === '1',
  };
}

export function PoseLabPage() {
  const [params] = useState(parseParams);
  const [status, setStatus] = useState('待开始');
  const [progress, setProgressState] = useState(0);
  const setProgress = (p: number) => {
    setProgressState(p);
    window.__poseLabProgress = p;
  };
  const [result, setResult] = useState<PoseLabResult | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rigCanvasRef = useRef<HTMLCanvasElement>(null);
  const runningRef = useRef(false);

  const drawOverlay = useCallback((frame: PoseFrame) => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    canvas.width = video.videoWidth || 360;
    canvas.height = video.videoHeight || 640;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const byName = new Map(frame.landmarks.map((lm) => [lm.name, lm]));
    const pt = (name: string) => {
      const lm = byName.get(name);
      return lm ? { x: lm.x * canvas.width, y: lm.y * canvas.height, v: lm.visibility } : null;
    };
    ctx.lineWidth = Math.max(2, canvas.width / 200);
    ctx.strokeStyle = 'rgba(0, 255, 136, 0.85)';
    for (const [a, b] of SKELETON_EDGES) {
      const pa = pt(a);
      const pb = pt(b);
      if (!pa || !pb || pa.v < 0.5 || pb.v < 0.5) continue;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
    for (const lm of frame.landmarks) {
      ctx.fillStyle = lm.visibility >= 0.6 ? '#00ff88' : '#ff5544';
      ctx.beginPath();
      ctx.arc(lm.x * canvas.width, lm.y * canvas.height, Math.max(2, canvas.width / 300), 0, Math.PI * 2);
      ctx.fill();
    }
  }, []);

  const drawRig = useCallback((bones: ReturnType<typeof buildStandardSkeleton>['bones'], root: Object3D) => {
    const canvas = rigCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    root.updateMatrixWorld(true);
    const scale = canvas.height / 2.1;
    const project = (name: StandardRigBone) => {
      const p = bones[name].getWorldPosition(new Vector3());
      return { x: canvas.width / 2 + p.x * scale, y: canvas.height * 0.92 - p.y * scale };
    };
    const edges: Array<[StandardRigBone, StandardRigBone]> = [
      ['Hips', 'Spine'], ['Spine', 'Chest'], ['Chest', 'Neck'], ['Neck', 'Head'],
      ['Chest', 'LeftShoulder'], ['LeftShoulder', 'LeftUpperArm'], ['LeftUpperArm', 'LeftLowerArm'], ['LeftLowerArm', 'LeftHand'],
      ['Chest', 'RightShoulder'], ['RightShoulder', 'RightUpperArm'], ['RightUpperArm', 'RightLowerArm'], ['RightLowerArm', 'RightHand'],
      ['Hips', 'LeftUpperLeg'], ['LeftUpperLeg', 'LeftLowerLeg'], ['LeftLowerLeg', 'LeftFoot'],
      ['Hips', 'RightUpperLeg'], ['RightUpperLeg', 'RightLowerLeg'], ['RightLowerLeg', 'RightFoot'],
    ];
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#66aaff';
    for (const [a, b] of edges) {
      const pa = project(a);
      const pb = project(b);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
  }, []);

  const run = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      const video = videoRef.current!;
      video.src = params.video;
      setStatus('加载模型…');
      const tracker = new VideoFilePoseTracker({
        wasmBasePath: '/mediapipe/wasm',
        modelVariant: params.model,
        delegate: params.delegate,
        video,
      });
      await tracker.load();

      // 采样时间点
      const times: number[] = [];
      for (let t = params.start; t <= params.end + 1e-6; t += params.interval) times.push(Number(t.toFixed(3)));
      const rawFrames: Array<{ t: number; frame: PoseFrame }> = [];
      const smoother = new LandmarkSmoother({ minCutoff: params.minCutoff, beta: params.beta });
      setStatus(`采样检测中（0/${times.length}）…`);
      await tracker.sampleTimes(times, (frame, t) => {
        const out = params.smooth ? smoother.apply(frame) : frame;
        rawFrames.push({ t, frame: out });
        drawOverlay(frame);
        if (rawFrames.length % 20 === 0) {
          setProgress(rawFrames.length / times.length);
          setStatus(`采样检测中（${rawFrames.length}/${times.length}）…`);
        }
      });
      tracker.stop();

      // 校准：calibSec ± calibWin 窗口内逐关键点中位帧
      const calibFrames = rawFrames
        .filter(({ t }) => Math.abs(t - params.calibSec) <= params.calibWin)
        .map(({ frame }) => frame);
      if (calibFrames.length === 0) throw new Error(`校准窗口 ${params.calibSec}±${params.calibWin}s 内没有采样帧`);
      const calibration = calibrate([buildMedianFrame(calibFrames)], { mirror: params.mirror });

      // worldLandmarks 朝向自检（鼻/髋/踝的原始 world 值）
      const medianFrame = buildMedianFrame(calibFrames);
      const lm = (n: string) => medianFrame.landmarks.find((l) => l.name === n);
      const worldSanity: Record<string, number | undefined> = {
        nose_wy: lm('nose')?.wy,
        left_hip_wy: lm('left_hip')?.wy,
        left_ankle_wy: lm('left_ankle')?.wy,
        nose_wz: lm('nose')?.wz,
        left_hip_wz: lm('left_hip')?.wz,
        left_wrist_wx: lm('left_wrist')?.wx,
        right_wrist_wx: lm('right_wrist')?.wx,
      };

      // 映射 + 误差统计
      setStatus('映射与误差统计中…');
      const { bones, rootBone } = buildStandardSkeleton();
      const root = new Object3D();
      root.add(rootBone);
      root.updateMatrixWorld(true);
      const driver: RigDriver = createRigDriver(
        new Map(Object.entries(bones) as [StandardRigBone, Object3D][]),
        root,
      );

      // 主指标真值：图像关键点经 imageToWorld（与 mapper 的 worldLandmarks 输入相互独立）；
      // 副指标真值：worldLandmarks 经 worldToWorld（自检映射管线一致性，无 clamp 时应≈0）。
      const truthPoint = (frame: PoseFrame, names: string[], source: 'image' | 'world'): Vector3 | null => {
        const acc = new Vector3();
        let n = 0;
        for (const name of names) {
          const lm = frame.landmarks.find((l) => l.name === name);
          if (!lm || lm.visibility < params.minVis) return null;
          if (source === 'world') {
            if (!hasWorldCoords(lm)) return null;
            acc.add(worldToWorld(lm, params.mirror));
          } else {
            acc.add(imageToWorld(lm, params.mirror));
          }
          n += 1;
        }
        return acc.multiplyScalar(1 / n);
      };

      const segErrors = new Map<string, number[]>(SEGMENT_DEFS.map((d) => [d.id, []]));
      const segErrorsWorld = new Map<string, number[]>(SEGMENT_DEFS.map((d) => [d.id, []]));
      const frameMean: Array<{ t: number; meanErr: number }> = [];
      const boneDirOf = (bone: StandardRigBone, child: StandardRigBone) =>
        bones[child].getWorldPosition(new Vector3()).sub(bones[bone].getWorldPosition(new Vector3())).normalize();

      rawFrames.forEach(({ t, frame }, idx) => {
        resetSkeletonToBind(bones);
        const rotations = mapPoseFrameToBoneRotations(frame, calibration, { mirror: params.mirror });
        applyBoneRotations(driver, rotations);
        root.updateMatrixWorld(true);
        if (idx % 25 === 0) drawRig(bones, root);
        let sum = 0;
        let cnt = 0;
        for (const def of SEGMENT_DEFS) {
          const boneDir = boneDirOf(def.bone, def.child);
          const a = truthPoint(frame, def.from, 'image');
          const b = truthPoint(frame, def.to, 'image');
          if (a && b) {
            const err = (boneDir.angleTo(b.sub(a).normalize()) * 180) / Math.PI;
            segErrors.get(def.id)!.push(err);
            sum += err;
            cnt += 1;
          }
          const wa = truthPoint(frame, def.from, 'world');
          const wb = truthPoint(frame, def.to, 'world');
          if (wa && wb) {
            const err = (boneDir.angleTo(wb.sub(wa).normalize()) * 180) / Math.PI;
            segErrorsWorld.get(def.id)!.push(err);
          }
        }
        if (cnt > 0) frameMean.push({ t, meanErr: sum / cnt });
      });

      const errors: Record<string, SegmentError> = {};
      const errorsWorld: Record<string, SegmentError> = {};
      const all: number[] = [];
      const allWorld: number[] = [];
      for (const [id, vals] of segErrors) {
        errors[id] = summarize(vals);
        all.push(...vals);
      }
      for (const [id, vals] of segErrorsWorld) {
        errorsWorld[id] = summarize(vals);
        allWorld.push(...vals);
      }
      const worstFrames = [...frameMean].sort((a, b) => b.meanErr - a.meanErr).slice(0, 10);

      const res: PoseLabResult = {
        meta: {
          video: params.video,
          duration: video.duration,
          start: params.start,
          end: params.end,
          interval: params.interval,
          calibSec: params.calibSec,
          calibWin: params.calibWin,
          model: params.model,
          delegate: params.delegate,
          mirror: params.mirror,
          smooth: params.smooth,
          minCutoff: params.minCutoff,
          beta: params.beta,
          minVis: params.minVis,
          sampledFrames: rawFrames.length,
          mapperVersion: MAPPER_VERSION,
          ranAt: new Date().toISOString(),
        },
        worldSanity,
        errors,
        errorsWorld,
        overall: summarize(all),
        overallWorld: summarize(allWorld),
        worstFrames,
        calibration,
      };
      if (params.dump) res.frames = rawFrames.map(({ frame }) => frame);
      window.__poseLabResult = res;
      setResult(res);
      setProgress(1);
      setStatus('完成');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      window.__poseLabError = message; // 供 pose-video-lab.mjs 快速失败
      setStatus(`失败：${message}`);
      runningRef.current = false;
    }
  }, [params, drawOverlay, drawRig]);

  useEffect(() => {
    if (params.auto) void run();
  }, [params.auto, run]);

  return (
    <div style={{ padding: 16, fontFamily: 'monospace', color: '#ddd', background: '#111', minHeight: '100vh' }}>
      <h2 style={{ margin: '0 0 8px' }}>Pose Lab（动作映射矫正调试）</h2>
      <p style={{ margin: '4px 0' }}>
        状态：{status}（{(progress * 100).toFixed(0)}%） model={params.model} delegate={params.delegate} mapper={MAPPER_VERSION}
      </p>
      {!params.auto && (
        <button onClick={() => void run()} style={{ margin: '8px 0', padding: '6px 16px' }}>
          开始分析
        </button>
      )}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', width: 270 }}>
          <video ref={videoRef} muted playsInline preload="auto" style={{ width: '100%', display: 'block' }} />
          <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} width={360} height={640} />
        </div>
        <canvas ref={rigCanvasRef} width={240} height={420} style={{ background: '#000', width: 180 }} />
      </div>
      {result && (
        <table style={{ marginTop: 12, borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              {['肢体段', '平均误差°', 'P95°', '最大°', '帧数'].map((h) => (
                <th key={h} style={{ border: '1px solid #444', padding: '3px 10px', textAlign: 'left' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(result.errors).map(([id, e]) => (
              <tr key={id}>
                <td style={{ border: '1px solid #444', padding: '3px 10px' }}>{id}</td>
                <td style={{ border: '1px solid #444', padding: '3px 10px' }}>{e.mean.toFixed(1)}</td>
                <td style={{ border: '1px solid #444', padding: '3px 10px' }}>{e.p95.toFixed(1)}</td>
                <td style={{ border: '1px solid #444', padding: '3px 10px' }}>{e.max.toFixed(1)}</td>
                <td style={{ border: '1px solid #444', padding: '3px 10px' }}>{e.count}</td>
              </tr>
            ))}
            <tr style={{ fontWeight: 'bold' }}>
              <td style={{ border: '1px solid #444', padding: '3px 10px' }}>overall</td>
              <td style={{ border: '1px solid #444', padding: '3px 10px' }}>{result.overall.mean.toFixed(1)}</td>
              <td style={{ border: '1px solid #444', padding: '3px 10px' }}>{result.overall.p95.toFixed(1)}</td>
              <td style={{ border: '1px solid #444', padding: '3px 10px' }}>{result.overall.max.toFixed(1)}</td>
              <td style={{ border: '1px solid #444', padding: '3px 10px' }}>{result.overall.count}</td>
            </tr>
          </tbody>
        </table>
      )}
      {result && (
        <p style={{ marginTop: 8 }}>
          自检（vs worldLandmarks）：overall mean {result.overallWorld.mean.toFixed(1)}° / P95 {result.overallWorld.p95.toFixed(1)}°
        </p>
      )}
    </div>
  );
}
