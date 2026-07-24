type CaptureCapableVideo = HTMLVideoElement & {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
};

export interface CanvasVideoRecorderOptions {
  fps?: number;
  videoBitsPerSecond?: number;
  sourceVideo?: HTMLVideoElement;
}

/** 选择当前浏览器实际支持的 WebM 编码。 */
export function getSupportedVideoMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  return candidates.find((mime) => MediaRecorder.isTypeSupported(mime)) ?? null;
}

/**
 * 录制 Three.js 的最终画布；若浏览器允许捕获本地 video，则同时保留原声。
 * 全程只使用浏览器内存和 ObjectURL，不请求服务器。
 */
export class CanvasVideoRecorder {
  private recorder: MediaRecorder | null = null;
  private outputStream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private mimeType = '';
  private stopPromise: Promise<Blob> | null = null;
  private resolveStop: ((blob: Blob) => void) | null = null;
  private rejectStop: ((error: Error) => void) | null = null;

  start(canvas: HTMLCanvasElement, options: CanvasVideoRecorderOptions = {}): void {
    if (this.recorder) throw new Error('录制器已在运行');
    if (typeof canvas.captureStream !== 'function') {
      throw new Error('当前浏览器不支持画布视频录制，请使用最新版 Chrome 或 Edge');
    }
    const mimeType = getSupportedVideoMimeType();
    if (!mimeType) {
      throw new Error('当前浏览器不支持 WebM 录制，请使用最新版 Chrome 或 Edge');
    }

    const stream = canvas.captureStream(options.fps ?? 30);
    const source = options.sourceVideo as CaptureCapableVideo | undefined;
    const captureSource = source?.captureStream ?? source?.mozCaptureStream;
    if (source && captureSource) {
      try {
        const sourceStream = captureSource.call(source);
        for (const track of sourceStream.getAudioTracks()) stream.addTrack(track);
      } catch {
        // 部分浏览器只允许播放后捕获音轨；画面录制仍可继续。
      }
    }

    this.mimeType = mimeType;
    this.outputStream = stream;
    this.chunks = [];
    this.stopPromise = new Promise<Blob>((resolve, reject) => {
      this.resolveStop = resolve;
      this.rejectStop = reject;
    });
    this.recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: options.videoBitsPerSecond ?? 8_000_000,
    });
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.onerror = (event) => {
      const error =
        'error' in event && event.error instanceof Error
          ? event.error
          : new Error('视频录制失败');
      this.rejectStop?.(error);
      this.cleanup();
    };
    this.recorder.onstop = () => {
      const blob = new Blob(this.chunks, { type: this.mimeType });
      this.resolveStop?.(blob);
      this.cleanup();
    };
    this.recorder.start(1000);
  }

  isRecording(): boolean {
    return this.recorder?.state === 'recording';
  }

  stop(): Promise<Blob> {
    if (!this.recorder || !this.stopPromise) {
      return Promise.reject(new Error('录制器尚未启动'));
    }
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    return this.stopPromise;
  }

  cancel(): void {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.cleanup();
  }

  private cleanup(): void {
    for (const track of this.outputStream?.getTracks() ?? []) track.stop();
    this.outputStream = null;
    this.recorder = null;
    this.resolveStop = null;
    this.rejectStop = null;
    this.stopPromise = null;
  }
}
