import Hls from 'hls.js';
import {
  finalizeRecording,
  makeRecordingName,
  saveChunk,
  type RecordingMeta,
} from './storage';
import { pickRecordingFormat } from './format';

export interface CamConfig {
  id: string;
  name: string;
  streamUrl: string;
}

const CHUNK_MS = 30000;
const SEGMENT_MS = 3600000;
const MAX_RECORD_MS = 48 * 3600000;

export class HlsPlayer {
  private hls: Hls | null = null;
  private video: HTMLVideoElement;
  private streamUrl: string;
  private spinner: HTMLElement | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private onError?: (msg: string) => void;
  private onStatus?: (online: boolean) => void;

  constructor(video: HTMLVideoElement, streamUrl: string) {
    this.video = video;
    this.streamUrl = streamUrl;
    this.video.autoplay = true;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.preload = 'auto';
  }

  setOnError(cb: (msg: string) => void) {
    this.onError = cb;
  }

  setOnStatus(cb: (online: boolean) => void) {
    this.onStatus = cb;
  }

  start(spinner: HTMLElement) {
    this.spinner = spinner;
    this.destroyed = false;
    this.bindVideoEvents();
    this.startKeepAlive();

    if (Hls.isSupported()) {
      this.startHls();
    } else if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
      this.startNative();
    } else {
      this.onError?.('此瀏覽器不支援 HLS 播放');
    }
  }

  private bindVideoEvents() {
    this.video.addEventListener('playing', () => this.onPlaying());
    this.video.addEventListener('waiting', () => this.onWaiting());
    this.video.addEventListener('stalled', () => this.onWaiting());
    this.video.addEventListener('pause', () => {
      if (!this.destroyed && this.video.readyState < 3) {
        this.video.play().catch(() => {});
      }
    });
  }

  private onWaiting() {
    if (this.stallTimer) return;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      this.spinner?.classList.remove('hide');
      this.hls?.startLoad();
      this.video.play().catch(() => {});
    }, 3000);
  }

  private onPlaying() {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    this.spinner?.classList.add('hide');
    this.onStatus?.(true);
  }

  private startKeepAlive() {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = setInterval(() => {
      if (this.destroyed) return;
      if (this.video.paused && this.video.readyState >= 2) {
        this.video.play().catch(() => {});
      }
      if (this.hls?.liveSyncPosition && this.video.duration > 0) {
        const live = this.hls.liveSyncPosition;
        const drift = live - this.video.currentTime;
        if (drift > 20) {
          this.video.currentTime = live - 3;
        }
      }
    }, 8000);
  }

  private createHlsConfig(): Partial<Hls['config']> {
    return {
      enableWorker: true,
      lowLatencyMode: false,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 12,
      liveDurationInfinity: true,
      maxBufferLength: 90,
      maxMaxBufferLength: 180,
      backBufferLength: 60,
      maxBufferSize: 80 * 1000 * 1000,
      maxBufferHole: 0.5,
      highBufferWatchdogPeriod: 2,
      nudgeOffset: 0.1,
      nudgeMaxRetry: 8,
      startFragPrefetch: true,
      testBandwidth: false,
      fragLoadingMaxRetry: 8,
      fragLoadingRetryDelay: 500,
      manifestLoadingMaxRetry: 6,
      manifestLoadingRetryDelay: 500,
      levelLoadingMaxRetry: 6,
      xhrSetup: (xhr) => {
        xhr.withCredentials = false;
      },
    };
  }

  private startHls() {
    this.hls?.destroy();
    this.hls = new Hls(this.createHlsConfig());
    this.hls.loadSource(this.streamUrl);
    this.hls.attachMedia(this.video);

    this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
      this.video.play().catch(() => {});
    });

    this.hls.on(Hls.Events.ERROR, (_, data) => {
      if (this.destroyed) return;
      if (!data.fatal) return;

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        this.hls?.startLoad();
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        this.hls?.recoverMediaError();
        return;
      }
      this.scheduleRestart();
    });
  }

  private startNative() {
    this.video.src = this.streamUrl;
    this.video.play().catch(() => {});
  }

  private scheduleRestart() {
    if (this.restartTimer || this.destroyed) return;
    this.spinner?.classList.remove('hide');
    this.onStatus?.(false);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.destroyed) return;
      this.hls?.destroy();
      this.hls = null;
      if (Hls.isSupported()) this.startHls();
      else this.startNative();
    }, 4000);
  }

  destroy() {
    this.destroyed = true;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.hls?.destroy();
    this.hls = null;
  }
}

export class BrowserRecorder {
  private video: HTMLVideoElement;
  private cam: CamConfig;
  private mimeType: string;
  private fileExt: string;
  private recorder: MediaRecorder | null = null;
  private recording = false;
  private recordStart = 0;
  private segmentStart = 0;
  private maxEnd = 0;
  private currentId = '';
  private chunkIndex = 0;
  private segmentTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private onStatus?: (active: boolean, remainingSec: number) => void;
  private onSegmentDone?: (meta: RecordingMeta) => void;

  constructor(video: HTMLVideoElement, cam: CamConfig) {
    this.video = video;
    this.cam = cam;
    const fmt = pickRecordingFormat();
    this.mimeType = fmt.mimeType;
    this.fileExt = fmt.ext;
  }

  setCallbacks(
    onStatus: (active: boolean, remainingSec: number) => void,
    onSegmentDone: (meta: RecordingMeta) => void,
  ) {
    this.onStatus = onStatus;
    this.onSegmentDone = onSegmentDone;
  }

  get isRecording() {
    return this.recording;
  }

  get remainingSec() {
    if (!this.recording) return 0;
    return Math.max(0, Math.floor((this.maxEnd - Date.now()) / 1000));
  }

  async start(maxHours = 48): Promise<boolean> {
    if (this.recording) return true;

    const stream = (this.video as HTMLVideoElement & { captureStream?: () => MediaStream })
      .captureStream?.();
    if (!stream) {
      alert('無法擷取影片串流，請確認直播已正常播放。');
      return false;
    }

    this.recordStart = Date.now();
    this.maxEnd = this.recordStart + Math.min(maxHours, 48) * 3600000;
    this.recording = true;
    await this.beginSegment(stream);

    this.tickTimer = setInterval(() => {
      const left = this.remainingSec;
      this.onStatus?.(true, left);
      if (left <= 0) this.stop();
    }, 1000);

    this.segmentTimer = setInterval(async () => {
      if (!this.recording) return;
      const stream2 = (this.video as HTMLVideoElement & { captureStream?: () => MediaStream })
        .captureStream?.();
      if (stream2) await this.rotateSegment(stream2);
    }, SEGMENT_MS);

    this.onStatus?.(true, this.remainingSec);
    return true;
  }

  private async beginSegment(stream: MediaStream) {
    const now = new Date();
    this.currentId = `${this.cam.id}_${makeRecordingName(now)}_${Date.now()}`;
    this.chunkIndex = 0;
    this.segmentStart = Date.now();

    this.recorder = new MediaRecorder(stream, {
      mimeType: this.mimeType,
      videoBitsPerSecond: 2500000,
    });

    this.recorder.ondataavailable = async (ev) => {
      if (ev.data?.size > 0) {
        await saveChunk(this.currentId, this.chunkIndex++, ev.data);
      }
    };

    this.recorder.start(CHUNK_MS);
  }

  private async rotateSegment(stream: MediaStream) {
    await this.finishCurrentSegment();
    if (this.recording) await this.beginSegment(stream);
  }

  private async finishCurrentSegment(): Promise<RecordingMeta | null> {
    if (!this.recorder || this.recorder.state === 'inactive') return null;

    return new Promise((resolve) => {
      const rec = this.recorder!;
      const startDate = new Date(this.segmentStart);

      rec.onstop = async () => {
        const pad = (n: number) => n.toString().padStart(2, '0');
        const name = makeRecordingName(startDate);
        const meta = await finalizeRecording({
          id: this.currentId,
          camId: this.cam.id,
          name: `${name}.${this.fileExt}`,
          date: `${startDate.getFullYear()}-${pad(startDate.getMonth() + 1)}-${pad(startDate.getDate())}`,
          time: `${pad(startDate.getHours())}:${pad(startDate.getMinutes())}:${pad(startDate.getSeconds())}`,
          startTs: this.segmentStart,
          endTs: Date.now(),
          mimeType: this.mimeType,
        });
        this.onSegmentDone?.(meta);
        resolve(meta);
      };

      rec.stop();
    });
  }

  async stop(): Promise<void> {
    if (!this.recording) return;
    this.recording = false;

    if (this.segmentTimer) {
      clearInterval(this.segmentTimer);
      this.segmentTimer = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    await this.finishCurrentSegment();
    this.recorder = null;
    this.onStatus?.(false, 0);
  }
}

export { MAX_RECORD_MS, CHUNK_MS, SEGMENT_MS };
