import { create } from 'zustand';

/** uiStore：面板状态与全局提示。 */

export type EditorCategory = 'face' | 'body' | 'skin' | 'outfit';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

interface UiState {
  activeCategory: EditorCategory;
  setCategory: (c: EditorCategory) => void;
  toasts: Toast[];
  toast: (text: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
}

let nextToastId = 1;

export const useUiStore = create<UiState>((set) => ({
  activeCategory: 'face',
  setCategory: (c) => set({ activeCategory: c }),
  toasts: [],
  toast: (text, kind = 'info') => {
    const id = nextToastId++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 4200);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
