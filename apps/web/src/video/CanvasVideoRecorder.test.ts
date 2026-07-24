import { describe, expect, it } from 'vitest';
import {
  getSupportedVideoMimeType,
  getVideoMimeTypeCandidates,
  videoFormatFromMimeType,
} from './CanvasVideoRecorder';

describe('CanvasVideoRecorder 格式选择', () => {
  it('有音轨的 MP4 优先选择 H.264 Baseline + AAC-LC', () => {
    const supported = new Set([
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4',
    ]);
    expect(
      getSupportedVideoMimeType('mp4', true, (mime) => supported.has(mime)),
    ).toBe('video/mp4;codecs=avc1.42E01E,mp4a.40.2');
  });

  it('无音轨的 MP4 不声明 AAC', () => {
    expect(getVideoMimeTypeCandidates('mp4', false)[0]).toBe(
      'video/mp4;codecs=avc1.42E01E',
    );
  });

  it('MP4 不受支持时不会伪装成 WebM', () => {
    const webmOnly = (mime: string) => mime.startsWith('video/webm');
    expect(getSupportedVideoMimeType('mp4', false, webmOnly)).toBeNull();
    expect(getSupportedVideoMimeType('webm', false, webmOnly)).toMatch(
      /^video\/webm/,
    );
  });

  it('按照真实 Blob MIME 选择下载扩展名', () => {
    expect(
      videoFormatFromMimeType('video/mp4;codecs=avc1.42E01E'),
    ).toBe('mp4');
    expect(videoFormatFromMimeType('video/webm;codecs=vp9')).toBe('webm');
    expect(videoFormatFromMimeType('application/octet-stream', 'mp4')).toBe('mp4');
  });
});
