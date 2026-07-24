import type { AssetSource, AvatarProfile } from '@dhp/avatar-schema';

/** 与 docs/api/api-contract.md 对齐的前端类型。 */

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: 'user' | 'asset_admin' | 'system_admin';
}

export interface AvatarSummary {
  id: string;
  name: string;
  baseAvatarId: string;
  version: number;
  coverUrl: string | null;
  visibility: string;
  createdAt: string;
  updatedAt: string;
}

export interface AvatarDetail extends AvatarSummary {
  profile: AvatarProfile;
  assetSource: AssetSource;
}

/** GarmentManifest 超集（资产目录条目）。 */
export interface AssetEntry {
  id: string;
  version: string;
  displayName: string;
  type: 'garment' | 'hair' | 'accessory' | 'shoes' | 'base_avatar' | 'animation';
  category: string;
  slots: string[];
  layer: number;
  rigVersion: string;
  compatibleBaseAvatars: string[];
  shapeConstraints: Record<string, [number, number]>;
  bodyMask: string[];
  replacesSlots: string[];
  restrictsTraits: Record<string, string[]>;
  license: { source: string; licenseId: string };
  status: 'draft' | 'published' | 'archived' | string;
  assets: { model: string; thumbnail?: string };
}

export interface EditableProfileDecl {
  morphs: string[];
  materials: string[];
}

export interface ImportRecord {
  id: string;
  status: string;
  compatibility: 'FULL' | 'POSE_ONLY' | 'REJECTED' | null;
  modelUrl: string | null;
  previewUrl: string | null;
  displayName: string;
  /** 后端若在记录中内联 manifest，前端据此渲染可编辑参数 */
  editableProfile?: EditableProfileDecl;
  compatibleGarments?: string[];
  manifest?: {
    editableProfile?: EditableProfileDecl;
    compatibleGarments?: string[];
  };
}

export interface ImportReportCheck {
  key?: string;
  name?: string;
  status: 'passed' | 'failed' | 'warning' | string;
  message?: string;
  suggestion?: string;
}

export interface ImportReport {
  compatibility?: 'FULL' | 'POSE_ONLY' | 'REJECTED';
  errorCode?: string | null;
  suggestions?: string[];
  checks?: ImportReportCheck[];
  [key: string]: unknown;
}

export interface Job {
  id: string;
  type: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | string;
  progress: number;
  resultJson?: unknown;
  errorCode?: string | null;
}
