import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Box3,
  Color,
  DirectionalLight,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import {
  AvatarPackage,
  loadImportedAvatar,
} from '@dhp/avatar-runtime';
import { garmentManifestSchema, type GarmentManifest } from '@dhp/avatar-schema';
import { api, fetchAuthedObjectUrl } from '../api/client';
import type { AssetEntry } from '../api/types';

declare global {
  interface Window {
    /** 封面拍摄就绪标记（scripts/regenerate-covers.mjs 等待该标记截图）。 */
    __coverReady?: boolean;
    __coverError?: string;
  }
}

const SHOT_WIDTH = 600;
const SHOT_HEIGHT = 800;
const FOV = 30;

function assetToManifest(asset: AssetEntry): GarmentManifest | null {
  const parsed = garmentManifestSchema.safeParse({
    ...asset,
    shapeConstraints: asset.shapeConstraints ?? {},
    bodyMask: asset.bodyMask ?? [],
    replacesSlots: asset.replacesSlots ?? [],
    restrictsTraits: asset.restrictsTraits ?? {},
  });
  return parsed.success ? parsed.data : null;
}

/**
 * 隐藏路由 /cover-shot/:id：以正前方机位渲染人物封面帧。
 * 纯深色背景、无地面网格，canvas 固定 600×800（3:4），渲染完成后置 window.__coverReady。
 */
export function CoverShotPage() {
  const { id = '' } = useParams();
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('正在加载人物…');
  const [error, setError] = useState('');

  useEffect(() => {
    window.__coverReady = false;
    window.__coverError = undefined;
    const host = hostRef.current;
    if (!host || !id) return;

    // --- 渲染器与场景：中性光、纯深色背景、无网格 ---
    const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(SHOT_WIDTH, SHOT_HEIGHT);
    host.appendChild(renderer.domElement);

    const scene = new Scene();
    scene.background = new Color(0x14161c);

    const hemi = new HemisphereLight(0xffffff, 0x33383f, 1.05);
    scene.add(hemi);
    const key = new DirectionalLight(0xffffff, 1.6);
    key.position.set(1.2, 2.6, 3.2); // 主光从前上方来，保证脸部明亮
    scene.add(key);
    const fill = new DirectionalLight(0xdfeaff, 0.55);
    fill.position.set(-2.2, 1.4, 2.0);
    scene.add(fill);
    const rim = new DirectionalLight(0xbcd2ff, 0.5);
    rim.position.set(0, 2.2, -2.6); // 轮廓光，人物从背景中分离
    scene.add(rim);

    const camera = new PerspectiveCamera(FOV, SHOT_WIDTH / SHOT_HEIGHT, 0.1, 50);
    let disposed = false;
    let pkg: AvatarPackage | null = null;
    let rafId = 0;

    const frameFrontCamera = () => {
      if (!pkg) return;
      // 依据人物包围盒把相机放到正前方（+Z 正对脸），竖向 3:4 构图
      const box = new Box3().setFromObject(pkg.root);
      if (box.isEmpty()) {
        // 退化模型（无有效网格）兜底：按 1.7m 标准身高取景
        box.min.set(-0.5, 0, -0.5);
        box.max.set(0.5, 1.7, 0.5);
      }
      const size = box.getSize(new Vector3());
      const center = box.getCenter(new Vector3());
      const height = Math.max(size.y, 0.5);
      // 视线对准胸口/头部之间（约身高 60% 处）
      const targetY = box.min.y + height * 0.58;
      // 距离：完整容纳身高 + 少量边距（身高 1.6–2.2m 均适用）
      const dist = (height / 2 / Math.tan((FOV * Math.PI) / 360)) * 1.08;
      camera.position.set(center.x, targetY, box.max.z + dist);
      camera.lookAt(center.x, targetY, center.z);
    };

    const renderFrames = (n: number) => {
      if (disposed) return;
      pkg?.update(1 / 60);
      renderer.render(scene, camera);
      if (n <= 1) {
        setStatus('封面已就绪');
        window.__coverReady = true;
        return;
      }
      rafId = requestAnimationFrame(() => renderFrames(n - 1));
    };

    void (async () => {
      try {
        const [{ avatar }, { assets }] = await Promise.all([
          api.getAvatar(id),
          api.listAssets({ status: 'published' }).catch(() => ({ assets: [] as AssetEntry[] })),
        ]);

        const knownGarments = new Map<string, GarmentManifest>();
        for (const asset of assets) {
          const m = assetToManifest(asset);
          if (m) knownGarments.set(m.id, m);
        }

        let imported;
        let importCompatibleGarments: string[] | null = null;
        if (avatar.assetSource.type === 'imported') {
          setStatus('正在加载导入模型…');
          const { importRecord } = await api.getImport(avatar.assetSource.importId);
          importCompatibleGarments =
            importRecord.compatibleGarments ?? importRecord.manifest?.compatibleGarments ?? [];
          const modelUrl = importRecord.modelUrl ?? `/api/v1/imports/${importRecord.id}/model`;
          const objectUrl = await fetchAuthedObjectUrl(modelUrl);
          imported = await loadImportedAvatar(objectUrl);
        }

        pkg = new AvatarPackage({
          profile: avatar.profile,
          knownGarments,
          imported,
          importCompatibleGarments,
        });
        scene.add(pkg.root);
        if (disposed) return;
        setStatus('正在渲染封面…');
        frameFrontCamera();
        renderFrames(8); // 多渲染几帧确保姿态/材质稳定
      } catch (err) {
        const msg = err instanceof Error ? err.message : '封面渲染失败';
        setError(msg);
        setStatus('');
        window.__coverError = msg;
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      if (pkg) {
        scene.remove(pkg.root);
        pkg.dispose();
        pkg = null;
      }
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [id]);

  return (
    <div className="cover-shot-page">
      <div className="cover-shot-stage" ref={hostRef} />
      <p className={`cover-shot-status ${error ? 'error' : ''}`}>{error || status}</p>
    </div>
  );
}
