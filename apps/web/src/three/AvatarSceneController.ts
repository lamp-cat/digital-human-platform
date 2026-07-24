import { Clock, PerspectiveCamera, Scene, WebGLRenderer } from 'three';
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

export interface LoadAvatarInput {
  profile: AvatarProfile;
  knownGarments: Map<string, GarmentManifest>;
  /** 导入人物：模型 ObjectURL；内置人物为空 */
  importedModelUrl?: string;
  importCompatibleGarments?: string[] | null;
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
  private clock = new Clock();
  private rafId = 0;
  private resizeObserver: ResizeObserver | null = null;

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
    this.container.appendChild(this.renderer.domElement);

    this.stage = createStage();
    this.scene = this.stage.scene;
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

  resetView(): void {
    this.camera.position.set(0.9, 1.45, 2.6);
    this.controls.target.set(0, 0.95, 0);
    this.controls.update();
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
    this.stage.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
