import { create } from 'zustand';
import { api, ApiError, AUTH_STORAGE_KEY } from '../api/client';
import type { User } from '../api/types';

/** authStore：token/user，持久化到 localStorage。 */

interface AuthState {
  token: string | null;
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName?: string) => Promise<void>;
  logout: () => void;
  loadMe: () => Promise<void>;
}

function loadPersisted(): { token: string | null; user: User | null } {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return { token: null, user: null };
    const parsed = JSON.parse(raw);
    return { token: parsed.token ?? null, user: parsed.user ?? null };
  } catch {
    return { token: null, user: null };
  }
}

function persist(token: string, user: User): void {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token, user }));
}

export const useAuthStore = create<AuthState>((set, get) => ({
  ...loadPersisted(),

  async login(email, password) {
    const { token, user } = await api.login(email, password);
    persist(token, user);
    set({ token, user });
  },

  async register(email, password, displayName) {
    const { token, user } = await api.register(email, password, displayName);
    persist(token, user);
    set({ token, user });
  },

  logout() {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    set({ token: null, user: null });
  },

  async loadMe() {
    if (!get().token) return;
    try {
      const { user } = await api.me();
      const token = get().token!;
      persist(token, user);
      set({ user });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) get().logout();
    }
  },
}));

export const isAdminRole = (user: User | null): boolean =>
  !!user && (user.role === 'asset_admin' || user.role === 'system_admin');
