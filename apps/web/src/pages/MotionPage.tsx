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
  FaceDriveManager,
  type FaceTrackingStatus,
  LandmarkSmoother,
  TrackingLossManager,
  mapPoseFrameToBoneRotations,
  type CalibrationData,
  type TrackingStatus,
} from '@dhp/rig-mapping';
import {
  CalibrationSession,
  CameraPoseTracker,
  FaceTracker,
  HandTracker,
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

type DriveState = 'idle' | 'starting' | 'calibrating' | 'driving' | 'denied';

/** 识别质量档：精准=heavy 模型（默认，桌面 Chrome 可实时）；流畅=full 模型（低配设备）。 */
type PoseQuality = 'accurate' | 'smooth';

/** 手部检出状态（面板显示）。 */
type HandPresence = 'none' | 'left' | 'right' | 'both';

type AvatarStance = 'standing' | 'seated' | 'transition';
type RoomStatus = 'loading' | 'ready' | 'error' | 'none';

const DEFAULT_PLACEMENT: AvatarPlacement = {
  x: 0,
  y: 0,
  z: 0,
  rotationYDeg: 0,
  scale: 1,
};

interface SavedCamera {
  id: string;
  label: string;
  pose: StudioCameraPose;
}

/**
 * 虚拟直播间：房间/机位/站位编排 + 预置动作 + 摄像头姿态驱动。
 * 链路：CameraPoseTracker → LandmarkSmoother →（校准）/ mapPoseFrameToBoneRotations
 * → TrackingLossManager → applyBoneRotations。全程浏览器本地处理。
 */
export function MotionPage() {
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
  const [placement, setPlacement] = useState<AvatarPlacement>(DEFAULT_PLACEMENT);
  const [stance, setStance] = useState<AvatarStance>('standing');

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
        calibrationRef.current = session.getResult();
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
      controllerRef.current?.pkg?.applyBoneRotations(out.rotations);
    }
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
    if (controllerRef.current?.switchStudioCamera(id)) setActiveStudioCamera(id);
  }, []);

  const switchSavedCamera = useCallback((camera: SavedCamera) => {
    controllerRef.current?.switchStudioCameraPose(camera.pose);
    setActiveStudioCamera(camera.id);
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
    setCalibState(null);
    setDrive('idle');
    // 回待机动作
    controllerRef.current?.pkg?.playAnimation('idle-01');
    setActiveAnim('idle-01');
  };

  if (fatalError) {
    return (
      <div className="page center-page">
        <p className="form-error">{fatalError}</p>
        <button className="btn" onClick={() => navigate('/avatars')}>
          返回我的数字人
        </button>
      </div>
    );
  }

  const cameraActive = driveState === 'calibrating' || driveState === 'driving';
  const trackingLost = driveState === 'driving' && (trackingStatus === 'lost' || trackingStatus === 'blending');
  const activeCameraLabel =
    STUDIO_CAMERA_PRESETS.find((camera) => camera.id === activeStudioCamera)?.label ??
    savedCameras.find((camera) => camera.id === activeStudioCamera)?.label ??
    '自由视角';

  return (
    <div className="motion-page">
      <header className="editor-topbar">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/avatars')}>
          ← 返回
        </button>
        <span className="motion-title">虚拟直播间 · {avatarName || '加载中…'}</span>
      </header>

      <div className="motion-body">
        {/* 左侧三维视窗 + 摄像头小窗 */}
        <AvatarViewport
          onInit={onViewportInit}
          overlay={
            <>
              <div className="studio-live-hud">
                <span className="studio-live-dot" />
                PREVIEW
                <span className="studio-camera-name">{activeCameraLabel}</span>
              </div>
              <video
                ref={videoRef}
                className={`cam-preview ${cameraActive ? 'active' : ''}`}
                muted
                playsInline
              />
              {driveState === 'calibrating' && calibState && (
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
              {trackingLost && (
                <div className="viewport-banner warning">跟踪已丢失，请回到画面中央</div>
              )}
            </>
          }
        />

        {/* 右侧控制面板 */}
        <aside className="motion-panel">
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
              点击机位会平滑切镜；也可以先用鼠标调整自由视角，再保存为自定义机位。
            </p>
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
            <div className="mode-select studio-actions">
              <button className="btn btn-sm" onClick={saveCurrentCamera}>
                保存当前视角
              </button>
              {savedCameras.length > 0 && (
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    setSavedCameras([]);
                    switchCamera('front');
                  }}
                >
                  清空自定义
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
                  disabled={cameraActive || unavailableForStance}
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
            {cameraActive && <p className="muted">摄像头驱动中，预置动作已暂停。</p>}
          </section>

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
                    ? '全身模式：需距离摄像头 2–3 米，头、手、脚完整入镜。'
                    : '上半身模式：只需肩到手腕入镜，可坐近使用；髋关节和双腿不被驱动，保持当前姿态。'}
                </p>
                <p className="muted">
                  使用电脑摄像头实时驱动数字人。视频与关键点完全在浏览器本地处理，不会上传。
                  建议正面均匀光照。
                </p>
                <button
                  className="btn btn-primary"
                  disabled={stance !== 'standing'}
                  title={stance !== 'standing' ? '请先完成站起动作' : undefined}
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
        </aside>
      </div>
    </div>
  );
}
