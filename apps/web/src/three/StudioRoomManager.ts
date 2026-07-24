import {
  Box3,
  BoxGeometry,
  Color,
  Group,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Scene,
  Texture,
  Vector3,
} from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

const KENNEY_BASE = '/rooms/kenney';

interface FurniturePlacement {
  file: string;
  position: [number, number, number];
  rotationY?: number;
  scale?: number;
}

const FURNITURE: readonly FurniturePlacement[] = [
  { file: 'loungeDesignSofa.glb', position: [-1.45, 0, -2.35], rotationY: 0, scale: 1.15 },
  { file: 'loungeDesignChair.glb', position: [1.35, 0, -2.25], rotationY: -0.18, scale: 1.1 },
  { file: 'tableCoffee.glb', position: [-0.45, 0, -1.45], scale: 1.05 },
  { file: 'rugRectangle.glb', position: [-0.4, 0.018, -1.55], scale: 1.55 },
  { file: 'bookcaseOpen.glb', position: [2.75, 0, -2.72], rotationY: 0, scale: 1.15 },
  { file: 'pottedPlant.glb', position: [-3.0, 0, -2.55], scale: 1.05 },
  { file: 'lampRoundFloor.glb', position: [0.25, 0, -2.65], scale: 1.05 },
  { file: 'desk.glb', position: [-2.75, 0, 1.5], rotationY: Math.PI, scale: 1.05 },
  { file: 'computerScreen.glb', position: [-2.75, 0.78, 1.38], rotationY: Math.PI, scale: 0.95 },
  { file: 'chairDesk.glb', position: [-2.75, 0, 0.85], rotationY: 0, scale: 1.0 },
  { file: 'televisionModern.glb', position: [2.55, 1.05, -2.78], rotationY: 0, scale: 1.35 },
] as const;

function disposeMaterial(material: Material): void {
  const values = Object.values(material) as unknown[];
  for (const value of values) {
    if (value instanceof Texture) value.dispose();
  }
  material.dispose();
}

/** 释放房间独占的几何、材质和纹理。 */
function disposeObject(root: Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as Mesh;
    mesh.geometry?.dispose();
    if (Array.isArray(mesh.material)) mesh.material.forEach(disposeMaterial);
    else if (mesh.material) disposeMaterial(mesh.material);
  });
}

function setRoomMeshFlags(root: Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh) return;
    mesh.receiveShadow = true;
    mesh.castShadow = true;
  });
}

function shellMesh(
  name: string,
  size: [number, number, number],
  position: [number, number, number],
  color: number,
): Mesh {
  const mesh = new Mesh(
    new BoxGeometry(...size),
    new MeshStandardMaterial({ color, roughness: 0.82, metalness: 0.02 }),
  );
  mesh.name = name;
  mesh.position.set(...position);
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * 直播房间管理器：
 * - 默认房间由 CC0 Kenney Furniture Kit 的 GLB 家具与平台房间壳组合；
 * - 用户房间支持 GLB/嵌入式 glTF、FBX、OBJ，全程浏览器本地解析；
 * - 替换房间时显式释放 GPU 资源，避免多次导入后显存泄漏。
 */
export class StudioRoomManager {
  private roomRoot: Group | null = null;
  private gltfLoader = new GLTFLoader();

  constructor(private scene: Scene) {}

  async loadBuiltIn(): Promise<void> {
    const room = new Group();
    room.name = 'studio-room:kenney';

    room.add(
      shellMesh('studio-floor', [7, 0.08, 6], [0, -0.04, 0], 0x273043),
      shellMesh('studio-back-wall', [7, 3.2, 0.12], [0, 1.6, -3], 0x17223a),
      shellMesh('studio-left-wall', [0.12, 3.2, 6], [-3.5, 1.6, 0], 0x202b42),
      shellMesh('studio-right-wall', [0.12, 3.2, 6], [3.5, 1.6, 0], 0x202b42),
      shellMesh('studio-led-panel', [3.2, 1.35, 0.035], [0.35, 1.75, -2.91], 0x315f75),
      shellMesh('studio-platform', [2.7, 0.04, 1.8], [0.2, 0.02, -0.1], 0x37445b),
    );

    const loaded = await Promise.allSettled(
      FURNITURE.map(async (item) => {
        const gltf = await this.gltfLoader.loadAsync(`${KENNEY_BASE}/${item.file}`);
        const object = gltf.scene;
        object.name = `kenney:${item.file}`;
        object.position.set(...item.position);
        object.rotation.y = item.rotationY ?? 0;
        object.scale.setScalar(item.scale ?? 1);
        setRoomMeshFlags(object);
        return object;
      }),
    );
    for (const result of loaded) {
      if (result.status === 'fulfilled') room.add(result.value);
    }
    this.replace(room, false);
  }

  async loadFile(file: File): Promise<{ format: string }> {
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    let object: Object3D;
    if (extension === 'glb' || extension === 'gltf') {
      const buffer = await file.arrayBuffer();
      try {
        const gltf = await this.gltfLoader.parseAsync(buffer, '');
        object = gltf.scene;
      } catch (error) {
        if (extension === 'gltf') {
          throw new Error('该 glTF 引用了外部贴图或 .bin；请从建模软件导出为单文件 GLB');
        }
        throw error;
      }
    } else if (extension === 'fbx') {
      object = new FBXLoader().parse(await file.arrayBuffer(), '');
    } else if (extension === 'obj') {
      object = new OBJLoader().parse(await file.text());
    } else {
      throw new Error('不支持该格式；请选择 GLB、GLTF、FBX 或 OBJ');
    }
    object.name = `studio-room:imported:${file.name}`;
    this.replace(object, true);
    return { format: extension.toUpperCase() };
  }

  clear(): void {
    if (!this.roomRoot) return;
    this.scene.remove(this.roomRoot);
    disposeObject(this.roomRoot);
    this.roomRoot = null;
  }

  dispose(): void {
    this.clear();
  }

  private replace(source: Object3D, autoFit: boolean): void {
    const root = source instanceof Group ? source : new Group().add(source);
    setRoomMeshFlags(root);

    if (autoFit) {
      root.updateMatrixWorld(true);
      const initial = new Box3().setFromObject(root);
      const size = initial.getSize(new Vector3());
      const horizontalSpan = Math.max(size.x, size.z);
      if (!Number.isFinite(horizontalSpan) || horizontalSpan < 1e-5) {
        disposeObject(root);
        throw new Error('房间模型没有可显示的三维网格');
      }
      // 自动归一到约 6m 的直播间跨度，兼容厘米/米/自定义单位导出。
      const scale = Math.min(20, Math.max(0.01, 6 / horizontalSpan));
      root.scale.multiplyScalar(scale);
      root.updateMatrixWorld(true);
      const fitted = new Box3().setFromObject(root);
      const center = fitted.getCenter(new Vector3());
      root.position.x -= center.x;
      root.position.z -= center.z;
      root.position.y -= fitted.min.y;
    }

    // 新模型完成解析和边界校验后再替换，失败时保留当前直播间。
    this.clear();
    this.roomRoot = root;
    this.scene.add(root);
  }
}
