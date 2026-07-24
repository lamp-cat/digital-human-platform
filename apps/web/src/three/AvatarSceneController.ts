import { Clock, Color, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  AvatarPackage,
  createOrbitControls,
  createStage,
  loadImportedAvatar,
  snapshotCanvas,
  type Stage,
} from '@dhp/avatar-runtime';
import type { AvatarProfile, GarmentManifest } from '@dhp/avatar-schema';
import { StudioRoomManager } from './StudioRoomManager';

export interface LoadAvatarInput {
  profile: AvatarProfile;
  knownGarments: Map<string, GarmentManifest>;
  /** 导入人物：模型 ObjectURL；内置人物为空 */
  importedModelUrl?: string;
  importCompatibleGarments?: string[] | null;
}

export interface AvatarPlacement {
  x: number;
  y: number;
  z: number;
  rotationYDeg: number;
  scale: number;
}

export interface StudioCameraPose {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export interface StudioCameraPreset {
  id: string;
  label: string;
  /** 相对人物站位的相机位置。 */
  offset: [number, number, number];
  /** 相对人物站位的注视点。 */
  targetOffset: [number, number, number];
  fov: number;
}

export const STUDIO_CAMERA_PRESETS: readonly StudioCameraPreset[] = [
  { id: 'front', label: '正面中景', offset: [0.45, 1.45, 3.25], targetOffset: [0, 1.05, 0], fov: 38 },
  { id: 'close', label: '面部近景', offset: [0.18, 1.58, 1.65], targetOffset: [0, 1.43, 0], fov: 32 },
  { id: 'three-quarter', label: '右侧 45°', offset: [2.45, 1.55, 2.65], targetOffset: [0, 1.08, 0], fov: 40 },
  { id: 'side', label: '左侧机位', offset: [-3.05, 1.4, 0.45], targetOffset: [0, 1.05, 0], fov: 42 },
  { id: 'wide', label: '直播间全景', offset: [0.8, 2.1, 5.2], targetOffset: [0, 1.0, -0.25], fov: 46 },
] as const;

interface CameraTransition {
  startedAt: number;
  durationMs: number;
  from: StudioCameraPose;
  to: StudioCameraPose;
}

/**
 * 三维视窗控制器：渲染循环、人物加载（失败保留现有人物）、封面截图。
 * React 组件通过 AvatarViewport 持有实例。
 */
export class AvatarSceneController {
  private renderer!: WebGLRenderer;
  private scene!: Scene;
  private camera!: PerspectiveCamera;
  private controls!: OrbitControls;
  private stage!: Stage;
  private roomManager!: StudioRoomManager;
  private clock = new Clock();
  private rafId = 0;
  private resizeObserver: ResizeObserver | null = null;
  private cameraTransition: CameraTransition | null = null;
  private placement: AvatarPlacement = {
    x: 0,
    y: 0,
    z: 0,
    rotationYDeg: 0,
    scale: 1,
  };

  pkg: AvatarPackage | null = null;
  loading = false;

  /** 状态变化回调（加载中/就绪），供 React 覆盖层使用。 */
  onStateChange: (() => void) | null = null;

  constructor(private container: HTMLElement) {}

  init(): void {
    const w = this.container.clientWidth || 640;
    const h = this.container.clientHeight || 480;
    this.renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.container.appendChild(this.renderer.domElement);

    this.stage = createStage();
    this.scene = this.stage.scene;
    this.roomManager = new StudioRoomManager(this.scene);
    this.camera = new PerspectiveCamera(38, w / h, 0.1, 50);
    this.camera.position.set(0.9, 1.45, 2.6);
    this.controls = createOrbitControls(this.camera, this.renderer.domElement);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.loop();
  }

  private resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.pkg?.update(dt);
    this.updateCameraTransition(performance.now());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private emit(): void {
    this.onStateChange?.();
  }

  /** 加载人物（内置或导入模型）；失败时保留现有人物并返回 false。 */
  async loadAvatar(input: LoadAvatarInput): Promise<boolean> {
    this.loading = true;
    this.emit();
    try {
      let pkg: AvatarPackage;
      if (input.importedModelUrl) {
        const imported = await loadImportedAvatar(input.importedModelUrl);
        pkg = new AvatarPackage({
          profile: input.profile,
          knownGarments: input.knownGarments,
          imported,
          importCompatibleGarments: input.importCompatibleGarments ?? [],
        });
      } else {
        pkg = new AvatarPackage({ profile: input.profile, knownGarments: input.knownGarments });
      }
      const old = this.pkg;
      this.pkg = pkg;
      this.applyPlacement();
      this.scene.add(pkg.root);
      if (old) {
        this.scene.remove(old.root);
        old.dispose();
      }
      return true;
    } catch {
      return false;
    } finally {
      this.loading = false;
      this.emit();
    }
  }

  /** 应用最新 Profile 到当前人物。 */
  applyProfile(profile: AvatarProfile): void {
    this.pkg?.setProfile(profile);
  }

  snapshot(): string | null {
    if (!this.pkg) return null;
    return snapshotCanvas(this.renderer, this.scene, this.camera);
  }

  /** 加载随项目发布的 Kenney CC0 直播间。 */
  async loadBuiltInStudioRoom(): Promise<boolean> {
    try {
      await this.roomManager.loadBuiltIn();
      this.setStudioStageVisible(true);
      return true;
    } catch {
      return false;
    }
  }

  /** 从本地 3D 文件导入直播间；模型字节不会上传。 */
  async loadStudioRoomFile(file: File): Promise<{ format: string }> {
    const result = await this.roomManager.loadFile(file);
    this.setStudioStageVisible(true);
    return result;
  }

  clearStudioRoom(): void {
    this.roomManager.clear();
    this.setStudioStageVisible(false);
  }

  setAvatarPlacement(next: Partial<AvatarPlacement>): AvatarPlacement {
    this.placement = {
      x: Math.min(3, Math.max(-3, next.x ?? this.placement.x)),
      y: Math.min(1, Math.max(-0.25, next.y ?? this.placement.y)),
      z: Math.min(3, Math.max(-3, next.z ?? this.placement.z)),
      rotationYDeg: Math.min(180, Math.max(-180, next.rotationYDeg ?? this.placement.rotationYDeg)),
      scale: Math.min(1.5, Math.max(0.6, next.scale ?? this.placement.scale)),
    };
    this.applyPlacement();
    return { ...this.placement };
  }

  getAvatarPlacement(): AvatarPlacement {
    return { ...this.placement };
  }

  /** 平滑切换到内置机位；机位坐标随人物站位平移。 */
  switchStudioCamera(id: string, animate = true): boolean {
    const preset = STUDIO_CAMERA_PRESETS.find((item) => item.id === id);
    if (!preset) return false;
    const pose: StudioCameraPose = {
      position: [
        this.placement.x + preset.offset[0],
        this.placement.y + preset.offset[1],
        this.placement.z + preset.offset[2],
      ],
      target: [
        this.placement.x + preset.targetOffset[0],
        this.placement.y + preset.targetOffset[1],
        this.placement.z + preset.targetOffset[2],
      ],
      fov: preset.fov,
    };
    this.switchStudioCameraPose(pose, animate);
    return true;
  }

  /** 切换到用户保存的自定义机位。 */
  switchStudioCameraPose(pose: StudioCameraPose, animate = true): void {
    const to: StudioCameraPose = {
      position: [...pose.position],
      target: [...pose.target],
      fov: Math.min(70, Math.max(20, pose.fov)),
    };
    if (!animate) {
      this.applyCameraPose(to);
      return;
    }
    this.cameraTransition = {
      startedAt: performance.now(),
      durationMs: 650,
      from: this.getStudioCameraPose(),
      to,
    };
    this.controls.enabled = false;
  }

  /** 记录用户通过鼠标环绕得到的当前视角。 */
  getStudioCameraPose(): StudioCameraPose {
    return {
      position: this.camera.position.toArray() as [number, number, number],
      target: this.controls.target.toArray() as [number, number, number],
      fov: this.camera.fov,
    };
  }

  resetView(): void {
    this.switchStudioCamera('front');
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.resizeObserver?.disconnect();
    this.controls.dispose();
    if (this.pkg) {
      this.scene.remove(this.pkg.root);
      this.pkg.dispose();
      this.pkg = null;
    }
    this.roomManager.dispose();
    this.stage.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private applyPlacement(): void {
    if (!this.pkg) return;
    this.pkg.root.position.set(this.placement.x, this.placement.y, this.placement.z);
    this.pkg.root.rotation.y = (this.placement.rotationYDeg * Math.PI) / 180;
    this.pkg.root.scale.setScalar(this.placement.scale);
    this.pkg.root.updateMatrixWorld(true);
  }

  private setStudioStageVisible(hasRoom: boolean): void {
    const ground = this.scene.getObjectByName('stage_ground');
    const grid = this.scene.getObjectByName('stage_grid');
    if (ground) ground.visible = !hasRoom;
    if (grid) grid.visible = !hasRoom;
    this.scene.background = new Color(hasRoom ? 0x0b1020 : 0x16181d);
    this.controls.maxDistance = hasRoom ? 9 : 6;
  }

  private updateCameraTransition(now: number): void {
    const transition = this.cameraTransition;
    if (!transition) return;
    const linear = Math.min(1, (now - transition.startedAt) / transition.durationMs);
    const t = linear * linear * (3 - 2 * linear);
    const fromPosition = new Vector3(...transition.from.position);
    const toPosition = new Vector3(...transition.to.position);
    const fromTarget = new Vector3(...transition.from.target);
    const toTarget = new Vector3(...transition.to.target);
    this.camera.position.lerpVectors(fromPosition, toPosition, t);
    this.controls.target.lerpVectors(fromTarget, toTarget, t);
    this.camera.fov = transition.from.fov + (transition.to.fov - transition.from.fov) * t;
    this.camera.updateProjectionMatrix();
    if (linear >= 1) {
      this.cameraTransition = null;
      this.controls.enabled = true;
    }
  }

  private applyCameraPose(pose: StudioCameraPose): void {
    this.cameraTransition = null;
    this.controls.enabled = true;
    this.camera.position.set(...pose.position);
    this.controls.target.set(...pose.target);
    this.camera.fov = pose.fov;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }
}
