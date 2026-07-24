import { Vector3 } from 'three';

/** 结构化关键点（PoseLandmark / HandLandmark 均满足）。 */
export interface LandmarkLike {
  x: number;
  y: number;
  z: number;
  wx?: number;
  wy?: number;
  wz?: number;
}

/**
 * MediaPipe 图像归一化坐标 → 平台世界坐标。
 * 世界系约定：x 向右、y 向上、+Z 朝向摄像头（角色面向 +Z，正对观察者）。
 * - 图像 y 向下 → 世界 y = 0.5 - y（手上抬 = 图像 y 减小 = 世界 y 增大）；
 * - 图像 z 越靠近摄像头越负 → 世界 z = -z（靠近摄像头 = 世界 +Z）；
 * - 图像 x 不翻转：人物面向摄像头时解剖学左侧出现在图像右侧，
 *   与面向 +Z 的角色（左手在 +X）天然一致，delta 旋转才能直接用于世界系。
 *
 * mirror=true 为真镜像模式：x 翻转。调用方必须同时用 swapLateralName
 * 交换左右关键点名——只翻 x 不换左右属于反射错位，会让校准方向与角色
 * 绑定姿态相反，上下/前后动作全部颠倒。
 */
export function imageToWorld(p: { x: number; y: number; z: number }, mirror: boolean): Vector3 {
  const x = mirror ? 1 - p.x : p.x;
  return new Vector3(x - 0.5, 0.5 - p.y, -p.z);
}

/**
 * MediaPipe worldLandmarks（米制、髋部中点原点）→ 平台世界坐标。
 * worldLandmarks 与图像坐标同向（y 向下为正、z 朝摄像头为负），但单位是米、
 * 原点在髋部、深度是真实估计而非相对值，噪声远小于图像 z——优先用它算肢体方向。
 * 平台世界系 y 向上、+Z 朝摄像头，故 y/z 取反；x 与图像 x 同向不翻转。
 * mirror=true（真镜像）：x 取反并配合 swapLateralName 交换左右（同 imageToWorld 语义）。
 */
export function worldToWorld(p: { wx: number; wy: number; wz: number }, mirror: boolean): Vector3 {
  const x = mirror ? -p.wx : p.wx;
  return new Vector3(x, -p.wy, -p.wz);
}

/** 关键点是否携带 worldLandmarks 坐标。 */
export function hasWorldCoords(lm: LandmarkLike): lm is LandmarkLike & { wx: number; wy: number; wz: number } {
  return lm.wx !== undefined && lm.wy !== undefined && lm.wz !== undefined;
}

/**
 * 单个关键点 → 平台世界坐标：有 worldLandmarks 优先用（米制、深度可靠），
 * 否则回退图像归一化坐标（旧数据/合成帧）。校准与实时帧走同一入口，保证同源。
 */
export function landmarkToWorld(lm: LandmarkLike, mirror: boolean): Vector3 {
  return hasWorldCoords(lm) ? worldToWorld(lm, mirror) : imageToWorld(lm, mirror);
}

/** 左右侧关键点名互换（mirror=true 时配合 x 翻转，保持镜像语义一致）。 */
export function swapLateralName(name: string): string {
  if (name.startsWith('left_')) return `right_${name.slice('left_'.length)}`;
  if (name.startsWith('right_')) return `left_${name.slice('right_'.length)}`;
  return name;
}
