export function pickRecordingFormat(): { mimeType: string; ext: string } {
  const candidates = [
    { mimeType: 'video/mp4', ext: 'mp4' },
    { mimeType: 'video/mp4;codecs=avc1,mp4a', ext: 'mp4' },
    { mimeType: 'video/mp4;codecs=h264,aac', ext: 'mp4' },
    { mimeType: 'video/webm;codecs=vp9,opus', ext: 'webm' },
    { mimeType: 'video/webm;codecs=vp8,opus', ext: 'webm' },
    { mimeType: 'video/webm', ext: 'webm' },
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c.mimeType)) return c;
  }
  return { mimeType: 'video/webm', ext: 'webm' };
}

export function isMp4Mime(mime: string): boolean {
  return mime.toLowerCase().includes('mp4');
}
