import Hls from 'hls.js';
import {
  finalizeRecording,
  makeRecordingName,
  saveChunk,
  type RecordingMeta,
} from './storage';

export interface CamConfig {
  id: string;
  name: string;
  streamUrl: string;
}

const CHUNK_MS = 30000;
const SEGMENT_MS = 3600000;
const MAX_RECORD_MS = 48 * 3600000;

function pickMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const m of candidates) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return 'video/webm';
}

export class HlsPlayer {
  private hls: Hls | null = null;
  private video: HTMLVideoElement;
  private streamUrl: string;
  private onError?: (msg: string) => void;

  constructor(video: HTMLVideoElement, streamUrl: string) {
    this.video = video;
    this.streamUrl = streamUrl;
  }

  setOnError(cb: (msg: string) => void) {
    this.onError = cb;
  }

  start(spinner: HTMLElement) {
    const spinTxt = spinner.querySelector('.spin-txt');
    if (Hls.isSupported()) {
      this.hls = new Hls({
        lowLatencyMode: true,
        maxBufferLength: 30,
        xhrSetup: (xhr) => {
          xhr.withCredentials = false;
        },
      });
      this.hls.loadSource(this.streamUrl);
      this.hls.attachMedia(this.video);
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        this.video.play().catch(() => {});
        spinner.classList.add('hide');
      });
      this.hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          spinner.classList.remove('hide');
          if (spinTxt) spinTxt.textContent = '重連中...';
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            this.onError?.('串流連線失敗（可能為 CORS 限制）');
          }
          setTimeout(() => this.restart(spinner), 6000);
        }
      });
    } else if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
      this.video.src = this.streamUrl;
      this.video.play().catch(() => {});
      spinner.classList.add('hide');
    } else {
      this.onError?.('此瀏覽器不支援 HLS 播放');
    }

    this.video.addEventListener('waiting', () => spinner.classList.remove('hide'));
    this.video.addEventListener('playing', () => spinner.classList.add('hide'));
  }

  private restart(spinner: HTMLElement) {
    this.destroy();
    this.start(spinner);
  }

  destroy() {
    this.hls?.destroy();
    this.hls = null;
  }
}

export class BrowserRecorder {
  private video: HTMLVideoElement;
  private cam: CamConfig;
  private mimeType: string;
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
    this.mimeType = pickMimeType();
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
      alert('無法擷取影片串流。請確認直播已正常播放（CORS 可能阻擋錄影）。');
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

    this.recorder.onerror = () => {
      console.error('MediaRecorder error');
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
      const id = this.currentId;
      const startDate = new Date(this.segmentStart);

      rec.onstop = async () => {
        const pad = (n: number) => n.toString().padStart(2, '0');
        const name = makeRecordingName(startDate);
        const meta = await finalizeRecording({
          id,
          camId: this.cam.id,
          name: `${name}.webm`,
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
