import {
  Camera,
  CircleGeometry,
  Color,
  DirectionalLight,
  GridHelper,
  HemisphereLight,
  Material,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** 默认展示场景：灯光 / 地面 / 网格。 */
export interface Stage {
  scene: Scene;
  dispose(): void;
}

export function createStage(background = 0x16181d): Stage {
  const scene = new Scene();
  scene.background = new Color(background);

  const hemi = new HemisphereLight(0xffffff, 0x2a2f36, 1.0);
  scene.add(hemi);

  const key = new DirectionalLight(0xffffff, 1.8);
  key.position.set(2, 3.2, 2.5);
  scene.add(key);

  const fill = new DirectionalLight(0xcfe0ff, 0.5);
  fill.position.set(-2.5, 1.6, -1.5);
  scene.add(fill);

  const groundMat = new MeshStandardMaterial({ color: 0x22262e, roughness: 0.95, metalness: 0 });
  const ground = new Mesh(new CircleGeometry(2.2, 48), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.name = 'stage_ground';
  scene.add(ground);

  const grid = new GridHelper(4.4, 22, 0x3a4150, 0x2a2f3a);
  grid.position.y = 0.001;
  scene.add(grid);

  return {
    scene,
    dispose() {
      ground.geometry.dispose();
      groundMat.dispose();
      grid.geometry.dispose();
      (grid.material as Material).dispose();
    },
  };
}

/** OrbitControls 封装：目标对准人物躯干中心。 */
export function createOrbitControls(camera: PerspectiveCamera, dom: HTMLElement): OrbitControls {
  const controls = new OrbitControls(camera, dom);
  controls.target.set(0, 0.95, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.6;
  controls.maxDistance = 6;
  controls.maxPolarAngle = Math.PI * 0.52;
  controls.update();
  return controls;
}

/** 渲染一帧并导出 dataURL（封面截图）。 */
export function snapshotCanvas(renderer: WebGLRenderer, scene: Scene, camera: Camera): string {
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/png');
}
