import type { ExtendedRigBone } from '@dhp/avatar-schema';
import {
  CrouchMotionTracker,
  HandDriveManager,
  HandFrameSmoother,
  HandFrameStabilizer,
  LandmarkSmoother,
  PoseCollisionResolver,
  TemporalPoseCompleter,
  TrackingLossManager,
  mapPoseFrameToBoneRotations,
  type CalibrationData,
  type TrackingStatus,
} from '@dhp/rig-mapping';
import { OfflineMotionTracker } from '@dhp/vision-runtime';
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  Input,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
  getFirstEncodableVideoCodec,
  type VideoCodec,
} from 'mediabunny';
import type {
  AvatarSceneController,
  OfflineRenderSession,
} from '../three/AvatarSceneController';

export type VideoExportFormat = 'mp4' | 'webm';
export type OfflineExportPhase =
  | 'preparing'
  | 'tracking'
  | 'audio'
  | 'finalizing';

export interface FixedFrameTime {
  timestamp: number;
  duration: number;
}

export interface OfflineDanceExportProgress {
  phase: OfflineExportPhase;
  progress: number;
  frameIndex: number;
  frameCount: number;
}

export interface OfflineDanceExportMetrics {
  frames: number;
  activeFrames: number;
  rawConfidence: number;
  effectiveConfidence: number;
  coverage80: number;
  inferredPerFrame: number;
  handCoverage: number;
  collisionCorrections: number;
  trackingStatus: TrackingStatus;
}

export interface OfflineDanceExportOptions {
  file: File;
  /** HTMLVideoElement 读取到的用户可见源视频时长。 */
  sourceDurationSec: number;
  format: VideoExportFormat;
  quality: 'accurate' | 'smooth';
  calibration: CalibrationData;
  standingHipHeight: number | null;
  rigBones: ReadonlySet<string> | null;
  controller: AvatarSceneController;
  width?: number;
  height?: number;
  fps?: number;
  signal?: AbortSignal;
  onProgress?: (progress: OfflineDanceExportProgress) => void;
}

export interface OfflineDanceExportResult {
  blob: Blob;
  sourceDurationSec: number;
  encodedDurationSec: number;
  frameCount: number;
  audioIncluded: boolean;
  metrics: OfflineDanceExportMetrics;
}

interface MetricAccumulator {
  frames: number;
  activeFrames: number;
  rawSum: number;
  effectiveSum: number;
  covered80: number;
  inferredLandmarks: number;
  handFrames: number;
  collisionCorrections: number;
  trackingStatus: TrackingStatus;
}

const ABORT_MESSAGE = '精细渲染已取消';

export function buildFixedFrameTimeline(
  durationSec: number,
  fps: number,
): FixedFrameTime[] {
  if (!(durationSec > 0) || !(fps > 0)) return [];
  const frameCount = Math.max(1, Math.ceil(durationSec * fps));
  return Array.from({ length: frameCount }, (_, index) => {
    const timestamp = index / fps;
    return {
      timestamp,
      duration: Math.max(1e-6, Math.min(1 / fps, durationSec - timestamp)),
    };
  });
}

export function isOfflineVideoExportAvailable(): boolean {
  return (
    typeof VideoEncoder !== 'undefined' &&
    typeof VideoFrame !== 'undefined'
  );
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException(ABORT_MESSAGE, 'AbortError');
}

function summarizeMetrics(acc: MetricAccumulator): OfflineDanceExportMetrics {
  return {
    frames: acc.frames,
    activeFrames: acc.activeFrames,
    rawConfidence: acc.rawSum / Math.max(1, acc.frames),
    effectiveConfidence: acc.effectiveSum / Math.max(1, acc.activeFrames),
    coverage80: acc.covered80 / Math.max(1, acc.activeFrames),
    inferredPerFrame:
      acc.inferredLandmarks / Math.max(1, acc.activeFrames),
    handCoverage: acc.handFrames / Math.max(1, acc.frames),
    collisionCorrections: acc.collisionCorrections,
    trackingStatus: acc.trackingStatus,
  };
}

async function selectCodecs(
  format: VideoExportFormat,
  width: number,
  height: number,
  bitrate: number,
): Promise<VideoCodec> {
  const videoCandidates: VideoCodec[] =
    format === 'mp4' ? ['avc'] : ['vp9', 'vp8'];
  const video = await getFirstEncodableVideoCodec(videoCandidates, {
    width,
    height,
    bitrate,
  });
  if (!video) {
    throw new Error(
      format === 'mp4'
        ? '当前浏览器缺少 H.264 WebCodecs 编码器，无法进行独立 MP4 渲染'
        : '当前浏览器缺少 VP9/VP8 WebCodecs 编码器，无法进行独立 WebM 渲染',
    );
  }
  return video;
}

function closeRenderedCanvas(session: OfflineRenderSession | null): void {
  session?.dispose();
}

/**
 * 逐帧解码、识别、独立 WebGL 渲染并通过 WebCodecs 编码。
 *
 * 输出时间线完全由源媒体时长和固定 FPS 决定，不读取页面预览帧，也不等待
 * requestAnimationFrame，因此慢机器只会花更久时间，不会造成漏帧或变速。
 */
export async function exportOfflineDanceVideo(
  options: OfflineDanceExportOptions,
): Promise<OfflineDanceExportResult> {
  if (!isOfflineVideoExportAvailable()) {
    throw new Error('当前浏览器不支持 WebCodecs 精细渲染，请升级最新版 Chrome 或 Edge');
  }
  const width = Math.max(640, Math.round(options.width ?? 1280));
  const height = Math.max(360, Math.round(options.height ?? 720));
  const fps = Math.min(60, Math.max(24, Math.round(options.fps ?? 30)));
  const videoBitrate = options.quality === 'accurate' ? 8_000_000 : 5_000_000;
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(options.file),
  });
  let output: Output | null = null;
  let renderSession: OfflineRenderSession | null = null;
  let tracker: OfflineMotionTracker | null = null;

  try {
    assertNotAborted(options.signal);
    options.onProgress?.({
      phase: 'preparing',
      progress: 0.01,
      frameIndex: 0,
      frameCount: 0,
    });
    if (!(await input.canRead())) throw new Error('无法解码该视频文件');
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack || !(await videoTrack.canDecode())) {
      throw new Error('视频轨道无法由当前浏览器解码');
    }
    const audioTrack = await input.getPrimaryAudioTrack();
    const inputTracks = audioTrack ? [videoTrack, audioTrack] : [videoTrack];
    const sourceStart = await input.getFirstTimestamp(inputTracks);
    const videoStart = await input.getFirstTimestamp([videoTrack]);
    const decodedSourceEnd = await input.computeDuration(inputTracks);
    // 手机 MP4 的 AAC 尾包常比容器/视频时长多几十毫秒。用户看到的
    // HTMLVideoElement.duration 才是复现目标，音频必须裁到这一终点。
    const sourceDurationSec =
      Number.isFinite(options.sourceDurationSec) && options.sourceDurationSec > 0
        ? options.sourceDurationSec
        : Math.max(0, decodedSourceEnd - sourceStart);
    const sourceEnd = Math.min(
      decodedSourceEnd,
      sourceStart + sourceDurationSec,
    );
    const timeline = buildFixedFrameTimeline(sourceDurationSec, fps);
    if (timeline.length === 0) throw new Error('视频时长无效');

    const videoCodec = await selectCodecs(
      options.format,
      width,
      height,
      videoBitrate,
    );
    const target = new BufferTarget();
    const format =
      options.format === 'mp4'
        ? new Mp4OutputFormat({ fastStart: 'in-memory' })
        : new WebMOutputFormat();
    output = new Output({ format, target });
    renderSession = options.controller.createOfflineRenderSession(width, height);
    const videoSource = new CanvasSource(renderSession.canvas, {
      codec: videoCodec,
      bitrate: videoBitrate,
      keyFrameInterval: 2,
      latencyMode: 'quality',
      hardwareAcceleration: 'prefer-hardware',
    });
    output.addVideoTrack(videoSource);

    const sourceAudioCodec = await audioTrack?.getCodec();
    const audioDecoderConfig = await audioTrack?.getDecoderConfig();
    const expectedAudioCodec = options.format === 'mp4' ? 'aac' : 'opus';
    const audioIncluded =
      !!audioTrack &&
      sourceAudioCodec === expectedAudioCodec &&
      audioDecoderConfig !== null &&
      audioDecoderConfig !== undefined;
    let audioSource: EncodedAudioPacketSource | null = null;
    if (audioIncluded && sourceAudioCodec) {
      audioSource = new EncodedAudioPacketSource(sourceAudioCodec);
      output.addAudioTrack(audioSource);
    }

    tracker = new OfflineMotionTracker({
      wasmBasePath: '/mediapipe/wasm',
      poseModelVariant: options.quality === 'accurate' ? 'heavy' : 'full',
      delegate: 'GPU',
      trackingMode: 'full',
      poseQuality: {
        targetFps: fps,
        minPoseDetectionConfidence: 0.45,
        minPosePresenceConfidence: 0.45,
        minTrackingConfidence: 0.5,
      },
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.48,
      minHandTrackingConfidence: 0.62,
    });
    await tracker.load();
    assertNotAborted(options.signal);
    await output.start();

    const sourceWidth = await videoTrack.getDisplayWidth();
    const sourceHeight = await videoTrack.getDisplayHeight();
    const inferenceWidth = Math.min(1280, Math.max(640, sourceWidth));
    const inferenceHeight = Math.max(
      360,
      Math.round((inferenceWidth / Math.max(1, sourceWidth)) * sourceHeight),
    );
    const canvasSink = new CanvasSink(videoTrack, {
      width: inferenceWidth,
      height: inferenceHeight,
      fit: 'contain',
      poolSize: 2,
    });
    const completer = new TemporalPoseCompleter({
      trackingMode: 'full',
      reliableVisibility: 0.52,
      bootstrapVisibility: 0.18,
      maxGapMs: 1200,
      minInferenceConfidence: 0.68,
      maxInferenceConfidence: 0.86,
    });
    const collision = new PoseCollisionResolver({
      clearanceRatio: 0.1,
      frontBias: 0.32,
    });
    const poseSmoother = new LandmarkSmoother({
      minCutoff: 1.45,
      beta: 0.28,
    });
    const lossManager = new TrackingLossManager({
      trackingMode: 'full',
      confidenceThreshold: 0.48,
      freezeDelayMs: 300,
      blendStartMs: 750,
      blendDurationMs: 450,
    });
    const crouch = new CrouchMotionTracker(options.standingHipHeight, {
      maxSpeedMetersPerSec: 1.35,
    });
    const handStabilizer = new HandFrameStabilizer({
      enterConfidence: 0.5,
      exitConfidence: 0.4,
      forgetAfterFrames: 8,
      poseFrameMaxAgeMs: 80,
    });
    const handSmoother = new HandFrameSmoother({
      minCutoff: 1.35,
      beta: 0.32,
    });
    const handDrive = new HandDriveManager({
      rigBones: options.rigBones ?? undefined,
      temporalSmoothingMs: 65,
      maxAngularVelocityDegPerSec: 620,
      rotationDeadbandDeg: 0.85,
      handTemporalSmoothingMs: 145,
      handMaxAngularVelocityDegPerSec: 220,
      handRotationDeadbandDeg: 1.8,
      freezeDelayMs: 500,
      blendDurationMs: 900,
    });
    const acc: MetricAccumulator = {
      frames: 0,
      activeFrames: 0,
      rawSum: 0,
      effectiveSum: 0,
      covered80: 0,
      inferredLandmarks: 0,
      handFrames: 0,
      collisionCorrections: 0,
      trackingStatus: 'tracking',
    };
    // 部分手机 MP4 的 AAC 音轨会比视频首帧早几毫秒。输出仍从全局媒体
    // 起点计时，但在视频真正开始前保持第一帧，避免第 0 帧解码为空。
    const sourceTimes = timeline.map((frame) =>
      Math.max(videoStart, sourceStart + frame.timestamp),
    );
    let frameIndex = 0;

    for await (const wrapped of canvasSink.canvasesAtTimestamps(sourceTimes)) {
      assertNotAborted(options.signal);
      const timing = timeline[frameIndex];
      if (!timing) break;
      if (!wrapped) throw new Error(`第 ${frameIndex + 1} 帧解码失败`);
      const detected = tracker.detect(wrapped.canvas, timing.timestamp * 1000);
      const completion = completer.apply(detected.pose);
      const collisionResult = collision.apply(completion.frame);
      const pose = poseSmoother.apply(collisionResult.frame);
      const bodyRotations = mapPoseFrameToBoneRotations(
        pose,
        options.calibration,
        { mirror: false, trackingMode: 'full' },
      );
      const tracked = lossManager.updateWithFrame(
        pose.timestampMs,
        pose,
        bodyRotations,
      );
      const stabilizedHands = handStabilizer.apply(detected.hands, pose);
      const smoothedHands = handSmoother.apply(stabilizedHands);
      const handRotations = handDrive.update(
        smoothedHands,
        pose.timestampMs,
        pose,
      );

      options.controller.pkg?.applyBoneRotations(tracked.rotations);
      options.controller.pkg?.applyBoneRotations(handRotations);
      options.controller.pkg?.applyHipsOffsetY(
        tracked.status === 'tracking' ? crouch.update(pose) : 0,
      );
      renderSession.renderFrame();
      await videoSource.add(timing.timestamp, timing.duration, {
        keyFrame: frameIndex % (fps * 2) === 0,
      });

      acc.frames += 1;
      acc.rawSum += completion.rawConfidence;
      if (pose.landmarks.length > 0) {
        acc.activeFrames += 1;
        acc.effectiveSum += completion.effectiveConfidence;
        if (completion.effectiveConfidence >= 0.8) acc.covered80 += 1;
        acc.inferredLandmarks += completion.inferredLandmarks.length;
      }
      if (smoothedHands.hands.length > 0) acc.handFrames += 1;
      acc.collisionCorrections += collisionResult.correctedHands;
      acc.trackingStatus = tracked.status;
      frameIndex += 1;
      if (frameIndex === 1 || frameIndex % 3 === 0 || frameIndex === timeline.length) {
        options.onProgress?.({
          phase: 'tracking',
          progress: 0.04 + (frameIndex / timeline.length) * 0.86,
          frameIndex,
          frameCount: timeline.length,
        });
      }
      // MediaPipe 的同步 detectForVideo 会占用主线程；主动归还事件循环只影响
      // 等待时间，不影响固定媒体时间戳，使进度、停止按钮和页面状态始终可响应。
      if (frameIndex % 2 === 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    }
    if (frameIndex !== timeline.length) {
      throw new Error(`仅渲染 ${frameIndex}/${timeline.length} 帧，已阻止不完整视频导出`);
    }

    if (audioIncluded && audioTrack && audioSource) {
      options.onProgress?.({
        phase: 'audio',
        progress: 0.91,
        frameIndex,
        frameCount: timeline.length,
      });
      const audioSink = new EncodedPacketSink(audioTrack);
      const firstPacket =
        (await audioSink.getPacket(sourceStart)) ??
        (await audioSink.getFirstPacket());
      let firstOutputPacket = true;
      for await (const packet of audioSink.packets(firstPacket ?? undefined)) {
        assertNotAborted(options.signal);
        if (packet.timestamp >= sourceEnd) break;
        const clippedStart = Math.max(sourceStart, packet.timestamp);
        const clippedEnd = Math.min(
          sourceEnd,
          packet.timestamp + packet.duration,
        );
        if (clippedEnd <= clippedStart) continue;
        const clipped = packet.clone({
          timestamp: clippedStart - sourceStart,
          duration: clippedEnd - clippedStart,
        });
        await audioSource.add(
          clipped,
          firstOutputPacket
            ? { decoderConfig: audioDecoderConfig! }
            : undefined,
        );
        firstOutputPacket = false;
      }
    }

    options.onProgress?.({
      phase: 'finalizing',
      progress: 0.97,
      frameIndex,
      frameCount: timeline.length,
    });
    await output.finalize();
    const mimeType = await output.getMimeType();
    const buffer = target.buffer;
    if (!buffer || buffer.byteLength === 0) throw new Error('编码结果为空');
    const blob = new Blob([buffer], { type: mimeType });

    const verificationInput = new Input({
      formats: ALL_FORMATS,
      source: new BlobSource(blob),
    });
    let encodedDurationSec = sourceDurationSec;
    try {
      encodedDurationSec = await verificationInput.computeDuration();
    } finally {
      verificationInput.dispose();
    }
    const toleranceSec = Math.max(0.02, 1 / fps);
    if (Math.abs(encodedDurationSec - sourceDurationSec) > toleranceSec) {
      throw new Error(
        `导出时长校验失败：源视频 ${sourceDurationSec.toFixed(3)}s，成片 ${encodedDurationSec.toFixed(3)}s`,
      );
    }
    options.onProgress?.({
      phase: 'finalizing',
      progress: 1,
      frameIndex,
      frameCount: timeline.length,
    });
    return {
      blob,
      sourceDurationSec,
      encodedDurationSec,
      frameCount: timeline.length,
      audioIncluded,
      metrics: summarizeMetrics(acc),
    };
  } catch (error) {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') {
      await output.cancel().catch(() => undefined);
    }
    throw error;
  } finally {
    tracker?.close();
    input.dispose();
    closeRenderedCanvas(renderSession);
    options.controller.pkg?.applyHipsOffsetY(0);
  }
}
