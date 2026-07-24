import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  FINGER_EXTENSION_BONES,
  garmentManifestSchema,
  type ExtendedRigBone,
  type FaceFrame,
  type GarmentManifest,
  type HandFrame,
  type PoseFrame,
  type PoseTrackingMode,
} from '@dhp/avatar-schema';
import {
  PRESET_ANIMATION_DEFINITIONS,
  type PresetAnimationId,
} from '@dhp/avatar-runtime';
import {
  HandDriveManager,
  HandFrameStabilizer,
  HandFrameSmoother,
  CrouchMotionTracker,
  FaceDriveManager,
  type FaceTrackingStatus,
  LandmarkSmoother,
  TemporalPoseCompleter,
  TrackingLossManager,
  calibrate,
  calibrationHipHeight,
  estimateStandingHipHeight,
  mapPoseFrameToBoneRotations,
  type CalibrationData,
  type TrackingStatus,
} from '@dhp/rig-mapping';
import {
  CalibrationSession,
  CameraPoseTracker,
  FaceTracker,
  HandTracker,
  VideoFilePoseTracker,
  type CalibrationSessionState,
} from '@dhp/vision-runtime';
import { api, ApiError, fetchAuthedObjectUrl } from '../api/client';
import type { AssetEntry } from '../api/types';
import { AvatarViewport } from '../components/AvatarViewport';
import { Badge, SliderRow } from '../components/controls';
import {
  STUDIO_CAMERA_PRESETS,
  type AvatarPlacement,
  type AvatarSceneController,
  type StudioCameraPose,
} from '../three/AvatarSceneController';
import {
  CanvasVideoRecorder,
  getSupportedVideoMimeType,
} from '../video/CanvasVideoRecorder';

type DriveState = 'idle' | 'starting' | 'calibrating' | 'driving' | 'denied';

/** 识别质量档：精准=heavy 模型（默认，桌面 Chrome 可实时）；流畅=full 模型（低配设备）。 */
type PoseQuality = 'accurate' | 'smooth';

/** 手部检出状态（面板显示）。 */
type HandPresence = 'none' | 'left' | 'right' | 'both';

type AvatarStance = 'standing' | 'seated' | 'transition';
type RoomStatus = 'loading' | 'ready' | 'error' | 'none';
type StudioToolTab = 'scene' | 'motion' | 'detail';
type DanceState =
  | 'empty'
  | 'loading'
  | 'ready'
  | 'analyzing'
  | 'previewing'
  | 'recording'
  | 'completed'
  | 'error';

interface DanceVideoInfo {
  name: string;
  durationSec: number;
  width: number;
  height: number;
  sizeBytes: number;
}

interface DanceRecognitionMetrics {
  frames: number;
  rawConfidence: number;
  effectiveConfidence: number;
  coverage80: number;
  trackingCoverage: number;
  inferredPerFrame: number;
}

const DEFAULT_PLACEMENT: AvatarPlacement = {
  x: 0,
  y: 0,
  z: 0,
  rotationYDeg: 0,
  scale: 1,
};

const CAMERA_AXES = [
  { label: 'X', index: 0 },
  { label: 'Y', index: 1 },
  { label: 'Z', index: 2 },
] as const;

interface SavedCamera {
  id: string;
  label: string;
  pose: StudioCameraPose;
}

function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}

/** 兼容片头/空镜：先覆盖整段粗扫，再围绕最清晰的全身帧做精细标定。 */
function buildDanceCalibrationScanTimes(durationSec: number): number[] {
  const end = Math.max(0.1, durationSec - 0.05);
  const initialEnd = Math.min(end, 3);
  const initial = Array.from({ length: 8 }, (_, index) =>
    Number((0.05 + ((initialEnd - 0.05) * index) / 7).toFixed(3)),
  );
  const coarseCount = Math.min(20, Math.max(8, Math.ceil(durationSec / 15)));
  const coarse = Array.from({ length: coarseCount }, (_, index) =>
    Number((0.05 + ((end - 0.05) * index) / Math.max(1, coarseCount - 1)).toFixed(3)),
  );
  return [...new Set([...initial, ...coarse])].sort((a, b) => a - b);
}

function hasDanceCalibrationCore(frame: PoseFrame): boolean {
  const map = new Map(frame.landmarks.map((landmark) => [landmark.name, landmark.visibility]));
  return ['nose', 'left_shoulder', 'right_shoulder', 'left_hip', 'right_hip'].every(
    (name) => (map.get(name) ?? 0) >= 0.45,
  );
}

function seekVideo(video: HTMLVideoElement, timeSec: number): Promise<void> {
  const target = Math.min(Math.max(0, timeSec), Math.max(0, video.duration || timeSec));
  if (video.readyState >= 2 && Math.abs(video.currentTime - target) <= 1 / 240) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('视频定位超时，请尝试重新导入'));
    }, 8000);
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('视频读取失败'));
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.currentTime = target;
  });
}

/**
 * 虚拟直播间 / 真人视频复现共享三维运行时，但以独立页面呈现。
 * 链路：CameraPoseTracker → LandmarkSmoother →（校准）/ mapPoseFrameToBoneRotations
 * → TrackingLossManager → applyBoneRotations。全程浏览器本地处理。
 */
export function MotionPage({ workspace = 'studio' }: { workspace?: 'studio' | 'video' }) {
  const { id = '' } = useParams();
  const navigate = useNavigate();

  const controllerRef = useRef<AvatarSceneController | null>(null);
  const trackerRef = useRef<CameraPoseTracker | null>(null);
  // One Euro：广播体操级大动作实验调参（1.5Hz 挥臂衰减 34%→10%，静态噪声残留 33%→36%）
  const smootherRef = useRef(new LandmarkSmoother({ minCutoff: 1.5, beta: 0.3 }));
  const latestPoseFrameRef = useRef<PoseFrame | null>(null);
  const lossMgrRef = useRef(new TrackingLossManager());
  const sessionRef = useRef<CalibrationSession | null>(null);
  const calibrationRef = useRef<CalibrationData | null>(null);
  const crouchMotionRef = useRef(new CrouchMotionTracker());
  const videoRef = useRef<HTMLVideoElement>(null);
  const roomInputRef = useRef<HTMLInputElement>(null);
  const stanceTimerRef = useRef<number | null>(null);
  const driveStateRef = useRef<DriveState>('idle');
  const trackingModeRef = useRef<PoseTrackingMode>('full');
  // 手部追踪（实验性，默认关）
  const handTrackerRef = useRef<HandTracker | null>(null);
  const handStabilizerRef = useRef(new HandFrameStabilizer());
  const handSmootherRef = useRef(new HandFrameSmoother({ minCutoff: 2.0, beta: 0.5 }));
  const handDriveRef = useRef(new HandDriveManager());
  const handEnabledRef = useRef(false);
  // 面部追踪（摄像头驱动成功后自动开启）
  const faceTrackerRef = useRef<FaceTracker | null>(null);
  const faceDriveRef = useRef(new FaceDriveManager());
  const faceEnabledRef = useRef(false);
  const faceAutoStartedRef = useRef(false);
  const rigBonesRef = useRef<ReadonlySet<string> | null>(null);
  // 真人舞蹈视频驱动（独立于摄像头，源文件与推理结果都只保留在浏览器内存）
  const danceInputRef = useRef<HTMLInputElement>(null);
  const danceVideoRef = useRef<HTMLVideoElement>(null);
  const danceFileRef = useRef<File | null>(null);
  const danceSourceUrlRef = useRef<string | null>(null);
  const danceOutputUrlRef = useRef<string | null>(null);
  const danceTrackerRef = useRef<VideoFilePoseTracker | null>(null);
  const danceHandTrackerRef = useRef<HandTracker | null>(null);
  const danceRecorderRef = useRef<CanvasVideoRecorder | null>(null);
  const danceCalibrationRef = useRef<CalibrationData | null>(null);
  const danceCrouchMotionRef = useRef(new CrouchMotionTracker());
  const danceStateRef = useRef<DanceState>('empty');
  const danceFinishingRef = useRef(false);
  const danceRunTokenRef = useRef(0);
  const danceCompleterRef = useRef(
    new TemporalPoseCompleter({
      trackingMode: 'full',
      maxGapMs: 1200,
      minInferenceConfidence: 0.68,
      maxInferenceConfidence: 0.86,
    }),
  );
  const danceConfidenceStatsRef = useRef({
    frames: 0,
    activeFrames: 0,
    rawSum: 0,
    effectiveSum: 0,
    covered80: 0,
    inferredLandmarks: 0,
  });
  const danceSmootherRef = useRef(new LandmarkSmoother({ minCutoff: 1.5, beta: 0.3 }));
  const danceLossMgrRef = useRef(new TrackingLossManager({ trackingMode: 'full' }));
  const latestDancePoseRef = useRef<PoseFrame | null>(null);
  const danceHandStabilizerRef = useRef(new HandFrameStabilizer());
  const danceHandSmootherRef = useRef(new HandFrameSmoother({ minCutoff: 2.0, beta: 0.5 }));
  const danceHandDriveRef = useRef(new HandDriveManager());

  const [avatarName, setAvatarName] = useState('');
  const [fatalError, setFatalError] = useState('');
  const [driveState, setDriveState] = useState<DriveState>('idle');
  const [calibState, setCalibState] = useState<CalibrationSessionState | null>(null);
  const [trackingStatus, setTrackingStatus] = useState<TrackingStatus>('tracking');
  const [activeAnim, setActiveAnim] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [trackingMode, setTrackingModeState] = useState<PoseTrackingMode>('full');
  const [poseQuality, setPoseQuality] = useState<PoseQuality>('accurate');
  const [handEnabled, setHandEnabled] = useState(false);
  const [handPresence, setHandPresence] = useState<HandPresence>('none');
  const [fingerSupport, setFingerSupport] = useState<boolean | null>(null);
  const [faceEnabled, setFaceEnabled] = useState(false);
  const [faceStatus, setFaceStatus] = useState<FaceTrackingStatus | 'off' | 'loading' | 'error'>('off');
  const [faceCalibrationProgress, setFaceCalibrationProgress] = useState(0);
  const [faceSupport, setFaceSupport] = useState<number | null>(null);
  const [roomStatus, setRoomStatus] = useState<RoomStatus>('loading');
  const [roomName, setRoomName] = useState('Kenney CC0 直播间');
  const [roomError, setRoomError] = useState('');
  const [activeStudioCamera, setActiveStudioCamera] = useState('front');
  const [savedCameras, setSavedCameras] = useState<SavedCamera[]>([]);
  const [freeCameraPose, setFreeCameraPose] = useState<StudioCameraPose>({
    position: [0.45, 1.45, 3.25],
    target: [0, 1.05, 0],
    fov: 38,
  });
  const [studioToolTab, setStudioToolTab] = useState<StudioToolTab>('scene');
  const [placement, setPlacement] = useState<AvatarPlacement>(DEFAULT_PLACEMENT);
  const [stance, setStance] = useState<AvatarStance>('standing');
  const [danceState, setDanceStateValue] = useState<DanceState>('empty');
  const [danceInfo, setDanceInfo] = useState<DanceVideoInfo | null>(null);
  const [danceProgress, setDanceProgress] = useState(0);
  const [danceQuality, setDanceQuality] = useState<PoseQuality>('accurate');
  const [danceTrackingStatus, setDanceTrackingStatus] =
    useState<TrackingStatus>('tracking');
  const [danceHandPresence, setDanceHandPresence] = useState<HandPresence>('none');
  const [danceCalibrationConfidence, setDanceCalibrationConfidence] = useState<number | null>(
    null,
  );
  const [danceRecognitionMetrics, setDanceRecognitionMetrics] =
    useState<DanceRecognitionMetrics | null>(null);
  const [danceError, setDanceError] = useState('');
  const [danceOutputUrl, setDanceOutputUrl] = useState<string | null>(null);
  const [danceOutputName, setDanceOutputName] = useState('digital-human-dance.webm');

  const setDanceState = (state: DanceState) => {
    danceStateRef.current = state;
    setDanceStateValue(state);
  };

  const setTrackingMode = (mode: PoseTrackingMode) => {
    trackingModeRef.current = mode;
    setTrackingModeState(mode);
  };

  const setDrive = (s: DriveState) => {
    driveStateRef.current = s;
    setDriveState(s);
  };

  // ---------- 帧处理（追踪器回调，注意用 ref 读最新状态） ----------
  const handleFrame = useCallback((frame: PoseFrame) => {
    const smoothed = smootherRef.current.apply(frame);
    latestPoseFrameRef.current = smoothed;
    const state = driveStateRef.current;

    if (state === 'calibrating' && sessionRef.current) {
      const session = sessionRef.current;
      const sessionState = session.addFrame(smoothed);
      setCalibState(sessionState);
      if (sessionState.status === 'success') {
        const calibration = session.getResult();
        calibrationRef.current = calibration;
        crouchMotionRef.current.setBaseline(
          calibration ? calibrationHipHeight(calibration) : null,
        );
        sessionRef.current = null;
        controllerRef.current?.pkg?.stopAnimation();
        setActiveAnim(null);
        lossMgrRef.current.reset();
        setDrive('driving');
      }
      return;
    }

    if (state === 'driving' && calibrationRef.current) {
      // 解剖学对应映射（mirror: false）：用户右手驱动数字人右手，
      // 图像 y 下/z 朝摄像头由 imageToWorld 统一转为世界系 y 上/+Z 朝相机。
      // 预览镜像只是 video 的 CSS 显示（scaleX(-1)），不参与骨骼映射。
      const rotations = mapPoseFrameToBoneRotations(smoothed, calibrationRef.current, {
        mirror: false,
        trackingMode: trackingModeRef.current,
      });
      const out = lossMgrRef.current.updateWithFrame(smoothed.timestampMs, smoothed, rotations);
      setTrackingStatus((prev) => (prev === out.status ? prev : out.status));
      const pkg = controllerRef.current?.pkg;
      pkg?.applyBoneRotations(out.rotations);
      if (trackingModeRef.current === 'full' && out.status === 'tracking') {
        pkg?.applyHipsOffsetY(crouchMotionRef.current.update(smoothed));
      } else if (trackingModeRef.current === 'upper') {
        // 上半身模式严格不参与髋关节和根位移。
        pkg?.applyHipsOffsetY(0);
      }
    }
  }, []);

  // ---------- 真人视频姿态帧：全身绝对方向 + 视频时间线抗抖 ----------
  const handleDanceFrame = useCallback((frame: PoseFrame) => {
    const calibration = danceCalibrationRef.current;
    if (!calibration) return;
    const completion = danceCompleterRef.current.apply(frame);
    const smoothed = danceSmootherRef.current.apply(completion.frame);
    latestDancePoseRef.current = smoothed;
    const stats = danceConfidenceStatsRef.current;
    stats.frames += 1;
    stats.rawSum += completion.rawConfidence;
    if (completion.frame.landmarks.length > 0) {
      stats.activeFrames += 1;
      stats.effectiveSum += completion.effectiveConfidence;
      stats.covered80 += completion.effectiveConfidence >= 0.8 ? 1 : 0;
      stats.inferredLandmarks += completion.inferredLandmarks.length;
    }
    if (stats.frames === 1 || stats.frames % 6 === 0) {
      setDanceRecognitionMetrics({
        frames: stats.frames,
        rawConfidence: stats.rawSum / stats.frames,
        effectiveConfidence: stats.effectiveSum / Math.max(1, stats.activeFrames),
        coverage80: stats.covered80 / Math.max(1, stats.activeFrames),
        trackingCoverage: stats.activeFrames / stats.frames,
        inferredPerFrame: stats.inferredLandmarks / Math.max(1, stats.activeFrames),
      });
    }
    const rotations = mapPoseFrameToBoneRotations(smoothed, calibration, {
      mirror: false,
      trackingMode: 'full',
    });
    const out = danceLossMgrRef.current.updateWithFrame(
      smoothed.timestampMs,
      smoothed,
      rotations,
    );
    setDanceTrackingStatus((previous) =>
      previous === out.status ? previous : out.status,
    );
    controllerRef.current?.pkg?.applyBoneRotations(out.rotations);
    if (out.status === 'tracking') {
      controllerRef.current?.pkg?.applyHipsOffsetY(
        danceCrouchMotionRef.current.update(smoothed),
      );
    }
    const video = danceVideoRef.current;
    if (video?.duration) {
      const next = Math.min(1, video.currentTime / video.duration);
      setDanceProgress((previous) =>
        Math.abs(previous - next) >= 0.005 ? next : previous,
      );
    }
  }, []);

  const handleDanceHandFrame = useCallback((frame: HandFrame) => {
    const stabilized = danceHandStabilizerRef.current.apply(
      frame,
      latestDancePoseRef.current,
    );
    const smoothed = danceHandSmootherRef.current.apply(stabilized);
    const rotations = danceHandDriveRef.current.update(
      smoothed,
      smoothed.timestampMs,
      latestDancePoseRef.current,
    );
    controllerRef.current?.pkg?.applyBoneRotations(rotations);
    const left = smoothed.hands.some((hand) => hand.handedness === 'left' && hand.score >= 0.5);
    const right = smoothed.hands.some(
      (hand) => hand.handedness === 'right' && hand.score >= 0.5,
    );
    const next: HandPresence = left && right ? 'both' : left ? 'left' : right ? 'right' : 'none';
    setDanceHandPresence((previous) => (previous === next ? previous : next));
  }, []);

  // ---------- 手部帧处理（HandTracker 回调） ----------
  const handleHandFrame = useCallback((frame: HandFrame) => {
    if (!handEnabledRef.current) return;
    const stabilized = handStabilizerRef.current.apply(frame, latestPoseFrameRef.current);
    const smoothed = handSmootherRef.current.apply(stabilized);
    const rotations = handDriveRef.current.update(
      smoothed,
      smoothed.timestampMs,
      latestPoseFrameRef.current,
    );
    controllerRef.current?.pkg?.applyBoneRotations(rotations);
    const left = smoothed.hands.some((h) => h.handedness === 'left' && h.score >= 0.5);
    const right = smoothed.hands.some((h) => h.handedness === 'right' && h.score >= 0.5);
    const next: HandPresence = left && right ? 'both' : left ? 'left' : right ? 'right' : 'none';
    setHandPresence((prev) => (prev === next ? prev : next));
  }, []);

  // ---------- 面部帧处理（FaceTracker 回调） ----------
  const handleFaceFrame = useCallback((frame: FaceFrame) => {
    if (!faceEnabledRef.current) return;
    const output = faceDriveRef.current.update(frame, frame.timestampMs);
    controllerRef.current?.pkg?.applyFaceExpressions(output.expressions);
    setFaceStatus((prev) => (prev === output.status ? prev : output.status));
    setFaceCalibrationProgress((prev) =>
      Math.abs(prev - output.calibrationProgress) < 0.01 ? prev : output.calibrationProgress,
    );
  }, []);

  /** 手部骨骼（含 Hand 与已支持的手指）回绑定姿态。 */
  const resetHandBones = useCallback(() => {
    const pkg = controllerRef.current?.pkg;
    if (!pkg) return;
    const identity: Partial<Record<ExtendedRigBone, { x: number; y: number; z: number; w: number }>> = {};
    for (const bone of pkg.getDriver().bones.keys()) {
      if (bone.endsWith('Hand') || (FINGER_EXTENSION_BONES as readonly string[]).includes(bone)) {
        identity[bone] = { x: 0, y: 0, z: 0, w: 1 };
      }
    }
    pkg.applyBoneRotations(identity);
  }, []);

  const stopHandTracking = useCallback(() => {
    handTrackerRef.current?.stop();
    handTrackerRef.current = null;
    handEnabledRef.current = false;
    setHandEnabled(false);
    setHandPresence('none');
    handDriveRef.current.reset();
    handStabilizerRef.current.reset();
    handSmootherRef.current.reset();
    latestPoseFrameRef.current = null;
    resetHandBones(); // 关闭时手指/手掌回绑定姿态
  }, [resetHandBones]);

  const startHandTracking = useCallback(async () => {
    if (handTrackerRef.current || !videoRef.current) return;
    const bones = controllerRef.current?.pkg?.getDriver().bones;
    if (bones) {
      rigBonesRef.current = new Set(bones.keys());
      handDriveRef.current = new HandDriveManager({
        rigBones: rigBonesRef.current,
        scoreThreshold: 0.55,
        kinematicPriorWeight: 0.4,
        temporalSmoothingMs: 45,
        maxAngularVelocityDegPerSec: 900,
        handOrientationCalibrationFrames: 10,
        handTemporalSmoothingMs: 120,
        handMaxAngularVelocityDegPerSec: 300,
        handRotationDeadbandDeg: 1.5,
      });
    }
    const tracker = new HandTracker({
      wasmBasePath: '/mediapipe/wasm',
      video: videoRef.current,
      targetFps: 24,
      startDelayMs: 28, // 与姿态推理错峰，避免同帧争用
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.55,
      minTrackingConfidence: 0.6,
      onFrame: handleHandFrame,
      onError: (e) => setErrorMsg(e.message),
    });
    try {
      await tracker.start();
      handTrackerRef.current = tracker;
      handEnabledRef.current = true;
      setHandEnabled(true);
      handStabilizerRef.current.reset();
      handSmootherRef.current.reset();
      handDriveRef.current.reset();
      latestPoseFrameRef.current = null;
    } catch (err) {
      setErrorMsg(err instanceof Error ? `手部模型加载失败：${err.message}` : '手部模型加载失败');
    }
  }, [handleHandFrame]);

  const toggleHandTracking = useCallback(() => {
    if (handEnabledRef.current) stopHandTracking();
    else void startHandTracking();
  }, [startHandTracking, stopHandTracking]);

  const recalibrateHand = useCallback(() => {
    handDriveRef.current.reset();
    handStabilizerRef.current.reset();
    handSmootherRef.current.reset();
    setHandPresence('none');
    resetHandBones();
  }, [resetHandBones]);

  const stopFaceTracking = useCallback(() => {
    faceTrackerRef.current?.stop();
    faceTrackerRef.current = null;
    faceEnabledRef.current = false;
    setFaceEnabled(false);
    setFaceStatus('off');
    setFaceCalibrationProgress(0);
    faceDriveRef.current.reset();
    controllerRef.current?.pkg?.resetFaceExpressions();
  }, []);

  const startFaceTracking = useCallback(async () => {
    if (faceTrackerRef.current || !videoRef.current || faceSupport === 0) return;
    setFaceStatus('loading');
    setErrorMsg('');
    faceDriveRef.current.recalibrate();
    faceEnabledRef.current = true;
    const tracker = new FaceTracker({
      wasmBasePath: '/mediapipe/wasm',
      video: videoRef.current,
      targetFps: 20,
      startDelayMs: 56,
      minFaceDetectionConfidence: 0.6,
      minFacePresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
      onFrame: handleFaceFrame,
      onError: (e) => {
        setFaceStatus('error');
        setErrorMsg(`面部追踪异常：${e.message}`);
      },
    });
    try {
      await tracker.start();
      faceTrackerRef.current = tracker;
      setFaceEnabled(true);
      setFaceStatus('calibrating');
      setFaceCalibrationProgress(0);
    } catch (err) {
      faceEnabledRef.current = false;
      setFaceEnabled(false);
      setFaceStatus('error');
      setErrorMsg(err instanceof Error ? `面部模型加载失败：${err.message}` : '面部模型加载失败');
    }
  }, [faceSupport, handleFaceFrame]);

  const toggleFaceTracking = useCallback(() => {
    if (faceEnabledRef.current) stopFaceTracking();
    else void startFaceTracking();
  }, [startFaceTracking, stopFaceTracking]);

  const recalibrateFace = useCallback(() => {
    faceDriveRef.current.recalibrate();
    controllerRef.current?.pkg?.resetFaceExpressions();
    setFaceStatus('calibrating');
    setFaceCalibrationProgress(0);
  }, []);

  // ---------- 加载人物 ----------
  const boot = useCallback(
    async (controller: AvatarSceneController) => {
      try {
        const [{ avatar }, assetRes] = await Promise.all([
          api.getAvatar(id),
          api.listAssets({ status: 'published' }).catch(() => ({ assets: [] as AssetEntry[] })),
        ]);
        setAvatarName(avatar.name);
        const knownGarments = new Map<string, GarmentManifest>();
        for (const asset of assetRes.assets) {
          const parsed = garmentManifestSchema.safeParse(asset);
          if (parsed.success) knownGarments.set(parsed.data.id, parsed.data);
        }

        let importedModelUrl: string | undefined;
        let importCompatibleGarments: string[] | null = null;
        if (avatar.assetSource.type === 'imported') {
          const { importRecord } = await api.getImport(avatar.assetSource.importId);
          importCompatibleGarments =
            importRecord.compatibleGarments ?? importRecord.manifest?.compatibleGarments ?? [];
          importedModelUrl = await fetchAuthedObjectUrl(
            importRecord.modelUrl ?? `/api/v1/imports/${importRecord.id}/model`,
          );
        }

        const ok = await controller.loadAvatar({
          profile: avatar.profile,
          knownGarments,
          importedModelUrl,
          importCompatibleGarments,
        });
        if (!ok) throw new Error('人物模型加载失败');
        // 手部驱动可用性：rigMap 中存在手指扩展骨骼才可屈指
        const bones = controller.pkg?.getDriver().bones;
        if (bones) {
          rigBonesRef.current = new Set(bones.keys());
          handDriveRef.current = new HandDriveManager({
            rigBones: rigBonesRef.current,
            scoreThreshold: 0.55,
            kinematicPriorWeight: 0.4,
            temporalSmoothingMs: 45,
            maxAngularVelocityDegPerSec: 900,
            handOrientationCalibrationFrames: 10,
            handTemporalSmoothingMs: 120,
            handMaxAngularVelocityDegPerSec: 300,
            handRotationDeadbandDeg: 1.5,
          });
          danceHandDriveRef.current = new HandDriveManager({
            rigBones: rigBonesRef.current,
            scoreThreshold: 0.55,
            kinematicPriorWeight: 0.4,
            temporalSmoothingMs: 45,
            maxAngularVelocityDegPerSec: 900,
            handOrientationCalibrationFrames: 10,
            handTemporalSmoothingMs: 120,
            handMaxAngularVelocityDegPerSec: 300,
            handRotationDeadbandDeg: 1.5,
          });
          setFingerSupport(
            (FINGER_EXTENSION_BONES as readonly string[]).some((b) => bones.has(b as ExtendedRigBone)),
          );
        }
        setFaceSupport(controller.pkg?.getSupportedFaceExpressions().size ?? 0);
        controller.pkg?.playAnimation('idle-01');
        setActiveAnim('idle-01');
      } catch (err) {
        setFatalError(err instanceof ApiError ? err.message : '加载人物失败');
      }
    },
    [id],
  );

  const loadDefaultRoom = useCallback(async (controller?: AvatarSceneController) => {
    const target = controller ?? controllerRef.current;
    if (!target) return;
    setRoomStatus('loading');
    setRoomError('');
    const ok = await target.loadBuiltInStudioRoom();
    if (ok) {
      setRoomName('Kenney CC0 直播间');
      setRoomStatus('ready');
    } else {
      setRoomStatus('error');
      setRoomError('默认直播间加载失败');
    }
  }, []);

  const onRoomFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !controllerRef.current) return;
    if (file.size > 80 * 1024 * 1024) {
      setRoomStatus('error');
      setRoomError('房间文件不能超过 80 MB');
      return;
    }
    setRoomStatus('loading');
    setRoomError('');
    try {
      const { format } = await controllerRef.current.loadStudioRoomFile(file);
      setRoomName(`${file.name} · ${format}`);
      setRoomStatus('ready');
    } catch (error) {
      setRoomStatus('error');
      setRoomError(error instanceof Error ? error.message : '房间模型解析失败');
    }
  }, []);

  const updatePlacement = useCallback(
    (key: keyof AvatarPlacement, value: number) => {
      setPlacement((current) => {
        const next = { ...current, [key]: value };
        return controllerRef.current?.setAvatarPlacement(next) ?? next;
      });
    },
    [],
  );

  const applyPlacementPreset = useCallback((next: AvatarPlacement) => {
    const applied = controllerRef.current?.setAvatarPlacement(next) ?? next;
    setPlacement(applied);
  }, []);

  const switchCamera = useCallback((id: string) => {
    const controller = controllerRef.current;
    if (!controller?.switchStudioCamera(id)) return;
    setActiveStudioCamera(id);
    const pose = controller.getStudioCameraPresetPose(id);
    if (pose) setFreeCameraPose(pose);
  }, []);

  const switchSavedCamera = useCallback((camera: SavedCamera) => {
    controllerRef.current?.switchStudioCameraPose(camera.pose);
    setActiveStudioCamera(camera.id);
    setFreeCameraPose(camera.pose);
  }, []);

  const readCurrentCameraAsFree = useCallback(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    setFreeCameraPose(controller.getStudioCameraPose());
    setActiveStudioCamera('free');
  }, []);

  const updateFreeCamera = useCallback(
    (group: 'position' | 'target', axis: 0 | 1 | 2, value: number) => {
      if (!Number.isFinite(value)) return;
      setFreeCameraPose((current) => {
        const tuple = [...current[group]] as [number, number, number];
        tuple[axis] = Math.min(12, Math.max(-12, value));
        const next = { ...current, [group]: tuple };
        controllerRef.current?.switchStudioCameraPose(next, false);
        setActiveStudioCamera('free');
        return next;
      });
    },
    [],
  );

  const updateFreeCameraFov = useCallback((value: number) => {
    if (!Number.isFinite(value)) return;
    setFreeCameraPose((current) => {
      const next = { ...current, fov: Math.min(70, Math.max(20, value)) };
      controllerRef.current?.switchStudioCameraPose(next, false);
      setActiveStudioCamera('free');
      return next;
    });
  }, []);

  const saveCurrentCamera = useCallback(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    setSavedCameras((current) => {
      const sequence = current.length + 1;
      const saved: SavedCamera = {
        id: `custom-${Date.now()}`,
        label: `自定义 ${sequence}`,
        pose: controller.getStudioCameraPose(),
      };
      return [...current.slice(-3), saved];
    });
  }, []);

  const onViewportInit = useCallback(
    (controller: AvatarSceneController) => {
      controllerRef.current = controller;
      controller.switchStudioCamera('front', false);
      void boot(controller);
      void loadDefaultRoom(controller);
    },
    [boot, loadDefaultRoom],
  );

  // 卸载时释放摄像头与手部模型
  useEffect(() => {
    return () => {
      if (stanceTimerRef.current !== null) window.clearTimeout(stanceTimerRef.current);
      handTrackerRef.current?.stop();
      handTrackerRef.current = null;
      faceTrackerRef.current?.stop();
      faceTrackerRef.current = null;
      trackerRef.current?.stop();
      trackerRef.current = null;
      danceTrackerRef.current?.stop();
      danceTrackerRef.current = null;
      danceHandTrackerRef.current?.stop();
      danceHandTrackerRef.current = null;
      danceRecorderRef.current?.cancel();
      danceRecorderRef.current = null;
      if (danceSourceUrlRef.current) URL.revokeObjectURL(danceSourceUrlRef.current);
      if (danceOutputUrlRef.current) URL.revokeObjectURL(danceOutputUrlRef.current);
    };
  }, []);

  // 姿态校准完成后自动开启面捕；避免模型加载与站姿校准争用主线程。
  useEffect(() => {
    if (
      driveState === 'driving' &&
      !faceAutoStartedRef.current &&
      !faceEnabledRef.current &&
      faceStatus !== 'error'
    ) {
      faceAutoStartedRef.current = true;
      void startFaceTracking();
    }
  }, [driveState, faceStatus, startFaceTracking]);

  // ---------- 预置动作 ----------
  const play = (animId: PresetAnimationId) => {
    if (driveState === 'calibrating' || driveState === 'driving') return;
    if (
      danceStateRef.current === 'analyzing' ||
      danceStateRef.current === 'previewing' ||
      danceStateRef.current === 'recording'
    ) {
      return;
    }
    if (stance === 'transition') return;
    if (animId === 'sit-down-01' && stance !== 'standing') return;
    if (animId === 'stand-up-01' && stance !== 'seated') return;
    if (
      stance === 'seated' &&
      animId !== 'stand-up-01' &&
      animId !== 'sit-down-01'
    ) return;
    const pkg = controllerRef.current?.pkg;
    if (!pkg?.playAnimation(animId)) return;
    setActiveAnim(animId);
    if (animId === 'belly-laugh-01') pkg.applyFaceExpressions({ happy: 0.9, aa: 0.32 });
    else if (animId === 'cheer-01') pkg.applyFaceExpressions({ happy: 0.72 });
    else pkg.resetFaceExpressions();

    if (animId === 'sit-down-01' || animId === 'stand-up-01') {
      setStance('transition');
      if (stanceTimerRef.current !== null) window.clearTimeout(stanceTimerRef.current);
      stanceTimerRef.current = window.setTimeout(() => {
        setStance(animId === 'sit-down-01' ? 'seated' : 'standing');
        stanceTimerRef.current = null;
      }, 2050);
    } else {
      setStance('standing');
    }
  };

  // ---------- 摄像头驱动 ----------
  const startCamera = async () => {
    setErrorMsg('');
    if (
      danceStateRef.current === 'analyzing' ||
      danceStateRef.current === 'previewing' ||
      danceStateRef.current === 'recording'
    ) {
      setErrorMsg('请先停止真人视频复现，再启动摄像头驱动');
      return;
    }
    if (stance !== 'standing') {
      setErrorMsg(stance === 'seated' ? '请先播放“站起”，再启动摄像头驱动' : '请等待起坐动作完成');
      return;
    }
    if (stanceTimerRef.current !== null) {
      window.clearTimeout(stanceTimerRef.current);
      stanceTimerRef.current = null;
    }
    faceAutoStartedRef.current = false;
    setDrive('starting');
    const mode = trackingModeRef.current;
    try {
      const tracker = new CameraPoseTracker({
        wasmBasePath: '/mediapipe/wasm',
        modelVariant: poseQuality === 'accurate' ? 'heavy' : 'full',
        quality: {
          targetFps: 30,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        },
        video: videoRef.current ?? undefined,
        trackingMode: mode,
        onFrame: handleFrame,
        onError: (e) => setErrorMsg(e.message),
      });
      trackerRef.current = tracker;
      await tracker.start();
      smootherRef.current.reset();
      crouchMotionRef.current.reset();
      controllerRef.current?.pkg?.applyHipsOffsetY(0);
      lossMgrRef.current = new TrackingLossManager({ trackingMode: mode });
      const session = new CalibrationSession({ durationMs: 2500, mirror: false, trackingMode: mode });
      sessionRef.current = session;
      session.begin();
      setCalibState(session.getState());
      setDrive('calibrating');
    } catch (err) {
      trackerRef.current = null;
      setDrive('denied');
      setErrorMsg(
        err instanceof Error && err.name === 'NotAllowedError'
          ? '摄像头权限被拒绝'
          : err instanceof Error
            ? err.message
            : '摄像头启动失败',
      );
    }
  };

  const retryCalibration = () => {
    crouchMotionRef.current.setBaseline(null);
    controllerRef.current?.pkg?.applyHipsOffsetY(0);
    if (sessionRef.current) {
      sessionRef.current.begin();
      setCalibState(sessionRef.current.getState());
    } else {
      const session = new CalibrationSession({
        durationMs: 2500,
        mirror: false,
        trackingMode: trackingModeRef.current,
      });
      sessionRef.current = session;
      session.begin();
      setCalibState(session.getState());
    }
    setDrive('calibrating');
  };

  const stopDriving = () => {
    stopHandTracking();
    stopFaceTracking();
    trackerRef.current?.stop();
    trackerRef.current = null;
    sessionRef.current = null;
    calibrationRef.current = null;
    crouchMotionRef.current.setBaseline(null);
    controllerRef.current?.pkg?.applyHipsOffsetY(0);
    setCalibState(null);
    setDrive('idle');
    // 回待机动作
    controllerRef.current?.pkg?.playAnimation('idle-01');
    setActiveAnim('idle-01');
  };

  // ---------- 真人视频复现与数字人视频导出 ----------
  const stopDanceModels = () => {
    danceTrackerRef.current?.stop();
    danceTrackerRef.current = null;
    danceHandTrackerRef.current?.stop();
    danceHandTrackerRef.current = null;
  };

  const clearDanceOutput = () => {
    if (danceOutputUrlRef.current) {
      URL.revokeObjectURL(danceOutputUrlRef.current);
      danceOutputUrlRef.current = null;
    }
    setDanceOutputUrl(null);
  };

  const cancelDanceRun = () => {
    danceRunTokenRef.current += 1;
    danceFinishingRef.current = false;
    danceVideoRef.current?.pause();
    stopDanceModels();
    danceRecorderRef.current?.cancel();
    danceRecorderRef.current = null;
    danceCompleterRef.current.reset();
    danceConfidenceStatsRef.current = {
      frames: 0,
      activeFrames: 0,
      rawSum: 0,
      effectiveSum: 0,
      covered80: 0,
      inferredLandmarks: 0,
    };
    danceSmootherRef.current.reset();
    danceLossMgrRef.current.reset();
    danceHandStabilizerRef.current.reset();
    danceHandSmootherRef.current.reset();
    danceHandDriveRef.current.reset();
    danceCrouchMotionRef.current.reset();
    controllerRef.current?.pkg?.applyHipsOffsetY(0);
    latestDancePoseRef.current = null;
    setDanceProgress(0);
    setDanceTrackingStatus('tracking');
    setDanceHandPresence('none');
    setDanceRecognitionMetrics(null);
    setDanceState(danceInfo ? 'ready' : 'empty');
    controllerRef.current?.pkg?.playAnimation('idle-01');
    setActiveAnim('idle-01');
  };

  const finishDanceRun = async () => {
    if (danceFinishingRef.current) return;
    const state = danceStateRef.current;
    if (state !== 'previewing' && state !== 'recording') return;
    danceFinishingRef.current = true;
    danceVideoRef.current?.pause();
    stopDanceModels();
    setDanceProgress(1);
    const stats = danceConfidenceStatsRef.current;
    if (stats.frames > 0) {
      setDanceRecognitionMetrics({
        frames: stats.frames,
        rawConfidence: stats.rawSum / stats.frames,
        effectiveConfidence: stats.effectiveSum / Math.max(1, stats.activeFrames),
        coverage80: stats.covered80 / Math.max(1, stats.activeFrames),
        trackingCoverage: stats.activeFrames / stats.frames,
        inferredPerFrame: stats.inferredLandmarks / Math.max(1, stats.activeFrames),
      });
    }

    try {
      if (state === 'recording' && danceRecorderRef.current) {
        const recorder = danceRecorderRef.current;
        danceRecorderRef.current = null;
        const blob = await recorder.stop();
        if (blob.size === 0) throw new Error('导出文件为空，请重新录制');
        clearDanceOutput();
        const outputUrl = URL.createObjectURL(blob);
        danceOutputUrlRef.current = outputUrl;
        setDanceOutputUrl(outputUrl);
        const anchor = document.createElement('a');
        anchor.href = outputUrl;
        anchor.download = danceOutputName;
        anchor.click();
      }
      setDanceState('completed');
    } catch (error) {
      setDanceError(error instanceof Error ? error.message : '数字人视频导出失败');
      setDanceState('error');
    } finally {
      danceFinishingRef.current = false;
    }
  };

  const analyzeDanceVideo = async (
    video: HTMLVideoElement,
    runToken: number,
  ): Promise<void> => {
    if (danceCalibrationRef.current) return;
    setDanceState('analyzing');
    const calibrationFrames: PoseFrame[] = [];
    const tracker = new VideoFilePoseTracker({
      wasmBasePath: '/mediapipe/wasm',
      modelVariant: danceQuality === 'accurate' ? 'heavy' : 'full',
      quality: {
        targetFps: 30,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      },
      video,
      trackingMode: 'full',
    });
    danceTrackerRef.current = tracker;
    try {
      const scanFrames: Array<{ frame: PoseFrame; timeSec: number }> = [];
      const scanTimes = buildDanceCalibrationScanTimes(video.duration);
      let scanned = 0;
      await tracker.sampleTimes(scanTimes, (frame, timeSec) => {
        scanned += 1;
        setDanceProgress((scanned / scanTimes.length) * 0.7);
        if (hasDanceCalibrationCore(frame)) scanFrames.push({ frame, timeSec });
      });
      if (runToken !== danceRunTokenRef.current) throw new Error('视频分析已取消');
      const best = scanFrames.sort((a, b) => b.frame.confidence - a.frame.confidence)[0];
      if (!best) {
        throw new Error('未识别到稳定的全身姿态，请使用光线充足、头手脚完整入镜的视频');
      }
      const fineStart = Math.max(0.05, best.timeSec - 0.6);
      const fineEnd = Math.min(video.duration - 0.05, best.timeSec + 0.6);
      const fineTimes = Array.from({ length: 13 }, (_, index) =>
        Number((fineStart + ((fineEnd - fineStart) * index) / 12).toFixed(3)),
      );
      let fineScanned = 0;
      await tracker.sampleTimes(fineTimes, (frame) => {
        fineScanned += 1;
        setDanceProgress(0.7 + (fineScanned / fineTimes.length) * 0.3);
        if (frame.confidence >= 0.35 && hasDanceCalibrationCore(frame)) {
          calibrationFrames.push(frame);
        }
      });
      if (runToken !== danceRunTokenRef.current) throw new Error('视频分析已取消');
      if (calibrationFrames.length < 4) calibrationFrames.push(best.frame);
      if (calibrationFrames.length < 2) {
        throw new Error('全身姿态只短暂出现，请选择人体连续清晰可见的视频');
      }
      const calibration = calibrate(calibrationFrames, {
        mirror: false,
        visibilityThreshold: 0.45,
      });
      danceCalibrationRef.current = calibration;
      danceCrouchMotionRef.current.setBaseline(
        estimateStandingHipHeight([
          ...scanFrames.map((candidate) => candidate.frame),
          ...calibrationFrames,
        ]),
      );
      setDanceCalibrationConfidence(calibration.meanConfidence);
    } finally {
      tracker.stop();
      if (danceTrackerRef.current === tracker) danceTrackerRef.current = null;
    }
  };

  const startDanceRun = async (mode: 'preview' | 'record') => {
    const video = danceVideoRef.current;
    const file = danceFileRef.current;
    const controller = controllerRef.current;
    if (!video || !file || !danceInfo || !controller?.pkg) return;
    if (driveStateRef.current !== 'idle') {
      setDanceError('请先停止摄像头驱动，再复现真人视频');
      return;
    }
    if (mode === 'record' && !getSupportedVideoMimeType()) {
      setDanceError('当前浏览器不支持 WebM 录制，请使用最新版 Chrome 或 Edge');
      setDanceState('error');
      return;
    }

    const runToken = danceRunTokenRef.current + 1;
    danceRunTokenRef.current = runToken;
    danceFinishingRef.current = false;
    setDanceError('');
    setDanceProgress(0);
    setDanceTrackingStatus('tracking');
    setDanceHandPresence('none');
    clearDanceOutput();

    try {
      await analyzeDanceVideo(video, runToken);
      if (runToken !== danceRunTokenRef.current) return;
      setDanceProgress(0);
      await seekVideo(video, 0);

      if (stanceTimerRef.current !== null) {
        window.clearTimeout(stanceTimerRef.current);
        stanceTimerRef.current = null;
      }
      setStance('standing');
      controller.pkg.stopAnimation();
      controller.pkg.resetFaceExpressions();
      setActiveAnim(null);
      danceCompleterRef.current.reset();
      danceConfidenceStatsRef.current = {
        frames: 0,
        activeFrames: 0,
        rawSum: 0,
        effectiveSum: 0,
        covered80: 0,
        inferredLandmarks: 0,
      };
      setDanceRecognitionMetrics(null);
      danceSmootherRef.current.reset();
      danceLossMgrRef.current = new TrackingLossManager({
        trackingMode: 'full',
        confidenceThreshold: 0.48,
        freezeDelayMs: 300,
        blendStartMs: 750,
        blendDurationMs: 450,
      });
      danceHandStabilizerRef.current.reset();
      danceHandSmootherRef.current.reset();
      danceHandDriveRef.current.reset();
      danceCrouchMotionRef.current.reset();
      controller.pkg.applyHipsOffsetY(0);
      latestDancePoseRef.current = null;

      const poseTracker = new VideoFilePoseTracker({
        wasmBasePath: '/mediapipe/wasm',
        modelVariant: danceQuality === 'accurate' ? 'heavy' : 'full',
        quality: {
          targetFps: 30,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        },
        video,
        trackingMode: 'full',
        onError: (error) => setDanceError(`姿态识别异常：${error.message}`),
      });
      danceTrackerRef.current = poseTracker;

      const handTracker = new HandTracker({
        wasmBasePath: '/mediapipe/wasm',
        video,
        frameTimestampSource: 'video',
        targetFps: 24,
        startDelayMs: 28,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.55,
        minTrackingConfidence: 0.6,
        onFrame: handleDanceHandFrame,
        onError: (error) => setDanceError(`手部细节识别降级：${error.message}`),
      });
      danceHandTrackerRef.current = handTracker;

      // 两个模型并行预热；手部模型失败时仍保留完整的身体舞蹈驱动。
      await Promise.all([
        poseTracker.load(),
        handTracker.start().catch(() => {
          if (danceHandTrackerRef.current === handTracker) danceHandTrackerRef.current = null;
        }),
      ]);
      if (runToken !== danceRunTokenRef.current) {
        stopDanceModels();
        return;
      }

      if (mode === 'record') {
        const renderSize = controller.getRenderSize();
        if (renderSize.width === 0 || renderSize.height === 0) {
          throw new Error('直播间画布尚未就绪');
        }
        const recorder = new CanvasVideoRecorder();
        recorder.start(controller.getRenderCanvas(), {
          fps: 30,
          videoBitsPerSecond: 8_000_000,
          sourceVideo: video,
        });
        danceRecorderRef.current = recorder;
        setDanceState('recording');
      } else {
        setDanceState('previewing');
      }

      await poseTracker.start(handleDanceFrame);
    } catch (error) {
      if (runToken !== danceRunTokenRef.current) return;
      stopDanceModels();
      danceRecorderRef.current?.cancel();
      danceRecorderRef.current = null;
      setDanceError(error instanceof Error ? error.message : '真人视频分析失败');
      setDanceState('error');
    }
  };

  const onDanceFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !danceVideoRef.current) return;
    if (!file.type.startsWith('video/') && !/\.(mp4|webm|mov|m4v)$/i.test(file.name)) {
      setDanceError('请选择 MP4、WebM、MOV 或 M4V 视频文件');
      setDanceState('error');
      return;
    }
    if (file.size > 500 * 1024 * 1024) {
      setDanceError('视频文件不能超过 500 MB');
      setDanceState('error');
      return;
    }

    if (
      danceStateRef.current === 'analyzing' ||
      danceStateRef.current === 'previewing' ||
      danceStateRef.current === 'recording'
    ) {
      cancelDanceRun();
    }
    clearDanceOutput();
    danceCalibrationRef.current = null;
    danceCrouchMotionRef.current.setBaseline(null);
    setDanceCalibrationConfidence(null);
    setDanceInfo(null);
    setDanceError('');
    setDanceState('loading');
    if (danceSourceUrlRef.current) URL.revokeObjectURL(danceSourceUrlRef.current);
    const sourceUrl = URL.createObjectURL(file);
    danceSourceUrlRef.current = sourceUrl;
    danceFileRef.current = file;

    const video = danceVideoRef.current;
    try {
      const metadataReady = new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          video.removeEventListener('loadedmetadata', onLoaded);
          video.removeEventListener('error', onError);
        };
        const onLoaded = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error('视频解码失败，请尝试 H.264 MP4 或 VP9 WebM 格式'));
        };
        video.addEventListener('loadedmetadata', onLoaded, { once: true });
        video.addEventListener('error', onError, { once: true });
      });
      video.src = sourceUrl;
      video.load();
      await metadataReady;
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        throw new Error('无法读取视频时长');
      }
      // 容忍容器尾帧时间戳略超标（例如 15:00.012）。
      if (video.duration > 15 * 60 + 1) {
        throw new Error('单个视频最长支持 15 分钟，请先裁剪后再导入');
      }
      const info: DanceVideoInfo = {
        name: file.name,
        durationSec: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
        sizeBytes: file.size,
      };
      setDanceInfo(info);
      const baseName = file.name.replace(/\.[^.]+$/, '') || 'dance';
      setDanceOutputName(`${baseName}-digital-human.webm`);
      setDanceState('ready');
    } catch (error) {
      setDanceError(error instanceof Error ? error.message : '视频读取失败');
      setDanceState('error');
    }
  };

  if (fatalError) {
    return (
      <div className="page center-page">
        <p className="form-error">{fatalError}</p>
        <button className="btn" onClick={() => navigate(`/avatars?workspace=${workspace}`)}>
          返回我的数字人
        </button>
      </div>
    );
  }

  const cameraActive = driveState === 'calibrating' || driveState === 'driving';
  const danceBusy =
    danceState === 'analyzing' ||
    danceState === 'previewing' ||
    danceState === 'recording';
  const runtimeBusy = cameraActive || danceBusy;
  const trackingLost = driveState === 'driving' && (trackingStatus === 'lost' || trackingStatus === 'blending');
  const danceTrackingLost =
    (danceState === 'previewing' || danceState === 'recording') &&
    (danceTrackingStatus === 'lost' || danceTrackingStatus === 'blending');
  const activeCameraLabel =
    STUDIO_CAMERA_PRESETS.find((camera) => camera.id === activeStudioCamera)?.label ??
    savedCameras.find((camera) => camera.id === activeStudioCamera)?.label ??
    '自由视角';

  return (
    <div className="motion-page">
      <header className="editor-topbar">
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => navigate(`/avatars?workspace=${workspace}`)}
        >
          ← 返回
        </button>
        <span className="motion-title">
          {workspace === 'studio' ? '虚拟直播间' : '真人视频复现'} · {avatarName || '加载中…'}
        </span>
        <nav className="workspace-topnav" aria-label="数字人工作区">
          <button
            className={`btn btn-sm ${workspace === 'studio' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => navigate(`/motion/${id}`)}
          >
            直播间
          </button>
          <button
            className={`btn btn-sm ${workspace === 'video' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => navigate(`/video/${id}`)}
          >
            视频复现
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => navigate(`/editor/${id}`)}>
            人物装扮
          </button>
        </nav>
      </header>

      <div className="motion-body">
        {/* 左侧三维视窗 + 摄像头小窗 */}
        <AvatarViewport
          onInit={onViewportInit}
          overlay={
            <>
              <div className="studio-live-hud">
                <span
                  className={`studio-live-dot ${danceState === 'recording' ? 'recording' : ''}`}
                />
                {danceState === 'recording' ? 'REC' : 'PREVIEW'}
                <span className="studio-camera-name">{activeCameraLabel}</span>
              </div>
              <video
                ref={videoRef}
                className={`cam-preview ${workspace === 'studio' && cameraActive ? 'active' : ''}`}
                muted
                playsInline
              />
              <video
                ref={danceVideoRef}
                className={`dance-video-preview ${
                  workspace === 'video' && danceInfo ? 'active' : ''
                }`}
                muted
                playsInline
                preload="metadata"
                onTimeUpdate={(event) => {
                  const video = event.currentTarget;
                  if (video.duration) setDanceProgress(Math.min(1, video.currentTime / video.duration));
                }}
                onEnded={() => void finishDanceRun()}
              />
              {workspace === 'video' && danceInfo && (
                <div className="dance-source-label">
                  真人源视频 · 不镜像
                </div>
              )}
              {workspace === 'studio' && driveState === 'calibrating' && calibState && (
                <div className="calib-panel">
                  <h3>站姿校准{trackingMode === 'upper' ? '（上半身）' : ''}</h3>
                  <p className="muted">
                    {trackingMode === 'upper'
                      ? '请面对摄像头，肩到手腕保持在画面中，保持姿势约 2.5 秒'
                      : '请面对摄像头站立，保持 A/T Pose 约 2.5 秒'}
                  </p>
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${calibState.progress * 100}%` }} />
                  </div>
                  {calibState.feedback.map((f, i) => (
                    <p key={i} className={calibState.status === 'failed' ? 'form-error' : 'calib-feedback'}>
                      {f}
                    </p>
                  ))}
                  <div className="vis-chips">
                    {Object.entries(calibState.visibilitySummary).map(([label, v]) => (
                      <span key={label} className={`vis-chip ${v > 0.5 ? 'ok' : 'bad'}`}>
                        {label} {(v * 100).toFixed(0)}%
                      </span>
                    ))}
                  </div>
                  {calibState.status === 'failed' && (
                    <button className="btn btn-sm btn-primary" onClick={retryCalibration}>
                      重新校准
                    </button>
                  )}
                </div>
              )}
              {workspace === 'studio' && trackingLost && (
                <div className="viewport-banner warning">跟踪已丢失，请回到画面中央</div>
              )}
              {workspace === 'video' && danceTrackingLost && (
                <div className="viewport-banner warning">
                  此段人体被遮挡，已平滑保持最近可信姿态
                </div>
              )}
            </>
          }
        />

        {/* 右侧控制面板 */}
        <aside className="motion-panel">
          <section className="workspace-guide">
            <span className="workflow-step-number">步骤 2 / 3</span>
            <h3>
              {workspace === 'studio' ? '布置画面并开始驱动' : '导入视频并检查复现效果'}
            </h3>
            <p>
              {workspace === 'studio'
                ? '按“房间 → 机位 → 人物 → 动作驱动”的顺序设置。各组工具互不混杂。'
                : '此页面只处理真人视频识别、预览和导出，不显示直播间实时动捕设置。'}
            </p>
          </section>

          {workspace === 'studio' && (
            <>
              <div className="studio-tool-tabs" role="tablist" aria-label="直播间工具">
                <button
                  role="tab"
                  aria-selected={studioToolTab === 'scene'}
                  className={studioToolTab === 'scene' ? 'active' : ''}
                  onClick={() => setStudioToolTab('scene')}
                >
                  <span>01</span>
                  场景与机位
                </button>
                <button
                  role="tab"
                  aria-selected={studioToolTab === 'motion'}
                  className={studioToolTab === 'motion' ? 'active' : ''}
                  onClick={() => setStudioToolTab('motion')}
                >
                  <span>02</span>
                  动作驱动
                </button>
                <button
                  role="tab"
                  aria-selected={studioToolTab === 'detail'}
                  className={studioToolTab === 'detail' ? 'active' : ''}
                  onClick={() => setStudioToolTab('detail')}
                >
                  <span>03</span>
                  面部与手部
                </button>
              </div>

              {studioToolTab === 'scene' && (
                <>
          <section>
            <h3 className="param-group-title">直播房间</h3>
            <p className="muted">
              默认房间使用 Kenney CC0 室内资产。也可在浏览器本地导入 GLB、GLTF、FBX
              或 OBJ，模型不会上传。
            </p>
            <p>
              {roomStatus === 'loading' && <Badge kind="info">房间加载中</Badge>}
              {roomStatus === 'ready' && <Badge kind="success">{roomName}</Badge>}
              {roomStatus === 'error' && <Badge kind="warning">加载失败</Badge>}
              {roomStatus === 'none' && <Badge kind="info">无房间</Badge>}
            </p>
            {roomError && <p className="form-error">{roomError}</p>}
            <input
              ref={roomInputRef}
              className="studio-file-input"
              type="file"
              accept=".glb,.gltf,.fbx,.obj"
              onChange={onRoomFileChange}
            />
            <div className="mode-select studio-actions">
              <button
                className="btn btn-sm btn-primary"
                disabled={roomStatus === 'loading'}
                onClick={() => roomInputRef.current?.click()}
              >
                导入房间模型
              </button>
              <button
                className="btn btn-sm"
                disabled={roomStatus === 'loading'}
                onClick={() => void loadDefaultRoom()}
              >
                恢复默认房间
              </button>
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  controllerRef.current?.clearStudioRoom();
                  setRoomStatus('none');
                  setRoomName('');
                  setRoomError('');
                }}
              >
                隐藏房间
              </button>
            </div>
          </section>

          <section>
            <h3 className="param-group-title">导播机位</h3>
            <p className="muted">
              快捷机位只作为起点。可在左侧画面拖拽旋转、右键平移、滚轮缩放，
              也可直接输入相机和注视点坐标。
            </p>
            <p className="control-label">快捷机位</p>
            <div className="studio-camera-grid">
              {STUDIO_CAMERA_PRESETS.map((camera) => (
                <button
                  key={camera.id}
                  className={`btn btn-sm ${activeStudioCamera === camera.id ? 'btn-primary' : ''}`}
                  onClick={() => switchCamera(camera.id)}
                >
                  {camera.label}
                </button>
              ))}
              {savedCameras.map((camera) => (
                <button
                  key={camera.id}
                  className={`btn btn-sm ${activeStudioCamera === camera.id ? 'btn-primary' : ''}`}
                  onClick={() => switchSavedCamera(camera)}
                >
                  {camera.label}
                </button>
              ))}
            </div>

            <div className="free-camera-panel">
              <div className="free-camera-heading">
                <div>
                  <strong>自由机位</strong>
                  <span>坐标范围 -12 ～ 12 米</span>
                </div>
                {activeStudioCamera === 'free' && <Badge kind="success">正在使用</Badge>}
              </div>
              <div className="camera-coordinate-group">
                <span>相机位置</span>
                <div className="camera-coordinate-grid">
                  {CAMERA_AXES.map(({ label, index }) => (
                    <label key={`position-${label}`}>
                      {label}
                      <input
                        type="number"
                        min={-12}
                        max={12}
                        step={0.05}
                        value={Number(freeCameraPose.position[index].toFixed(2))}
                        onChange={(event) =>
                          updateFreeCamera('position', index, Number(event.target.value))
                        }
                      />
                    </label>
                  ))}
                </div>
              </div>
              <div className="camera-coordinate-group">
                <span>注视目标</span>
                <div className="camera-coordinate-grid">
                  {CAMERA_AXES.map(({ label, index }) => (
                    <label key={`target-${label}`}>
                      {label}
                      <input
                        type="number"
                        min={-12}
                        max={12}
                        step={0.05}
                        value={Number(freeCameraPose.target[index].toFixed(2))}
                        onChange={(event) =>
                          updateFreeCamera('target', index, Number(event.target.value))
                        }
                      />
                    </label>
                  ))}
                </div>
              </div>
              <label className="camera-fov-field">
                <span>视野角 FOV</span>
                <input
                  type="range"
                  min={20}
                  max={70}
                  step={1}
                  value={freeCameraPose.fov}
                  onChange={(event) => updateFreeCameraFov(Number(event.target.value))}
                />
                <output>{freeCameraPose.fov.toFixed(0)}°</output>
              </label>
            </div>

            <div className="mode-select studio-actions camera-actions">
              <button className="btn btn-sm btn-primary" onClick={readCurrentCameraAsFree}>
                读取左侧当前视角
              </button>
              <button className="btn btn-sm" onClick={saveCurrentCamera}>
                保存为机位
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => switchCamera('front')}>
                恢复正面
              </button>
              {savedCameras.length > 0 && (
                <button className="btn btn-sm btn-ghost" onClick={() => setSavedCameras([])}>
                  清空已保存
                </button>
              )}
            </div>
          </section>

          <section>
            <h3 className="param-group-title">人物站位</h3>
            <div className="mode-select studio-actions">
              <button
                className="btn btn-sm"
                onClick={() => applyPlacementPreset(DEFAULT_PLACEMENT)}
              >
                中央舞台
              </button>
              <button
                className="btn btn-sm"
                onClick={() =>
                  applyPlacementPreset({
                    x: -0.8,
                    y: 0,
                    z: -2.42,
                    rotationYDeg: 0,
                    scale: 1,
                  })
                }
              >
                沙发座位
              </button>
            </div>
            <SliderRow
              label="左右 X"
              value={placement.x}
              min={-3}
              max={3}
              step={0.05}
              defaultValue={0}
              onChange={(value) => updatePlacement('x', value)}
              onReset={() => updatePlacement('x', 0)}
              format={(value) => `${value.toFixed(2)} m`}
            />
            <SliderRow
              label="高度 Y"
              value={placement.y}
              min={-0.25}
              max={1}
              step={0.01}
              defaultValue={0}
              onChange={(value) => updatePlacement('y', value)}
              onReset={() => updatePlacement('y', 0)}
              format={(value) => `${value.toFixed(2)} m`}
            />
            <SliderRow
              label="前后 Z"
              value={placement.z}
              min={-3}
              max={3}
              step={0.05}
              defaultValue={0}
              onChange={(value) => updatePlacement('z', value)}
              onReset={() => updatePlacement('z', 0)}
              format={(value) => `${value.toFixed(2)} m`}
            />
            <SliderRow
              label="朝向"
              value={placement.rotationYDeg}
              min={-180}
              max={180}
              step={1}
              defaultValue={0}
              onChange={(value) => updatePlacement('rotationYDeg', value)}
              onReset={() => updatePlacement('rotationYDeg', 0)}
              format={(value) => `${value.toFixed(0)}°`}
            />
            <SliderRow
              label="人物缩放"
              value={placement.scale}
              min={0.6}
              max={1.5}
              step={0.01}
              defaultValue={1}
              onChange={(value) => updatePlacement('scale', value)}
              onReset={() => updatePlacement('scale', 1)}
              format={(value) => `${value.toFixed(2)}×`}
            />
          </section>
                </>
              )}

              {studioToolTab === 'motion' && (
          <section>
            <h3 className="param-group-title">预置动作</h3>
            <div className="preset-btns">
              {PRESET_ANIMATION_DEFINITIONS.map((p) => {
                const unavailableForStance =
                  stance === 'transition' ||
                  (p.id === 'sit-down-01' && stance !== 'standing') ||
                  (p.id === 'stand-up-01' && stance !== 'seated') ||
                  (stance === 'seated' &&
                    p.id !== 'sit-down-01' &&
                    p.id !== 'stand-up-01');
                return (
                <button
                  key={p.id}
                  className={`btn ${activeAnim === p.id ? 'btn-primary' : ''}`}
                  disabled={runtimeBusy || unavailableForStance}
                  onClick={() => play(p.id)}
                >
                  {p.label}
                </button>
                );
              })}
            </div>
            <p className="muted">
              状态：
              {stance === 'standing' ? '站立' : stance === 'seated' ? '坐姿' : '动作过渡中'}
              。坐下与站起共享反向关键帧并保持末帧，导入人物按绑定骨架重定向。
            </p>
            {runtimeBusy && <p className="muted">骨架驱动中，预置动作已暂停。</p>}
          </section>
              )}
            </>
          )}

          {workspace === 'video' && (
          <section>
            <h3 className="param-group-title">
              真人舞蹈复现 <Badge kind="info">本地 AI</Badge>
            </h3>
            <p className="muted">
              导入真人全身视频后，系统会逐帧识别身体、手掌和手指，自动标定并驱动当前
              数字人。源视频不镜像，左右手按解剖学对应；原视频、关键点和导出文件均不上传。
            </p>
            <input
              ref={danceInputRef}
              className="studio-file-input"
              type="file"
              accept="video/mp4,video/webm,video/quicktime,.m4v"
              onChange={(event) => void onDanceFileChange(event)}
            />
            {danceInfo ? (
              <div className="dance-file-card">
                <strong title={danceInfo.name}>{danceInfo.name}</strong>
                <span className="muted">
                  {danceInfo.width}×{danceInfo.height} · {formatDuration(danceInfo.durationSec)} ·{' '}
                  {(danceInfo.sizeBytes / 1024 / 1024).toFixed(1)} MB
                </span>
              </div>
            ) : (
              <p className="muted">支持 MP4、WebM、MOV、M4V，单文件不超过 500 MB / 15 分钟。</p>
            )}

            <div className="mode-select">
              <button
                className={`btn btn-sm ${danceQuality === 'accurate' ? 'btn-primary' : ''}`}
                disabled={danceBusy}
                onClick={() => {
                  setDanceQuality('accurate');
                  danceCalibrationRef.current = null;
                  setDanceCalibrationConfidence(null);
                }}
              >
                精准复现
              </button>
              <button
                className={`btn btn-sm ${danceQuality === 'smooth' ? 'btn-primary' : ''}`}
                disabled={danceBusy}
                onClick={() => {
                  setDanceQuality('smooth');
                  danceCalibrationRef.current = null;
                  setDanceCalibrationConfidence(null);
                }}
              >
                流畅复现
              </button>
            </div>
            <p className="muted">
              {danceQuality === 'accurate'
                ? '使用 Heavy 高精度全身模型（推荐），并叠加短时遮挡推理、骨长约束、21 点双手识别、蹲起脚底锁定与分级抗抖。'
                : '使用 Full 轻量模型，保留时序推理、骨长约束和蹲起脚底锁定，适合较长视频或低配电脑。'}
            </p>

            {(danceBusy || danceState === 'completed') && (
              <>
                <div className="dance-progress-meta">
                  <span>
                    {danceState === 'analyzing'
                      ? '正在扫描清晰全身片段并自动标定…'
                      : danceState === 'recording'
                        ? '正在录制数字人视频'
                        : danceState === 'previewing'
                          ? '正在预览复现'
                          : '处理完成'}
                  </span>
                  <span>{Math.round(danceProgress * 100)}%</span>
                </div>
                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: `${danceProgress * 100}%` }} />
                </div>
              </>
            )}

            {danceCalibrationConfidence !== null && (
              <p>
                <Badge kind={danceCalibrationConfidence >= 0.65 ? 'success' : 'warning'}>
                  标定置信度 {(danceCalibrationConfidence * 100).toFixed(0)}%
                </Badge>{' '}
                {(danceState === 'previewing' || danceState === 'recording') && (
                  <>
                    <Badge kind={danceTrackingStatus === 'tracking' ? 'success' : 'warning'}>
                      {danceTrackingStatus === 'tracking' ? '身体稳定' : '遮挡回退'}
                    </Badge>{' '}
                    <Badge kind={danceHandPresence === 'none' ? 'info' : 'success'}>
                      {danceHandPresence === 'both'
                        ? '双手细节'
                        : danceHandPresence === 'left'
                          ? '左手细节'
                          : danceHandPresence === 'right'
                            ? '右手细节'
                            : '未检出手部细节'}
                    </Badge>
                  </>
                )}
              </p>
            )}
            {danceRecognitionMetrics && (
              <p className="dance-confidence-row">
                <Badge
                  kind={
                    danceRecognitionMetrics.effectiveConfidence >= 0.8
                      ? 'success'
                      : 'warning'
                  }
                >
                  有效置信度{' '}
                  {(danceRecognitionMetrics.effectiveConfidence * 100).toFixed(0)}%
                </Badge>{' '}
                <Badge
                  kind={danceRecognitionMetrics.coverage80 >= 0.8 ? 'success' : 'warning'}
                >
                  ≥80% 帧覆盖 {(danceRecognitionMetrics.coverage80 * 100).toFixed(0)}%
                </Badge>{' '}
                <Badge
                  kind={danceRecognitionMetrics.trackingCoverage >= 0.8 ? 'success' : 'warning'}
                >
                  人物追踪 {(danceRecognitionMetrics.trackingCoverage * 100).toFixed(0)}%
                </Badge>{' '}
                <Badge kind="info">
                  时序推理 {danceRecognitionMetrics.inferredPerFrame.toFixed(1)} 点/帧
                </Badge>
                <span className="dance-confidence-detail">
                  MediaPipe 原始均值{' '}
                  {(danceRecognitionMetrics.rawConfidence * 100).toFixed(0)}%，
                  有效值和 ≥80% 覆盖仅统计检测或短时推理仍有效的帧；长时间人物离开画面
                  不会凭空生成姿态，也不会覆盖原始分数。
                </span>
              </p>
            )}

            {danceState === 'loading' && <p className="muted">正在读取本地视频元数据…</p>}
            {danceState === 'completed' && (
              <p>
                <Badge kind="success">
                  {danceOutputUrl ? '导出完成，已开始下载' : '预览完成'}
                </Badge>
              </p>
            )}
            {danceError && <p className="form-error">{danceError}</p>}

            <div className="mode-select studio-actions dance-actions">
              <button
                className="btn btn-sm"
                disabled={danceBusy}
                onClick={() => danceInputRef.current?.click()}
              >
                {danceInfo ? '更换真人视频' : '导入真人视频'}
              </button>
              <button
                className="btn btn-sm"
                disabled={!danceInfo || danceBusy || cameraActive}
                onClick={() => void startDanceRun('preview')}
              >
                预览复现
              </button>
              <button
                className="btn btn-sm btn-primary"
                disabled={!danceInfo || danceBusy || cameraActive}
                onClick={() => void startDanceRun('record')}
              >
                导出数字人视频
              </button>
              {danceBusy && (
                <button className="btn btn-sm btn-danger" onClick={cancelDanceRun}>
                  停止
                </button>
              )}
              {danceOutputUrl && (
                <a className="btn btn-sm" href={danceOutputUrl} download={danceOutputName}>
                  再次下载 WebM
                </a>
              )}
            </div>
            <p className="muted">
              导出内容是左侧当前画面；可在开始前用鼠标旋转、平移或缩放调整构图。
              浏览器支持时保留原视频声音，否则输出无声 WebM。
            </p>
            <p className="muted">
              建议使用固定机位、均匀光照、头手脚完整入镜且遮挡较少的正面或 45° 舞蹈视频。
            </p>
          </section>
          )}

          {workspace === 'studio' && (
            <>
              {studioToolTab === 'motion' && (
          <section>
            <h3 className="param-group-title">摄像头姿态驱动</h3>
            {driveState === 'idle' && (
              <>
                <div className="mode-select">
                  <button
                    className={`btn btn-sm ${trackingMode === 'full' ? 'btn-primary' : ''}`}
                    onClick={() => setTrackingMode('full')}
                  >
                    全身
                  </button>
                  <button
                    className={`btn btn-sm ${trackingMode === 'upper' ? 'btn-primary' : ''}`}
                    onClick={() => setTrackingMode('upper')}
                  >
                    仅上半身
                  </button>
                </div>
                <div className="mode-select">
                  <button
                    className={`btn btn-sm ${poseQuality === 'accurate' ? 'btn-primary' : ''}`}
                    onClick={() => setPoseQuality('accurate')}
                  >
                    精准
                  </button>
                  <button
                    className={`btn btn-sm ${poseQuality === 'smooth' ? 'btn-primary' : ''}`}
                    onClick={() => setPoseQuality('smooth')}
                  >
                    流畅
                  </button>
                </div>
                <p className="muted">
                  {poseQuality === 'accurate'
                    ? '精准档：使用 heavy 高精度模型（约 29MB，完全本地加载），动作跟随更准确，推荐桌面电脑使用。'
                    : '流畅档：使用 full 轻量模型，推理更快，适合低配设备。'}
                </p>
                <p className="muted">
                  {trackingMode === 'full'
                    ? '全身模式：需距离摄像头 2–3 米，头、手、脚完整入镜；支持蹲起重心下降和脚底锁定。'
                    : '上半身模式：只需肩到手腕入镜，可坐近使用；髋关节和双腿不被驱动，保持当前姿态。'}
                </p>
                <p className="muted">
                  使用电脑摄像头实时驱动数字人。视频与关键点完全在浏览器本地处理，不会上传。
                  建议正面均匀光照。
                </p>
                <button
                  className="btn btn-primary"
                  disabled={stance !== 'standing' || danceBusy}
                  title={
                    danceBusy
                      ? '请先停止真人视频复现'
                      : stance !== 'standing'
                        ? '请先完成站起动作'
                        : undefined
                  }
                  onClick={() => void startCamera()}
                >
                  启动摄像头驱动
                </button>
                {stance !== 'standing' && <p className="muted">请先完成“站起”动作，避免实时骨架与坐姿冲突。</p>}
              </>
            )}
            {driveState === 'starting' && <p className="muted">正在请求摄像头权限并加载姿态模型…</p>}
            {driveState === 'calibrating' && (
              <>
                <p>校准中：完成左侧引导的站姿校准后方可进入驱动。</p>
                <button className="btn" onClick={stopDriving}>
                  取消
                </button>
              </>
            )}
            {driveState === 'driving' && (
              <>
                <p>
                  状态：
                  {trackingStatus === 'tracking' ? (
                    <Badge kind="success">跟踪正常</Badge>
                  ) : (
                    <Badge kind="warning">跟踪丢失</Badge>
                  )}
                </p>
                <button className="btn" onClick={retryCalibration}>
                  重新校准
                </button>
                <button className="btn btn-danger" onClick={stopDriving}>
                  停止驱动
                </button>
              </>
            )}
            {driveState === 'denied' && (
              <div className="denied-box">
                <p className="form-error">{errorMsg || '摄像头权限被拒绝'}</p>
                <p className="muted">
                  请在浏览器地址栏左侧的站点设置中允许摄像头访问，然后重试。
                  无法使用摄像头时，仍可播放上方预置动作。
                </p>
                <button className="btn" onClick={() => void startCamera()}>
                  重试
                </button>
                <button className="btn btn-ghost" onClick={() => setDrive('idle')}>
                  使用预置动作
                </button>
              </div>
            )}
            {errorMsg && driveState !== 'denied' && <p className="form-error">{errorMsg}</p>}
          </section>
              )}

              {studioToolTab === 'detail' && (
                <>
          <section>
            <h3 className="param-group-title">面部表情追踪</h3>
            <p className="muted">
              单人 478 点面部定位与 52 项表情系数，支持独立眨眼、眼球方向、口型和基础情绪。
              首次开启时请正视镜头并保持自然中性表情约 1 秒。
            </p>
            {faceSupport !== null && (
              <p>
                {faceSupport > 0 ? (
                  <Badge kind="success">该人物支持 {faceSupport} 项标准表情</Badge>
                ) : (
                  <Badge kind="warning">该模型未提供可驱动的表情 Morph</Badge>
                )}
              </p>
            )}
            {!cameraActive && <p className="muted">启动摄像头驱动后将自动开启面部追踪。</p>}
            {faceStatus === 'loading' && <p className="muted">正在加载本地面部模型…</p>}
            {faceStatus === 'calibrating' && (
              <>
                <p>中性脸标定中，请自然注视镜头。</p>
                <div className="progress-bar">
                  <div
                    className="progress-fill"
                    style={{ width: `${faceCalibrationProgress * 100}%` }}
                  />
                </div>
              </>
            )}
            {faceStatus === 'tracking' && <Badge kind="success">面部跟踪正常</Badge>}
            {faceStatus === 'lost' && <Badge kind="warning">未检测到完整面部</Badge>}
            {faceStatus === 'error' && <Badge kind="warning">面部追踪异常</Badge>}
            <div className="mode-select face-actions">
              <button
                className={`btn btn-sm ${faceEnabled ? 'btn-primary' : ''}`}
                disabled={!cameraActive || faceSupport === 0 || faceStatus === 'loading'}
                onClick={toggleFaceTracking}
              >
                {faceEnabled ? '面部追踪：开' : '面部追踪：关'}
              </button>
              {faceEnabled && (
                <button className="btn btn-sm" onClick={recalibrateFace}>
                  重标中性脸
                </button>
              )}
            </div>
          </section>

          <section>
            <h3 className="param-group-title">
              高精度手部追踪 <Badge kind="info">实验性</Badge>
            </h3>
            <p className="muted">
              24 FPS 双手 21 点追踪，融合 Pose 腕点身份校验、KalidoKit 指节运动学先验、
              Pose 掌根方向锚定、手掌/手指分级抗抖及异常翻转抑制。开启或重标后请将
              双手自然张开放稳约半秒；五指驱动需要 VRM 模型带手指骨骼，内置底模仅
              手掌朝向生效。
            </p>
            {fingerSupport !== null && (
              <p>
                {fingerSupport ? (
                  <Badge kind="success">该人物支持手指</Badge>
                ) : (
                  <Badge kind="warning">该人物无手指骨骼，仅手掌朝向生效</Badge>
                )}
              </p>
            )}
            {!cameraActive && <p className="muted">启动摄像头驱动后可开启手部追踪。</p>}
            <div className="mode-select">
              <button
                className={`btn btn-sm ${handEnabled ? 'btn-primary' : ''}`}
                disabled={!cameraActive}
                onClick={toggleHandTracking}
              >
                {handEnabled ? '手部追踪：开' : '手部追踪：关'}
              </button>
              {handEnabled && (
                <button className="btn btn-sm" onClick={recalibrateHand}>
                  重标手掌方向
                </button>
              )}
            </div>
            {handEnabled && (
              <p>
                检出：
                {handPresence === 'none' && <Badge kind="info">无</Badge>}
                {handPresence === 'left' && <Badge kind="success">左手</Badge>}
                {handPresence === 'right' && <Badge kind="success">右手</Badge>}
                {handPresence === 'both' && <Badge kind="success">双手</Badge>}
              </p>
            )}
          </section>
                </>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
