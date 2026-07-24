import { create } from 'zustand';
import { createDefaultProfile, type AvatarProfile } from '@dhp/avatar-schema';
import type { AvatarDetail } from '../api/types';

/**
 * avatarDocumentStore：当前编辑文档（profile、版本、撤销栈、保存状态）。
 * 规则（文档 §11.4）：滑杆拖动实时预览，停止 200ms 后才写撤销栈。
 */

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export interface VersionConflict {
  latestVersion: number;
  latestProfile: AvatarProfile | null;
}

interface AvatarDocumentState {
  avatarId: string | null;
  name: string;
  profile: AvatarProfile;
  version: number;
  saveState: SaveState;
  undoStack: AvatarProfile[];
  redoStack: AvatarProfile[];
  conflict: VersionConflict | null;

  load: (avatar: AvatarDetail) => void;
  reset: () => void;
  setName: (name: string) => void;
  /** 实时预览编辑（拖动中），停止 200ms 后自动写入撤销栈。 */
  previewEdit: (mutate: (p: AvatarProfile) => AvatarProfile) => void;
  /** 离散编辑（色板/穿搭/恢复默认），立即写入撤销栈。 */
  applyEdit: (mutate: (p: AvatarProfile) => AvatarProfile) => void;
  undo: () => void;
  redo: () => void;
  markSaving: () => void;
  markSaved: (version: number) => void;
  markSaveError: () => void;
  setConflict: (conflict: VersionConflict) => void;
  clearConflict: () => void;
}

const UNDO_LIMIT = 50;
const PREVIEW_DEBOUNCE_MS = 200;

// 预览编辑的去抖状态（拖动期间只记一次基准快照）
let previewBase: AvatarProfile | null = null;
let previewTimer: ReturnType<typeof setTimeout> | undefined;

function clearPreviewTimer(): void {
  if (previewTimer !== undefined) clearTimeout(previewTimer);
  previewTimer = undefined;
}

export const useAvatarDocumentStore = create<AvatarDocumentState>((set, get) => {
  const pushUndo = (base: AvatarProfile) => {
    const { undoStack } = get();
    set({ undoStack: [...undoStack.slice(-(UNDO_LIMIT - 1)), base], redoStack: [] });
  };

  return {
    avatarId: null,
    name: '',
    profile: createDefaultProfile(),
    version: 1,
    saveState: 'idle',
    undoStack: [],
    redoStack: [],
    conflict: null,

    load(avatar) {
      clearPreviewTimer();
      previewBase = null;
      set({
        avatarId: avatar.id,
        name: avatar.name,
        profile: avatar.profile,
        version: avatar.version,
        saveState: 'idle',
        undoStack: [],
        redoStack: [],
        conflict: null,
      });
    },

    reset() {
      clearPreviewTimer();
      previewBase = null;
      set({
        avatarId: null,
        name: '',
        profile: createDefaultProfile(),
        version: 1,
        saveState: 'idle',
        undoStack: [],
        redoStack: [],
        conflict: null,
      });
    },

    setName(name) {
      set({ name, saveState: get().saveState === 'saving' ? 'saving' : 'dirty' });
    },

    previewEdit(mutate) {
      const current = get().profile;
      if (!previewBase) previewBase = current; // 一次拖动只记一次基准
      const next = mutate(current);
      set({ profile: next, saveState: 'dirty' });
      clearPreviewTimer();
      previewTimer = setTimeout(() => {
        previewTimer = undefined;
        if (previewBase) {
          pushUndo(previewBase);
          previewBase = null;
        }
      }, PREVIEW_DEBOUNCE_MS);
    },

    applyEdit(mutate) {
      // 有未提交的预览基准时先提交，保证顺序正确
      clearPreviewTimer();
      if (previewBase) {
        pushUndo(previewBase);
        previewBase = null;
      }
      const current = get().profile;
      pushUndo(current);
      set({ profile: mutate(current), saveState: 'dirty' });
    },

    undo() {
      const { undoStack, redoStack, profile } = get();
      if (undoStack.length === 0) return;
      clearPreviewTimer();
      previewBase = null;
      const prev = undoStack[undoStack.length - 1];
      set({
        profile: prev,
        undoStack: undoStack.slice(0, -1),
        redoStack: [...redoStack, profile],
        saveState: 'dirty',
      });
    },

    redo() {
      const { undoStack, redoStack, profile } = get();
      if (redoStack.length === 0) return;
      clearPreviewTimer();
      previewBase = null;
      const next = redoStack[redoStack.length - 1];
      set({
        profile: next,
        redoStack: redoStack.slice(0, -1),
        undoStack: [...undoStack, profile],
        saveState: 'dirty',
      });
    },

    markSaving: () => set({ saveState: 'saving' }),
    markSaved: (version) => set({ saveState: 'saved', version }),
    markSaveError: () => set({ saveState: 'error' }),
    setConflict: (conflict) => set({ conflict, saveState: 'dirty' }),
    clearConflict: () => set({ conflict: null }),
  };
});
