import type { Object3D } from 'three';
import {
  FACE_EXPRESSION_NAMES,
  type FaceExpressionName,
  type FaceExpressionWeights,
} from '@dhp/avatar-schema';
import type { BaseAvatar } from './base-avatar.js';
import type { ImportedAvatar, MorphTargetBinding } from './imported.js';

export interface ExpressionDriver {
  supported: ReadonlySet<FaceExpressionName>;
  apply(weights: FaceExpressionWeights): void;
  reset(): void;
}

const clamp01 = (value: number | undefined): number =>
  Math.min(1, Math.max(0, value ?? 0));

function normalizedName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const GENERIC_MORPH_ALIASES: Record<FaceExpressionName, readonly string[]> = {
  blink: ['blink', 'eyeclose', 'fcleyeclose'],
  blinkLeft: ['blinkleft', 'blinkl', 'eyeblinkleft', 'fcleyeclosel'],
  blinkRight: ['blinkright', 'blinkr', 'eyeblinkright', 'fcleyecloser'],
  lookUp: ['lookup', 'eyelookup', 'eyelookupleft', 'eyelookupright'],
  lookDown: ['lookdown', 'eyelookdown', 'eyelookdownleft', 'eyelookdownright'],
  lookLeft: ['lookleft', 'eyelookleft', 'eyelookoutleft', 'eyelookinright'],
  lookRight: ['lookright', 'eyelookright', 'eyelookinleft', 'eyelookoutright'],
  aa: ['aa', 'a', 'jawopen', 'mouthopen', 'fclmtha'],
  ih: ['ih', 'i', 'fclmthi'],
  ee: ['ee', 'e', 'mouthstretch', 'fclmthe'],
  oh: ['oh', 'o', 'mouthfunnel', 'fclmtho'],
  ou: ['ou', 'u', 'mouthpucker', 'fclmthu'],
  happy: ['happy', 'joy', 'smile', 'mouthsmile', 'mouthsmileleft', 'mouthsmileright', 'fclalljoy'],
  angry: ['angry', 'anger', 'browdownleft', 'browdownright', 'fclallangry'],
  sad: ['sad', 'sorrow', 'mouthfrownleft', 'mouthfrownright', 'fclallsorrow'],
  surprised: ['surprised', 'surprise', 'eyewideleft', 'eyewideright', 'browinnerup'],
  relaxed: ['relaxed', 'fun', 'fclallfun'],
};

type MorphMesh = Object3D & {
  morphTargetDictionary?: Record<string, number>;
  morphTargetInfluences?: number[];
};

function discoverGenericBindings(root: Object3D): Map<FaceExpressionName, MorphTargetBinding[]> {
  const byAlias = new Map<string, FaceExpressionName>();
  for (const name of FACE_EXPRESSION_NAMES) {
    for (const alias of GENERIC_MORPH_ALIASES[name]) byAlias.set(normalizedName(alias), name);
  }

  const groups = new Map<FaceExpressionName, MorphTargetBinding[]>();
  root.traverse((obj) => {
    const mesh = obj as MorphMesh;
    if (!mesh.morphTargetDictionary || !mesh.morphTargetInfluences) return;
    for (const [targetName, index] of Object.entries(mesh.morphTargetDictionary)) {
      const expression = byAlias.get(normalizedName(targetName));
      if (!expression || index < 0 || index >= mesh.morphTargetInfluences.length) continue;
      const list = groups.get(expression) ?? [];
      list.push({ mesh, index, scale: 1 });
      groups.set(expression, list);
    }
  });
  return groups;
}

function createMorphBindingDriver(
  groups: Map<FaceExpressionName, MorphTargetBinding[]>,
): ExpressionDriver {
  const supported = new Set(groups.keys());
  const touched = new Set<MorphTargetBinding>();
  for (const bindings of groups.values()) for (const binding of bindings) touched.add(binding);

  return {
    supported,
    apply(weights) {
      // 左右独立眨眼不存在时回退到双眼 blink。
      const resolved: FaceExpressionWeights = { ...weights };
      if (!supported.has('blinkLeft') && !supported.has('blinkRight')) {
        resolved.blink = Math.max(
          clamp01(weights.blink),
          (clamp01(weights.blinkLeft) + clamp01(weights.blinkRight)) / 2,
        );
      } else {
        resolved.blink = 0;
      }
      for (const [name, bindings] of groups) {
        const value = clamp01(resolved[name]);
        for (const binding of bindings) {
          if (binding.mesh.morphTargetInfluences) {
            binding.mesh.morphTargetInfluences[binding.index] = value * binding.scale;
          }
        }
      }
    },
    reset() {
      for (const binding of touched) {
        if (binding.mesh.morphTargetInfluences) binding.mesh.morphTargetInfluences[binding.index] = 0;
      }
    },
  };
}

export function createBaseExpressionDriver(base: BaseAvatar): ExpressionDriver {
  const supported = new Set<FaceExpressionName>([
    'blink',
    'blinkLeft',
    'blinkRight',
    'aa',
    'oh',
    'ou',
    'happy',
    'surprised',
  ]);
  return {
    supported,
    apply(weights) {
      const commonBlink = clamp01(weights.blink);
      const leftBlink = Math.max(commonBlink, clamp01(weights.blinkLeft));
      const rightBlink = Math.max(commonBlink, clamp01(weights.blinkRight));
      base.eyeMeshes.left.scale.y = Math.max(0.06, 1 - leftBlink * 0.94);
      base.eyeMeshes.right.scale.y = Math.max(0.06, 1 - rightBlink * 0.94);

      const happy = clamp01(weights.happy);
      const open = Math.max(
        clamp01(weights.aa),
        clamp01(weights.oh),
        clamp01(weights.surprised) * 0.72,
      );
      const pucker = clamp01(weights.ou);
      base.mouthMesh.scale.x = Math.max(0.5, 1 + happy * 0.42 - pucker * 0.3);
      base.mouthMesh.scale.y = 1 + open * 4.2 + clamp01(weights.oh) * 0.8;
      base.mouthMesh.position.y = 0.025 + happy * 0.008;
    },
    reset() {
      base.eyeMeshes.left.scale.y = 1;
      base.eyeMeshes.right.scale.y = 1;
      base.mouthMesh.scale.set(1, 1, 1);
      base.mouthMesh.position.y = 0.025;
    },
  };
}

export function createImportedExpressionDriver(imported: ImportedAvatar): ExpressionDriver {
  const manager = imported.vrm?.expressionManager;
  if (manager) {
    const supported = new Set<FaceExpressionName>(
      FACE_EXPRESSION_NAMES.filter((name) => manager.getExpression(name) !== null),
    );
    return {
      supported,
      apply(weights) {
        const separateBlink = supported.has('blinkLeft') || supported.has('blinkRight');
        for (const name of supported) {
          let value = clamp01(weights[name]);
          if (name === 'blink') {
            value = separateBlink
              ? 0
              : Math.max(value, (clamp01(weights.blinkLeft) + clamp01(weights.blinkRight)) / 2);
          }
          manager.setValue(name, value);
        }
      },
      reset() {
        manager.resetValues();
        manager.update();
      },
    };
  }

  // VRM 0.x 显式 BlendShapeGroup 优先；普通 GLB 再按常见 morph 名精确匹配。
  const groups = imported.legacyExpressionGroups?.size
    ? imported.legacyExpressionGroups
    : discoverGenericBindings(imported.root);
  return createMorphBindingDriver(groups);
}
