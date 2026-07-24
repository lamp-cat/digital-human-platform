type CaptureCapableVideo = HTMLVideoElement & {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
};

export type VideoExportFormat = 'mp4' | 'webm';

export interface CanvasVideoRecorderOptions {
  fps?: number;
  videoBitsPerSecond?: number;
  audioBitsPerSecond?: number;
  sourceVideo?: HTMLVideoElement;
  /** 目标容器格式；默认 MP4，不会通过伪改扩展名降级。 */
  format?: VideoExportFormat;
}

type MimeTypeSupport = (mimeType: string) => boolean;

function browserSupportsMimeType(mimeType: string): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof MediaRecorder.isTypeSupported === 'function' &&
    MediaRecorder.isTypeSupported(mimeType)
  );
}

/**
 * MP4 使用兼容性较好的 H.264 Baseline + AAC-LC；没有音轨时不声明 AAC。
 * 末尾的容器级 MIME 让浏览器在支持 MP4、但只接受自动选码时仍可工作。
 */
export function getVideoMimeTypeCandidates(
  format: VideoExportFormat,
  hasAudio = false,
): string[] {
  if (format === 'mp4') {
    return hasAudio
      ? [
          'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
          'video/mp4;codecs=avc1,mp4a.40.2',
          'video/mp4',
        ]
      : [
          'video/mp4;codecs=avc1.42E01E',
          'video/mp4;codecs=avc1',
          'video/mp4',
        ];
  }
  return hasAudio
    ? [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
      ]
    : [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
      ];
}

/** 返回指定格式当前可用的首选编码；不会静默切换到另一种容器。 */
export function getSupportedVideoMimeType(
  format: VideoExportFormat = 'mp4',
  hasAudio = false,
  isTypeSupported: MimeTypeSupport = browserSupportsMimeType,
): string | null {
  return (
    getVideoMimeTypeCandidates(format, hasAudio).find((mime) =>
      isTypeSupported(mime),
    ) ?? null
  );
}

export function isVideoExportFormatSupported(format: VideoExportFormat): boolean {
  return (
    getSupportedVideoMimeType(format, false) !== null ||
    getSupportedVideoMimeType(format, true) !== null
  );
}

export function videoFormatFromMimeType(
  mimeType: string,
  fallback: VideoExportFormat = 'webm',
): VideoExportFormat {
  const normalized = mimeType.toLowerCase();
  if (normalized.startsWith('video/mp4')) return 'mp4';
  if (normalized.startsWith('video/webm')) return 'webm';
  return fallback;
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
      throw new Error('当前浏览器不支持画布视频录制，请使用最新版 Chrome、Edge 或 Safari');
    }
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('当前浏览器不支持视频录制，请使用最新版 Chrome、Edge 或 Safari');
    }

    const format = options.format ?? 'mp4';
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

    const candidates = getVideoMimeTypeCandidates(
      format,
      stream.getAudioTracks().length > 0,
    ).filter(browserSupportsMimeType);
    if (candidates.length === 0) {
      for (const track of stream.getTracks()) track.stop();
      throw new Error(
        format === 'mp4'
          ? '当前浏览器不支持 MP4 录制，请选择 WebM 或升级 Chrome、Edge、Safari'
          : '当前浏览器不支持 WebM 录制，请选择 MP4 或升级浏览器',
      );
    }

    let recorder: MediaRecorder | null = null;
    let selectedMimeType = '';
    for (const mimeType of candidates) {
      try {
        recorder = new MediaRecorder(stream, {
          mimeType,
          videoBitsPerSecond: options.videoBitsPerSecond ?? 8_000_000,
          audioBitsPerSecond: options.audioBitsPerSecond ?? 192_000,
        });
        selectedMimeType = mimeType;
        break;
      } catch {
        // isTypeSupported 是能力提示而非运行保证；继续尝试同容器的下一个编码组合。
      }
    }
    if (!recorder) {
      for (const track of stream.getTracks()) track.stop();
      throw new Error(
        format === 'mp4'
          ? 'MP4 编码器启动失败，请选择 WebM 兼容格式'
          : 'WebM 编码器启动失败，请选择 MP4 格式',
      );
    }

    this.recorder = recorder;
    this.mimeType = recorder.mimeType || selectedMimeType;
    this.outputStream = stream;
    this.chunks = [];
    this.stopPromise = new Promise<Blob>((resolve, reject) => {
      this.resolveStop = resolve;
      this.rejectStop = reject;
    });
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    recorder.onerror = (event) => {
      const error =
        'error' in event && event.error instanceof Error
          ? event.error
          : new Error('视频录制失败');
      this.rejectStop?.(error);
      this.cleanup();
    };
    recorder.onstop = () => {
      const blob = new Blob(this.chunks, { type: this.mimeType });
      this.resolveStop?.(blob);
      this.cleanup();
    };
    recorder.start(1000);
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
