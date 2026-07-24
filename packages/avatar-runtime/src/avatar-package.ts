import {
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  Box3,
  BufferGeometry,
  Group,
  LoopOnce,
  LoopRepeat,
  Material,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import {
  BODY_SECTIONS,
  STANDARD_RIG_BONES,
  checkWearable,
  computeBodyMask,
  removeTraitFrom,
  type AvatarProfile,
  type BodySection,
  type ExtendedRigBone,
  type FaceExpressionWeights,
  type GarmentManifest,
  type StandardRigBone,
  type Traits,
  type WearResult,
} from '@dhp/avatar-schema';
import { createBaseAvatar, type BaseAvatar } from './base-avatar.js';
import { applyProfile as applyProfileToBase } from './profile-apply.js';
import { createGarment, disposeGarment, type GarmentBuildContext } from './garments.js';
import {
  PRESET_ANIMATION_PLAYBACK,
  createPresetClips,
  retargetClipToRig,
  type PresetAnimationId,
} from './animations.js';
import { applyBoneRotations, createRigDriver, type QuatLike, type RigDriver } from './rig-driver.js';
import type { ImportedAvatar } from './imported.js';
import type { BoneMap } from './skeleton.js';
import {
  createBaseExpressionDriver,
  createImportedExpressionDriver,
  type ExpressionDriver,
} from './expression-driver.js';

export interface AvatarPackageOptions {
  profile: AvatarProfile;
  /** 衣物目录（换装事务校验与 BodyMask 计算依赖）。 */
  knownGarments?: Map<string, GarmentManifest>;
  /** 内置底模实例；缺省自动创建。传入 imported 时忽略。 */
  avatar?: BaseAvatar;
  /** 导入人物（loadImportedAvatar 的结果）。 */
  imported?: ImportedAvatar;
  /** 导入人物 manifest 声明的兼容衣物清单；内置底模为 null。 */
  importCompatibleGarments?: string[] | null;
}

interface RestoreEntry {
  obj: Object3D;
  fromQuat: Quaternion;
  bindQuat: Quaternion;
  fromPos: Vector3;
  bindPos: Vector3;
}

function traitIds(traits: Traits): string[] {
  const ids = [traits.hair, traits.top, traits.bottom, traits.shoes, ...(traits.accessories ?? [])];
  return ids.filter((id): id is string => !!id);
}

function wearFailure(message: string): WearResult {
  return {
    success: false,
    reasonCode: 'TRAIT_NOT_FOUND',
    conflictingTraits: [],
    suggestedActions: ['检查该资产模型是否可用'],
    message,
  };
}

/**
 * AvatarPackage：组合底模（或导入人物）+ Profile + Traits，
 * 提供换装事务、BodyMask、预置动作与骨骼驱动接口。
 *
 * 注意：root 应保持在场景原点且朝向 +Z，骨骼驱动的世界系约定以此为准。
 */
export class AvatarPackage {
  readonly root = new Group();
  readonly isImported: boolean;
  private base: BaseAvatar | null = null;
  private imported: ImportedAvatar | null = null;
  private driver: RigDriver;
  private expressionDriver: ExpressionDriver;
  private profile: AvatarProfile;
  private knownGarments: Map<string, GarmentManifest>;
  private importCompatibleGarments: string[] | null;
  private worn = new Map<string, Group>();
  private mixer: AnimationMixer;
  private clips = new Map<string, AnimationClip>();
  private currentAction: AnimationAction | null = null;
  /** 停止动作后回 bind pose 的插值状态。 */
  private restoreT = -1;
  private restoreEntries: RestoreEntry[] = [];
  private bindLocal = new Map<Object3D, { quat: Quaternion; pos: Vector3 }>();

  constructor(opts: AvatarPackageOptions) {
    this.profile = opts.profile;
    this.knownGarments = opts.knownGarments ?? new Map();
    this.importCompatibleGarments = opts.importCompatibleGarments ?? null;
    this.isImported = !!opts.imported;
    this.root.name = 'AvatarPackage';

    if (opts.imported) {
      this.imported = opts.imported;
      this.root.add(opts.imported.root);
      this.driver = opts.imported.driver;
      this.expressionDriver = createImportedExpressionDriver(opts.imported);
      // 预置动作重定向到实际骨骼名（预置动作只含 22 根最小骨架，手指骨骼跳过）
      const animationRigMap = new Map<StandardRigBone, Object3D>();
      for (const [bone, node] of opts.imported.rigMap) {
        if ((STANDARD_RIG_BONES as readonly string[]).includes(bone)) {
          animationRigMap.set(bone as StandardRigBone, node);
        }
      }
      const avatarHeight = new Box3()
        .setFromObject(opts.imported.root)
        .getSize(new Vector3()).y;
      const positionScale =
        Number.isFinite(avatarHeight) && avatarHeight > 0.2 ? avatarHeight / 1.7 : 1;
      for (const [id, clip] of createPresetClips()) {
        this.clips.set(id, retargetClipToRig(clip, animationRigMap, positionScale));
      }
    } else {
      this.base = opts.avatar ?? createBaseAvatar();
      this.root.add(this.base.root);
      const boneMap = new Map<StandardRigBone, Object3D>(
        Object.entries(this.base.bones) as [StandardRigBone, Object3D][],
      );
      this.root.updateMatrixWorld(true);
      this.driver = createRigDriver(boneMap, this.root);
      this.expressionDriver = createBaseExpressionDriver(this.base);
      for (const [id, clip] of createPresetClips()) this.clips.set(id, clip);
    }
    this.mixer = new AnimationMixer(this.root);

    // 记录驱动骨骼的绑定局部姿态（供 stopAnimation 回位）
    for (const [, obj] of this.driver.bones) {
      this.bindLocal.set(obj, { quat: obj.quaternion.clone(), pos: obj.position.clone() });
    }

    // 初始应用 Profile（内置底模）
    if (this.base) applyProfileToBase(this.base, this.profile);
    this.syncTraits(this.profile.traits);
  }

  getProfile(): AvatarProfile {
    return this.profile;
  }

  getBaseAvatar(): BaseAvatar | null {
    return this.base;
  }

  /** 应用完整 Profile（编辑器实时预览的唯一入口）。 */
  setProfile(profile: AvatarProfile): void {
    this.profile = profile;
    if (this.base) applyProfileToBase(this.base, profile);
    // 导入人物不伪造平台 morph / 体型能力，仅同步穿搭（FULL 时由校验拦截）
    this.syncTraits(profile.traits);
  }

  /** 换装事务：先 checkWearable 校验，再预构建，最后提交；失败不动场景。 */
  wearTrait(manifest: GarmentManifest): WearResult {
    const source = this.profile.assetSource;
    const result = checkWearable(manifest, {
      baseAvatarId: this.profile.baseAvatarId,
      boneScales: this.profile.boneScales,
      currentTraits: this.profile.traits,
      knownGarments: this.knownGarments,
      importCompatibleGarments: source.type === 'imported' ? this.importCompatibleGarments : null,
      importedCompatibility: source.type === 'imported' ? source.compatibility : null,
    });
    if (!result.success) return result;

    // 预构建新衣物（事务：构建失败不提交任何状态）
    let built: Group | null = null;
    if (!this.worn.has(manifest.id)) {
      const ctx = this.garmentContext();
      if (!ctx) return wearFailure('当前人物不支持平台换装');
      try {
        built = createGarment(manifest.id, ctx);
      } catch {
        return wearFailure(`无法构建衣物 ${manifest.displayName}（${manifest.id}）`);
      }
    }

    // 提交：卸下被替换的旧衣物
    const nextIds = traitIds(result.traits);
    for (const id of [...this.worn.keys()]) {
      if (!nextIds.includes(id)) this.removeWorn(id);
    }
    if (built) {
      this.worn.set(manifest.id, built);
      this.root.add(built);
    }
    this.profile = { ...this.profile, traits: result.traits };
    this.applyBodyMask(result.bodyMask);
    return result;
  }

  /** 卸下某个 Trait。 */
  unwearTrait(id: string): WearResult {
    if (!traitIds(this.profile.traits).includes(id)) {
      return wearFailure(`未穿着该衣物: ${id}`);
    }
    const traits = removeTraitFrom(this.profile.traits, id);
    this.removeWorn(id);
    this.profile = { ...this.profile, traits };
    const mask = computeBodyMask(traits, this.knownGarments);
    this.applyBodyMask(mask);
    return { success: true, traits, bodyMask: mask };
  }

  /** 当前穿搭的 BodyMask（来自 schema 汇总）。 */
  computeBodyMask(): string[] {
    return computeBodyMask(this.profile.traits, this.knownGarments);
  }

  getLoadedTraitIds(): string[] {
    return [...this.worn.keys()];
  }

  /** 外部 Profile 的 traits 变化 → 差异穿/卸（编辑器订阅用）。 */
  syncTraits(nextTraits: Traits): void {
    const nextIds = traitIds(nextTraits);
    for (const id of [...this.worn.keys()]) {
      if (!nextIds.includes(id)) this.removeWorn(id);
    }
    this.profile = { ...this.profile, traits: nextTraits };
    for (const id of nextIds) {
      if (this.worn.has(id)) continue;
      const manifest = this.knownGarments.get(id);
      if (manifest) this.wearTrait(manifest);
    }
  }

  /** 播放预置动作（0.35s 淡入淡出；坐下/站起为单次动作并保持末帧）。 */
  playAnimation(id: PresetAnimationId | string): boolean {
    const clip = this.clips.get(id);
    if (!clip) return false;
    this.cancelRestore();
    const action = this.mixer.clipAction(clip);
    const playback = PRESET_ANIMATION_PLAYBACK[id as PresetAnimationId] ?? { loop: true };
    action.clampWhenFinished = !playback.loop;
    action.setLoop(playback.loop ? LoopRepeat : LoopOnce, playback.loop ? Infinity : 1);
    if (this.currentAction === action && action.isRunning()) return true;
    action.reset().fadeIn(0.35).play();
    if (this.currentAction && this.currentAction !== action) this.currentAction.fadeOut(0.35);
    this.currentAction = action;
    return true;
  }

  /** 停止动作并平滑回 bind pose（0.25s）。 */
  stopAnimation(): void {
    this.mixer.stopAllAction();
    this.currentAction = null;
    this.beginRestore();
  }

  getCurrentAnimationId(): string | null {
    return this.currentAction?.getClip().name ?? null;
  }

  /** 摄像头姿态/手部驱动：写入世界系旋转增量（见 rig-driver）。 */
  applyBoneRotations(rotations: Partial<Record<ExtendedRigBone, QuatLike>>): void {
    this.cancelRestore();
    applyBoneRotations(this.driver, rotations);
  }

  /** 摄像头面部驱动：写入 VRM/GLB morph 或内置底模的简化表情。 */
  applyFaceExpressions(expressions: FaceExpressionWeights): void {
    this.expressionDriver.apply(expressions);
  }

  resetFaceExpressions(): void {
    this.expressionDriver.reset();
  }

  getSupportedFaceExpressions(): ReadonlySet<string> {
    return this.expressionDriver.supported;
  }

  getDriver(): RigDriver {
    return this.driver;
  }

  /** 每帧推进（动画混合与回位插值）。 */
  update(dt: number): void {
    this.mixer.update(dt);
    this.imported?.vrm?.update(dt);
    if (this.restoreT >= 0) {
      this.restoreT = Math.min(1, this.restoreT + dt / 0.25);
      const t = this.restoreT;
      const s = t * t * (3 - 2 * t); // smoothstep
      for (const entry of this.restoreEntries) {
        entry.obj.quaternion.slerpQuaternions(entry.fromQuat, entry.bindQuat, s);
        entry.obj.position.lerpVectors(entry.fromPos, entry.bindPos, s);
      }
      if (this.restoreT >= 1) {
        this.restoreT = -1;
        this.restoreEntries = [];
      }
    }
  }

  /** 释放几何、材质与动画资源。 */
  dispose(): void {
    this.expressionDriver.reset();
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    for (const id of [...this.worn.keys()]) this.removeWorn(id);
    this.root.traverse((obj) => {
      const mesh = obj as { geometry?: BufferGeometry; material?: Material | Material[] };
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) {
        if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
        else mesh.material.dispose();
      }
    });
    this.root.removeFromParent();
  }

  // ---------- 内部 ----------

  private garmentContext(): GarmentBuildContext | null {
    if (this.base) return { skeleton: this.base.skeleton, bones: this.base.bones };
    if (this.imported?.skeleton) {
      // 导入 FULL 人物：程序化衣物按内置底模尺寸构建，近似绑定到导入骨架
      return {
        skeleton: this.imported.skeleton,
        bones: Object.fromEntries(this.imported.rigMap) as unknown as BoneMap,
      };
    }
    return null;
  }

  private removeWorn(id: string): void {
    const group = this.worn.get(id);
    if (group) {
      disposeGarment(group);
      this.worn.delete(id);
    }
  }

  /** BodyMask → 隐藏对应 body_* 子网格（导入人物无分区子网格则跳过）。 */
  private applyBodyMask(mask: string[]): void {
    if (!this.base) return;
    for (const section of BODY_SECTIONS) {
      this.base.sections[section as BodySection].visible = !mask.includes(section);
    }
  }

  private beginRestore(): void {
    this.restoreEntries = [];
    for (const [obj, bind] of this.bindLocal) {
      this.restoreEntries.push({
        obj,
        fromQuat: obj.quaternion.clone(),
        bindQuat: bind.quat.clone(),
        fromPos: obj.position.clone(),
        bindPos: bind.pos.clone(),
      });
    }
    this.restoreT = this.restoreEntries.length > 0 ? 0 : -1;
  }

  private cancelRestore(): void {
    this.restoreT = -1;
    this.restoreEntries = [];
  }
}
