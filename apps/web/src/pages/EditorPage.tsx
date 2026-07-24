import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  BONE_SCALE_PARAM_DEFS,
  EYE_COLORS,
  MORPH_PARAM_DEFS,
  SKIN_TONES,
  checkWearable,
  garmentManifestSchema,
  type AvatarProfile,
  type BoneScaleParamKey,
  type GarmentManifest,
  type MorphParamKey,
  type Slot,
  type Traits,
} from '@dhp/avatar-schema';
import { isProceduralGarment } from '@dhp/avatar-runtime';
import { api, ApiError, fetchAuthedObjectUrl } from '../api/client';
import type { AssetEntry, AvatarDetail, EditableProfileDecl } from '../api/types';
import { AvatarViewport } from '../components/AvatarViewport';
import { Modal, SliderRow, SwatchGroup } from '../components/controls';
import { useAvatarDocumentStore } from '../stores/avatarDocumentStore';
import { useUiStore, type EditorCategory } from '../stores/uiStore';
import type { AvatarSceneController } from '../three/AvatarSceneController';

const CATEGORY_LABELS: { key: EditorCategory; label: string }[] = [
  { key: 'face', label: '脸部' },
  { key: 'body', label: '体型' },
  { key: 'skin', label: '肤色' },
  { key: 'outfit', label: '穿搭' },
];

const SLOT_ORDER: Slot[] = ['hair', 'top', 'inner', 'bottom', 'footwear', 'headwear', 'eyewear', 'neck', 'hand'];
const SLOT_LABELS: Record<string, string> = {
  hair: '发型',
  inner: '内搭',
  top: '上装',
  bottom: '下装',
  footwear: '鞋子',
  headwear: '头部配件',
  eyewear: '眼镜',
  neck: '颈部',
  hand: '手部',
};

const SAVE_STATE_TEXT = { idle: '', dirty: '未保存', saving: '保存中…', saved: '已保存 ✓', error: '保存失败' } as const;

function assetToManifest(asset: AssetEntry): GarmentManifest | null {
  const parsed = garmentManifestSchema.safeParse({
    ...asset,
    slots: asset.slots,
    shapeConstraints: asset.shapeConstraints ?? {},
    bodyMask: asset.bodyMask ?? [],
    replacesSlots: asset.replacesSlots ?? [],
    restrictsTraits: asset.restrictsTraits ?? {},
  });
  return parsed.success ? parsed.data : null;
}

function traitContains(traits: Traits, id: string): boolean {
  return (
    traits.hair === id ||
    traits.top === id ||
    traits.bottom === id ||
    traits.shoes === id ||
    (traits.accessories ?? []).includes(id)
  );
}

/** 衣物卡片配色（按 id 哈希，便于区分）。 */
function garmentColor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 45% 42%)`;
}

export function EditorPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const doc = useAvatarDocumentStore();
  const activeCategory = useUiStore((s) => s.activeCategory);
  const setCategory = useUiStore((s) => s.setCategory);
  const toast = useUiStore((s) => s.toast);

  const controllerRef = useRef<AvatarSceneController | null>(null);
  const lastAppliedRef = useRef<AvatarProfile | null>(null);
  const [fatalError, setFatalError] = useState('');
  const [viewError, setViewError] = useState('');
  const [booted, setBooted] = useState(false);
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  const [avatarMeta, setAvatarMeta] = useState<AvatarDetail | null>(null);
  const [importMeta, setImportMeta] = useState<{
    editableProfile: EditableProfileDecl;
    compatibleGarments: string[];
    modelUrl: string | null;
  } | null>(null);

  const manifests = useMemo(() => {
    const map = new Map<string, GarmentManifest>();
    for (const asset of assets) {
      const m = assetToManifest(asset);
      if (m) map.set(m.id, m);
    }
    return map;
  }, [assets]);

  const isImported = avatarMeta?.assetSource.type === 'imported';
  const importedCompatibility =
    avatarMeta?.assetSource.type === 'imported' ? avatarMeta.assetSource.compatibility : null;

  // ---------- 启动加载 ----------
  const boot = useCallback(
    async (controller: AvatarSceneController) => {
      try {
        const [{ avatar }, assetRes] = await Promise.all([
          api.getAvatar(id),
          api.listAssets({ status: 'published' }).catch(() => ({ assets: [] as AssetEntry[] })),
        ]);
        setAvatarMeta(avatar);
        setAssets(assetRes.assets);

        let importedModelUrl: string | undefined;
        let importCompatibleGarments: string[] | null = null;
        if (avatar.assetSource.type === 'imported') {
          const { importRecord } = await api.getImport(avatar.assetSource.importId);
          const editableProfile = importRecord.editableProfile ??
            importRecord.manifest?.editableProfile ?? { morphs: [], materials: [] };
          const compatibleGarments = importRecord.compatibleGarments ??
            importRecord.manifest?.compatibleGarments ?? [];
          importCompatibleGarments = compatibleGarments;
          const modelUrl = importRecord.modelUrl ?? `/api/v1/imports/${importRecord.id}/model`;
          setImportMeta({ editableProfile, compatibleGarments, modelUrl });
          importedModelUrl = await fetchAuthedObjectUrl(modelUrl);
        }

        const knownGarments = new Map<string, GarmentManifest>();
        for (const asset of assetRes.assets) {
          const m = assetToManifest(asset);
          if (m) knownGarments.set(m.id, m);
        }

        useAvatarDocumentStore.getState().load(avatar);
        lastAppliedRef.current = avatar.profile;
        const ok = await controller.loadAvatar({
          profile: avatar.profile,
          knownGarments,
          importedModelUrl,
          importCompatibleGarments,
        });
        if (!ok) setViewError('人物加载失败，请重试或检查模型文件');
        setBooted(true);
      } catch (err) {
        setFatalError(err instanceof ApiError ? err.message : '加载人物失败');
      }
    },
    [id],
  );

  const onViewportInit = useCallback(
    (controller: AvatarSceneController) => {
      controllerRef.current = controller;
      void boot(controller);
    },
    [boot],
  );

  // 离开页面时重置文档
  useEffect(() => {
    return () => useAvatarDocumentStore.getState().reset();
  }, [id]);

  // Profile 变化 → 实时预览
  const profile = doc.profile;
  useEffect(() => {
    if (!booted || lastAppliedRef.current === profile) return;
    lastAppliedRef.current = profile;
    controllerRef.current?.applyProfile(profile);
  }, [profile, booted]);

  // 撤销/重做快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      e.preventDefault();
      if (e.shiftKey) doc.redo();
      else doc.undo();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 保存 ----------
  const save = async () => {
    const { avatarId, profile: p, version, name } = useAvatarDocumentStore.getState();
    if (!avatarId) return;
    doc.markSaving();
    try {
      const { avatar } = await api.patchAvatar(avatarId, { expectedVersion: version, profile: p, name });
      doc.markSaved(avatar.version);
      toast('已保存', 'success');
      // 保存成功后上传封面（失败不影响保存本身）
      const shot = controllerRef.current?.snapshot();
      if (shot) {
        api.uploadCover(avatarId, shot).catch(() => toast('封面上传失败', 'error'));
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const details = (err.details ?? {}) as { latestVersion?: number; latestProfile?: AvatarProfile };
        doc.setConflict({ latestVersion: details.latestVersion ?? version, latestProfile: details.latestProfile ?? null });
      } else {
        doc.markSaveError();
        toast(err instanceof ApiError ? err.message : '保存失败', 'error');
      }
    }
  };

  const resolveConflictByReload = async () => {
    doc.clearConflict();
    setBooted(false);
    if (controllerRef.current) await boot(controllerRef.current);
  };

  const resolveConflictByCopy = async () => {
    const { profile: p, name } = useAvatarDocumentStore.getState();
    try {
      const { avatar: copy } = await api.createAvatar(`${name}（副本）`);
      await api.patchAvatar(copy.id, { expectedVersion: copy.version, profile: p, name: copy.name });
      doc.clearConflict();
      toast('已复制为新人物', 'success');
      navigate(`/editor/${copy.id}`);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '复制失败', 'error');
    }
  };

  // ---------- 穿搭 ----------
  const compatibilityOf = (manifest: GarmentManifest) =>
    checkWearable(manifest, {
      baseAvatarId: doc.profile.baseAvatarId,
      boneScales: doc.profile.boneScales,
      currentTraits: doc.profile.traits,
      knownGarments: manifests,
      importCompatibleGarments: isImported ? importMeta?.compatibleGarments ?? [] : null,
      importedCompatibility,
    });

  const toggleGarment = (asset: AssetEntry) => {
    const pkg = controllerRef.current?.pkg;
    const manifest = manifests.get(asset.id);
    if (!pkg || !manifest) return;
    if (traitContains(doc.profile.traits, asset.id)) {
      const res = pkg.unwearTrait(asset.id);
      if (res.success) doc.applyEdit((p) => ({ ...p, traits: res.traits }));
      else toast(res.message, 'error');
    } else {
      const res = pkg.wearTrait(manifest);
      if (res.success) doc.applyEdit((p) => ({ ...p, traits: res.traits }));
      else toast(res.message, 'error');
    }
  };

  // ---------- 渲染 ----------
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

  const editableMorphs = isImported
    ? MORPH_PARAM_DEFS.filter((d) => importMeta?.editableProfile.morphs.includes(d.key))
    : MORPH_PARAM_DEFS;
  const editableMaterials = isImported
    ? (['skinToneId', 'skinRoughness', 'eyeColorId'] as const).filter((m) =>
        importMeta?.editableProfile.materials.includes(m),
      )
    : (['skinToneId', 'skinRoughness', 'eyeColorId'] as const);

  const garmentAssets = assets.filter((a) => ['garment', 'hair', 'accessory', 'shoes'].includes(a.type));

  return (
    <div className="editor">
      {/* 顶栏 */}
      <header className="editor-topbar">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/avatars')}>
          ← 返回
        </button>
        <input
          className="avatar-name-input"
          value={doc.name}
          onChange={(e) => doc.setName(e.target.value)}
          placeholder="人物名称"
        />
        {doc.saveState !== 'idle' && (
          <span className={`save-pill save-state-${doc.saveState}`}>
            {SAVE_STATE_TEXT[doc.saveState]}
          </span>
        )}
        {isImported && (
          <span className={`badge ${importedCompatibility === 'FULL' ? 'badge-compat-full' : 'badge-compat-pose'}`}>
            导入人物 · {importedCompatibility === 'FULL' ? '可换装' : '仅动作'}
          </span>
        )}
        <div className="topbar-spacer" />
        <div className="btn-group">
          <button className="btn btn-sm" disabled={doc.undoStack.length === 0} onClick={doc.undo} title="撤销（⌘Z）">
            ↩ 撤销
          </button>
          <button className="btn btn-sm" disabled={doc.redoStack.length === 0} onClick={doc.redo} title="重做（⇧⌘Z）">
            ↪ 重做
          </button>
        </div>
        <button
          className="btn btn-sm btn-primary"
          disabled={doc.saveState === 'saving' || doc.saveState === 'saved' || doc.saveState === 'idle'}
          onClick={() => void save()}
        >
          保存
        </button>
      </header>

      <div className="editor-body">
        {/* 左侧分类 */}
        <nav className="editor-categories">
          {CATEGORY_LABELS.map((c) => (
            <button
              key={c.key}
              className={activeCategory === c.key ? 'active' : ''}
              onClick={() => setCategory(c.key)}
            >
              {c.label}
            </button>
          ))}
        </nav>

        {/* 中间三维视窗 */}
        <AvatarViewport
          onInit={onViewportInit}
          overlay={
            <>
              {viewError && (
                <div className="viewport-banner error">
                  {viewError}
                  <button className="btn btn-xs" onClick={() => setViewError('')}>
                    知道了
                  </button>
                </div>
              )}
              <div className="viewport-tools">
                <button className="btn btn-xs" onClick={() => controllerRef.current?.resetView()}>
                  重置视角
                </button>
              </div>
            </>
          }
        />

        {/* 右侧参数面板 */}
        <aside className="editor-params">
          {!booted && (
            <div>
              <h3 className="param-group-title">参数</h3>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="skeleton skeleton-line" style={{ margin: '0 0 14px' }} />
              ))}
            </div>
          )}
          {booted && activeCategory === 'face' && (
            <div>
              <h3 className="param-group-title">脸型参数</h3>
              {editableMorphs.length === 0 ? (
                <p className="muted">该导入模型未声明可编辑的脸型参数。</p>
              ) : (
                editableMorphs.map((def) => {
                  const key = def.key as MorphParamKey;
                  return (
                    <SliderRow
                      key={key}
                      label={def.label}
                      value={doc.profile.morphs[key] ?? 0}
                      min={-1}
                      max={1}
                      defaultValue={0}
                      onChange={(v) =>
                        doc.previewEdit((p) => ({ ...p, morphs: { ...p.morphs, [key]: v } }))
                      }
                      onReset={() =>
                        doc.applyEdit((p) => ({ ...p, morphs: { ...p.morphs, [key]: 0 } }))
                      }
                    />
                  );
                })
              )}
            </div>
          )}

          {booted && activeCategory === 'body' && (
            <div>
              <h3 className="param-group-title">体型参数</h3>
              {isImported ? (
                <p className="muted">导入人物不支持平台体型参数调整。</p>
              ) : (
                BONE_SCALE_PARAM_DEFS.map((def) => {
                  const key = def.key as BoneScaleParamKey;
                  return (
                    <SliderRow
                      key={key}
                      label={`${def.label}（${def.min}–${def.max}）`}
                      value={doc.profile.boneScales[key] ?? 1}
                      min={def.min}
                      max={def.max}
                      defaultValue={1}
                      onChange={(v) =>
                        doc.previewEdit((p) => ({ ...p, boneScales: { ...p.boneScales, [key]: v } }))
                      }
                      onReset={() =>
                        doc.applyEdit((p) => ({ ...p, boneScales: { ...p.boneScales, [key]: 1 } }))
                      }
                    />
                  );
                })
              )}
            </div>
          )}

          {booted && activeCategory === 'skin' && (
            <div>
              <h3 className="param-group-title">肤色与材质</h3>
              {editableMaterials.length === 0 ? (
                <p className="muted">该导入模型未声明可编辑的材质参数。</p>
              ) : (
                <>
                  {editableMaterials.includes('skinToneId') && (
                    <SwatchGroup
                      label="肤色"
                      items={SKIN_TONES}
                      activeId={doc.profile.materials.skinToneId}
                      onSelect={(id) =>
                        doc.applyEdit((p) => ({
                          ...p,
                          materials: { ...p.materials, skinToneId: id },
                        }))
                      }
                    />
                  )}
                  {editableMaterials.includes('skinRoughness') && (
                    <SliderRow
                      label="皮肤粗糙度"
                      value={doc.profile.materials.skinRoughness}
                      min={0}
                      max={1}
                      defaultValue={0.52}
                      onChange={(v) =>
                        doc.previewEdit((p) => ({
                          ...p,
                          materials: { ...p.materials, skinRoughness: v },
                        }))
                      }
                      onReset={() =>
                        doc.applyEdit((p) => ({
                          ...p,
                          materials: { ...p.materials, skinRoughness: 0.52 },
                        }))
                      }
                    />
                  )}
                  {editableMaterials.includes('eyeColorId') && (
                    <SwatchGroup
                      label="眼睛颜色"
                      items={EYE_COLORS}
                      activeId={doc.profile.materials.eyeColorId}
                      onSelect={(id) =>
                        doc.applyEdit((p) => ({
                          ...p,
                          materials: { ...p.materials, eyeColorId: id },
                        }))
                      }
                    />
                  )}
                </>
              )}
            </div>
          )}

          {booted && activeCategory === 'outfit' && (
            <div>
              <h3 className="param-group-title">穿搭</h3>
              {importedCompatibility === 'POSE_ONLY' ? (
                <p className="compat-notice">该导入人物可动作控制，不支持 V1 通用换装。</p>
              ) : garmentAssets.length === 0 ? (
                <p className="muted">暂无可用资产（请确认后端已发布内置资产）。</p>
              ) : (
                SLOT_ORDER.map((slot) => {
                  const group = garmentAssets.filter((a) => a.slots.includes(slot));
                  if (group.length === 0) return null;
                  return (
                    <div key={slot} className="garment-group">
                      <div className="param-group-label">{SLOT_LABELS[slot] ?? slot}</div>
                      <div className="garment-grid">
                        {group.map((asset) => {
                          const manifest = manifests.get(asset.id);
                          const worn = traitContains(doc.profile.traits, asset.id);
                          const supported =
                            asset.assets.model === `procedural:${asset.id}` &&
                            isProceduralGarment(asset.id);
                          const compat = manifest && supported ? compatibilityOf(manifest) : null;
                          const disabledReason = !manifest
                            ? '资产清单不完整'
                            : !supported
                              ? '该资产格式暂不支持（仅支持程序化内置资产）'
                              : compat && !compat.success
                                ? compat.message
                                : '';
                          return (
                            <button
                              key={asset.id}
                              className={`garment-card ${worn ? 'worn' : ''} ${disabledReason ? 'disabled' : ''}`}
                              title={disabledReason || asset.displayName}
                              onClick={() => !disabledReason && toggleGarment(asset)}
                            >
                              <span
                                className="garment-thumb"
                                style={{ backgroundColor: garmentColor(asset.id) }}
                              >
                                {asset.displayName.slice(0, 1)}
                              </span>
                              <span className="garment-name">{asset.displayName}</span>
                              {disabledReason && <span className="garment-compat-dot" />}
                              {worn && <span className="garment-worn-mark">已穿</span>}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </aside>
      </div>

      {/* 版本冲突弹窗 */}
      {doc.conflict && (
        <Modal title="保存冲突">
          <p>
            该人物已在别处被修改（最新版本 v{doc.conflict.latestVersion}），当前编辑基于旧版本，
            无法直接保存。
          </p>
          <div className="modal-actions">
            <button className="btn" onClick={() => void resolveConflictByReload()}>
              刷新最新（放弃当前修改）
            </button>
            <button className="btn btn-primary" onClick={() => void resolveConflictByCopy()}>
              复制为新人物
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
