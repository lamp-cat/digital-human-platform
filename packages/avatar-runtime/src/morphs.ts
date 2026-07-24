import { BufferAttribute, BufferGeometry } from 'three';
import { MORPH_PARAM_KEYS, type MorphParamKey } from '@dhp/avatar-schema';

/**
 * body_head 几何体的程序化 Morph Target 生成。
 * 约定：头部为以 (0, HEAD_CENTER_Y, 0) 为中心的椭球，面部朝 +Z。
 * 每个 morph target 按顶点所在面部区域施加位移，target 名与参数 key 一致。
 */

export const HEAD_CENTER_Y = 1.575;
export const HEAD_RADIUS = 0.115;

type Vec3 = [number, number, number];

/** 盒状区域权重：盒内为 1，向外一个 falloff 距离内线性衰减到 0。 */
function regionWeight(p: Vec3, center: Vec3, half: Vec3, falloff = 0.6): number {
  let w = 1;
  for (let i = 0; i < 3; i++) {
    const d = Math.abs(p[i] - center[i]);
    const h = Math.max(half[i], 1e-6);
    if (d <= h) continue;
    const t = 1 - (d - h) / (h * falloff);
    if (t <= 0) return 0;
    w *= t;
  }
  return w;
}

/** 双眼区域权重（左右两个盒的并集，取最大值）。 */
function eyeWeight(p: Vec3): number {
  const wl = regionWeight(p, [0.042, 0.012, 0.1], [0.026, 0.022, 0.035]);
  const wr = regionWeight(p, [-0.042, 0.012, 0.1], [0.026, 0.022, 0.035]);
  return Math.max(wl, wr);
}

function cheekWeight(p: Vec3): number {
  return regionWeight(p, [0, 0, 0.05], [0.115, 0.055, 0.06]);
}
function faceWeight(p: Vec3): number {
  // 面部前半（z > 0）整体
  return regionWeight(p, [0, 0, 0.06], [0.13, 0.13, 0.06], 0.8);
}
function jawWeight(p: Vec3): number {
  // 下半脸
  const t = Math.min(Math.max((-p[1] - 0.02) / 0.05, 0), 1);
  return t * regionWeight(p, [0, -0.06, 0.04], [0.1, 0.05, 0.07]);
}
function chinWeight(p: Vec3): number {
  return regionWeight(p, [0, -0.1, 0.05], [0.045, 0.03, 0.05]);
}
function noseWeight(p: Vec3): number {
  return regionWeight(p, [0, -0.028, 0.1], [0.022, 0.035, 0.035]);
}
function mouthWeight(p: Vec3): number {
  return regionWeight(p, [0, -0.07, 0.09], [0.045, 0.018, 0.035]);
}

/** 单个参数对顶点 p（相对头中心）的位移。 */
function morphDelta(key: MorphParamKey, p: Vec3): Vec3 {
  const [x, y, z] = p;
  switch (key) {
    case 'faceWidth': {
      const w = cheekWeight(p);
      return [x * 0.35 * w, 0, 0];
    }
    case 'faceLength': {
      const w = faceWeight(p);
      return [0, y * 0.18 * w, 0];
    }
    case 'jawWidth': {
      const w = jawWeight(p);
      return [x * 0.45 * w, 0, 0];
    }
    case 'chinLength': {
      const w = chinWeight(p);
      return [0, -0.03 * w, 0.015 * w];
    }
    case 'eyeSize': {
      // 绕各自眼心缩放
      const wl = regionWeight(p, [0.042, 0.012, 0.1], [0.026, 0.022, 0.035]);
      const wr = regionWeight(p, [-0.042, 0.012, 0.1], [0.026, 0.022, 0.035]);
      const s = 0.4;
      return [
        ((x - 0.042) * wl + (x + 0.042) * wr) * s,
        (y - 0.012) * (wl + wr) * s,
        (z - 0.1) * (wl + wr) * s * 0.5,
      ];
    }
    case 'eyeSpacing': {
      const w = eyeWeight(p);
      return [Math.sign(x || 1) * 0.016 * w, 0, 0];
    }
    case 'eyeHeight': {
      const w = eyeWeight(p);
      return [0, 0.016 * w, 0];
    }
    case 'noseWidth': {
      const w = noseWeight(p);
      return [x * 0.6 * w, 0, 0];
    }
    case 'noseHeight': {
      const w = noseWeight(p);
      return [0, 0.02 * w, 0.028 * w];
    }
    case 'mouthWidth': {
      const w = mouthWeight(p);
      return [x * 0.5 * w, 0, 0];
    }
    case 'lipFullness': {
      const w = mouthWeight(p);
      return [0, -0.004 * w, 0.016 * w];
    }
    default: {
      const _exhaustive: never = key;
      void _exhaustive;
      return [0, 0, 0];
    }
  }
}

/**
 * 为头部几何体生成 11 个 morph target（绝对坐标模式）。
 * 要求几何体已定位到头中心 (0, HEAD_CENTER_Y, 0)。
 */
export function addHeadMorphTargets(geometry: BufferGeometry): void {
  const pos = geometry.getAttribute('position') as BufferAttribute;
  const count = pos.count;
  const targets: BufferAttribute[] = MORPH_PARAM_KEYS.map((key) => {
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const p: Vec3 = [
        pos.getX(i),
        pos.getY(i) - HEAD_CENTER_Y,
        pos.getZ(i),
      ];
      const d = morphDelta(key, p);
      arr[i * 3] = pos.getX(i) + d[0];
      arr[i * 3 + 1] = pos.getY(i) + d[1];
      arr[i * 3 + 2] = pos.getZ(i) + d[2];
    }
    const attr = new BufferAttribute(arr, 3);
    attr.name = key;
    return attr;
  });
  geometry.morphAttributes.position = targets;
  geometry.morphTargetsRelative = false;
}
