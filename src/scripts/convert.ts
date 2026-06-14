const CORE_VER = '0.12.10';
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core-st@${CORE_VER}/dist/esm`;

let ffmpeg: import('@ffmpeg/ffmpeg').FFmpeg | null = null;
let loadPromise: Promise<import('@ffmpeg/ffmpeg').FFmpeg> | null = null;

async function getFfmpeg(): Promise<import('@ffmpeg/ffmpeg').FFmpeg> {
  if (ffmpeg?.loaded) return ffmpeg;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    const { toBlobURL } = await import('@ffmpeg/util');
    const ff = new FFmpeg();
    await ff.load({
      coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    ffmpeg = ff;
    return ff;
  })();

  return loadPromise;
}

export async function convertWebmToMp4(
  blob: Blob,
  onProgress?: (msg: string) => void,
): Promise<Blob> {
  const { fetchFile } = await import('@ffmpeg/util');

  onProgress?.('載入轉檔引擎…');
  const ff = await getFfmpeg();

  onProgress?.('讀取影片…');
  await ff.writeFile('input.webm', await fetchFile(blob));

  onProgress?.('轉檔為 MP4（可能需要數十秒）…');
  await ff.exec([
    '-i', 'input.webm',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    'output.mp4',
  ]);

  onProgress?.('完成封裝…');
  const data = await ff.readFile('output.mp4');
  await ff.deleteFile('input.webm').catch(() => {});
  await ff.deleteFile('output.mp4').catch(() => {});

  return new Blob([data], { type: 'video/mp4' });
}
