import { describe, expect, it } from 'vitest';
import { buildFixedFrameTimeline } from './OfflineDanceVideoExporter';

describe('buildFixedFrameTimeline', () => {
  it('输出总时长严格等于源视频并截短末帧', () => {
    const timeline = buildFixedFrameTimeline(1.017, 30);
    const last = timeline.at(-1)!;
    expect(timeline).toHaveLength(31);
    expect(last.timestamp + last.duration).toBeCloseTo(1.017, 9);
    expect(last.duration).toBeLessThan(1 / 30);
  });

  it('整数帧时长不额外追加尾帧', () => {
    const timeline = buildFixedFrameTimeline(2, 30);
    const last = timeline.at(-1)!;
    expect(timeline).toHaveLength(60);
    expect(last.timestamp + last.duration).toBeCloseTo(2, 9);
  });
});
