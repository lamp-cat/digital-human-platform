import { describe, expect, it } from 'vitest';
import { BufferGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import { createBaseAvatar } from '../src/base-avatar.js';
import {
  createBaseExpressionDriver,
  createImportedExpressionDriver,
} from '../src/expression-driver.js';
import type { ImportedAvatar } from '../src/imported.js';

describe('expression-driver', () => {
  it('内置底模支持独立眨眼和张嘴反馈', () => {
    const base = createBaseAvatar();
    const driver = createBaseExpressionDriver(base);
    driver.apply({ blinkLeft: 0.9, blinkRight: 0.1, aa: 0.8 });
    expect(base.eyeMeshes.left.scale.y).toBeLessThan(0.2);
    expect(base.eyeMeshes.right.scale.y).toBeGreaterThan(0.8);
    expect(base.mouthMesh.scale.y).toBeGreaterThan(4);
    driver.reset();
    expect(base.eyeMeshes.left.scale.y).toBe(1);
    expect(base.mouthMesh.scale.y).toBe(1);
  });

  it('普通 GLB 按常见 ARKit morph 名驱动', () => {
    const root = new Group();
    const mesh = new Mesh(new BufferGeometry(), new MeshBasicMaterial()) as Mesh & {
      morphTargetDictionary: Record<string, number>;
      morphTargetInfluences: number[];
    };
    mesh.morphTargetDictionary = {
      eyeBlinkLeft: 0,
      jawOpen: 1,
      mouthSmile: 2,
    };
    mesh.morphTargetInfluences = [0, 0, 0];
    root.add(mesh);
    const imported = { root } as unknown as ImportedAvatar;
    const driver = createImportedExpressionDriver(imported);
    driver.apply({ blinkLeft: 0.8, aa: 0.7, happy: 0.6 });
    expect(mesh.morphTargetInfluences[0]).toBeCloseTo(0.8);
    expect(mesh.morphTargetInfluences[1]).toBeCloseTo(0.7);
    expect(mesh.morphTargetInfluences[2]).toBeCloseTo(0.6);
  });
});
