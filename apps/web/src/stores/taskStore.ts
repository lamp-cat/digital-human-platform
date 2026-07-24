import { create } from 'zustand';
import { api } from '../api/client';
import type { ImportRecord, Job } from '../api/types';

/** taskStore：导入任务与轮询状态。 */

interface TaskState {
  importId: string | null;
  job: Job | null;
  importRecord: ImportRecord | null;
  uploadProgress: number;
  polling: boolean;
  setUploadProgress: (p: number) => void;
  beginImport: (importRecord: ImportRecord, job: Job) => void;
  setJob: (job: Job) => void;
  setImportRecord: (record: ImportRecord) => void;
  /** 轮询任务直至终态，成功后顺带刷新导入记录。 */
  pollJob: (jobId: string) => void;
  stopPolling: () => void;
  reset: () => void;
}

let pollTimer: ReturnType<typeof setInterval> | undefined;

export const useTaskStore = create<TaskState>((set, get) => ({
  importId: null,
  job: null,
  importRecord: null,
  uploadProgress: 0,
  polling: false,

  setUploadProgress: (p) => set({ uploadProgress: p }),
  beginImport: (importRecord, job) => set({ importId: importRecord.id, importRecord, job }),
  setJob: (job) => set({ job }),
  setImportRecord: (record) => set({ importRecord: record }),

  pollJob(jobId) {
    get().stopPolling();
    set({ polling: true });
    pollTimer = setInterval(async () => {
      try {
        const { job } = await api.getJob(jobId);
        set({ job });
        if (job.status === 'succeeded' || job.status === 'failed') {
          get().stopPolling();
          const importId = get().importId;
          if (importId) {
            const { importRecord } = await api.getImport(importId);
            set({ importRecord });
          }
        }
      } catch {
        // 网络抖动时继续轮询
      }
    }, 1200);
  },

  stopPolling() {
    if (pollTimer !== undefined) clearInterval(pollTimer);
    pollTimer = undefined;
    set({ polling: false });
  },

  reset() {
    get().stopPolling();
    set({ importId: null, job: null, importRecord: null, uploadProgress: 0 });
  },
}));
