import { HlsPlayer, BrowserRecorder, type CamConfig } from './recorder';
import {
  deleteRecording,
  exportRecording,
  formatSize,
  getStorageEstimate,
  listRecordings,
  getRecordingBlob,
  type RecordingMeta,
} from './storage';
import { confirmDelete, showError, showPlayer, withProgress } from './swal';

const CAM: CamConfig = {
  id: 'yang-cam',
  name: '羊家門前',
  streamUrl: 'https://cctvatis3.ntpc.gov.tw/hls/C000024/live.m3u8',
};

let recordings: RecordingMeta[] = [];
let selDate: string | null = null;
let player: HlsPlayer | null = null;
let recorder: BrowserRecorder | null = null;

let zoom = 1;
let panX = 0;
let panY = 0;
let dragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragPanX = 0;
let dragPanY = 0;

function fmtRemain(sec: number): string {
  if (sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function updateClock() {
  const t = new Date().toLocaleTimeString('zh-TW', { hour12: false });
  document.getElementById('clock')!.textContent = t;
  document.getElementById('live-ts')!.textContent = t;
}

function setSignal(online: boolean) {
  const dot = document.getElementById('sig-dot');
  const txt = document.getElementById('sig-txt');
  dot?.classList.toggle('on', online);
  dot?.classList.toggle('off', !online);
  if (txt) txt.textContent = online ? 'ONLINE' : 'RECONNECT';
}

function applyTransform() {
  const stage = document.getElementById('video-stage');
  const lbl = document.getElementById('zoom-lvl');
  if (stage) {
    stage.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  }
  if (lbl) lbl.textContent = `${zoom.toFixed(1)}×`;
  document.getElementById('viewport')?.classList.toggle('can-pan', zoom > 1);
}

function setZoom(level: number) {
  zoom = level;
  if (zoom <= 1) {
    panX = 0;
    panY = 0;
  }
  document.querySelectorAll('[data-zoom]').forEach((btn) => {
    btn.classList.toggle('on', parseFloat((btn as HTMLElement).dataset.zoom!) === level);
  });
  applyTransform();
}

function resetView() {
  setZoom(1);
}

function initViewport() {
  const viewport = document.getElementById('viewport');
  if (!viewport) return;

  document.querySelectorAll('[data-zoom]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setZoom(parseFloat((btn as HTMLElement).dataset.zoom!));
    });
  });

  document.getElementById('btn-fit')?.addEventListener('click', resetView);

  document.getElementById('btn-fs')?.addEventListener('click', async () => {
    const bezel = document.getElementById('bezel');
    if (!bezel) return;
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await bezel.requestFullscreen().catch(() => {});
    }
  });

  viewport.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.25 : 0.25;
      const next = Math.min(4, Math.max(1, Math.round((zoom + delta) * 4) / 4));
      setZoom(next);
    },
    { passive: false },
  );

  viewport.addEventListener('mousedown', (e) => {
    if (zoom <= 1) return;
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragPanX = panX;
    dragPanY = panY;
    viewport.classList.add('dragging');
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    panX = dragPanX + (e.clientX - dragStartX);
    panY = dragPanY + (e.clientY - dragStartY);
    applyTransform();
  });

  window.addEventListener('mouseup', () => {
    dragging = false;
    viewport.classList.remove('dragging');
  });

  viewport.addEventListener('dblclick', () => {
    if (zoom > 1) resetView();
    else setZoom(2);
  });
}

function updateRecUI(active: boolean, remaining: number) {
  const recBtn = document.getElementById('rec-btn') as HTMLButtonElement;
  const recTimer = document.getElementById('rec-timer');
  const recStat = document.getElementById('rec-status');
  const osdRec = document.getElementById('osd-rec');
  const hdrDot = document.getElementById('hdr-rec-dot');

  if (active && remaining > 0) {
    recBtn.textContent = '■ STOP';
    recBtn.className = 'btn-rec active';
    recBtn.disabled = false;
    if (recStat) {
      recStat.textContent = 'REC · 錄影中';
      recStat.className = 'rec-hint on';
    }
    osdRec?.classList.add('show');
    hdrDot?.classList.add('show');
    if (recTimer) {
      recTimer.textContent = fmtRemain(remaining);
      recTimer.className = 'rec-time' + (remaining < 300 ? ' warn' : '');
    }
  } else {
    recBtn.textContent = '● REC 開始';
    recBtn.className = 'btn-rec';
    recBtn.disabled = false;
    if (recTimer) {
      recTimer.textContent = '';
      recTimer.className = 'rec-time';
    }
    if (recStat) {
      recStat.textContent = 'STBY · 待機';
      recStat.className = 'rec-hint';
    }
    osdRec?.classList.remove('show');
    hdrDot?.classList.remove('show');
  }
}

function getGroups(): Record<string, RecordingMeta[]> {
  const g: Record<string, RecordingMeta[]> = {};
  for (const f of recordings) {
    if (!g[f.date]) g[f.date] = [];
    g[f.date].push(f);
  }
  return g;
}

function renderDates() {
  const g = getGroups();
  const dates = Object.keys(g).sort((a, b) => b.localeCompare(a));
  const el = document.getElementById('date-list');
  if (!el) return;

  if (!dates.length) {
    el.innerHTML = '<div class="empty">NO DATA</div>';
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  el.innerHTML = dates
    .map(
      (d) => `
    <div class="d-item ${d === selDate ? 'on' : ''}" data-d="${d}">
      <span>${d === today ? 'TODAY' : d}</span>
      <span class="d-cnt">${g[d].length}</span>
    </div>`,
    )
    .join('');

  el.querySelectorAll('.d-item').forEach((item) => {
    item.addEventListener('click', () => {
      selDate = (item as HTMLElement).dataset.d ?? null;
      renderDates();
      renderFiles(selDate ? g[selDate] : []);
    });
  });

  if (!selDate && dates.length) {
    selDate = dates[0];
    renderDates();
    renderFiles(g[selDate]);
  }
}

function renderFiles(files: RecordingMeta[]) {
  const el = document.getElementById('dvr-files');
  if (!el) return;

  if (!files?.length) {
    el.innerHTML = '<div class="empty">NO CLIPS</div>';
    return;
  }

  el.innerHTML =
    `<div class="f-grp">${files.length} CLIPS · MP4 EXPORT</div>` +
    files
      .map(
        (f) => `
      <div class="f-item" data-id="${f.id}">
        <span class="f-time">${f.time}</span>
        <span class="f-sz">${formatSize(f.size)}</span>
        <span class="f-act">
          <button data-act="play">PLAY</button>
          <button data-act="dl">MP4</button>
          <button data-act="del">DEL</button>
        </span>
      </div>`,
      )
      .join('');

  el.querySelectorAll('.f-item').forEach((item) => {
    const id = (item as HTMLElement).dataset.id!;
    item.querySelector('[data-act="play"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openPlay(id);
    });
    item.querySelector('[data-act="dl"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadMp4(id);
    });
    item.querySelector('[data-act="del"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      removeRecording(id);
    });
    item.addEventListener('click', () => openPlay(id));
  });
}

async function removeRecording(id: string) {
  const meta = recordings.find((r) => r.id === id);
  const ok = await confirmDelete(meta?.time ?? '此錄影');
  if (!ok) return;
  await deleteRecording(id);
  await refreshRecordings();
}

async function downloadMp4(id: string) {
  try {
    await withProgress('匯出 MP4', (update) => exportRecording(id, update));
  } catch {
    showError('轉檔失敗', '檔案可能過大或瀏覽器記憶體不足。');
  }
}

function updateStats() {
  const today = new Date().toISOString().slice(0, 10);
  const td = recordings.filter((f) => f.date === today);
  document.getElementById('st-total')!.textContent = String(recordings.length);
  document.getElementById('st-today')!.textContent = String(td.length);
}

async function refreshStorage() {
  const est = await getStorageEstimate();
  const valEl = document.getElementById('stor-val');
  const fillEl = document.getElementById('stor-fill');
  if (est.quota > 0) {
    const usedGB = (est.used / 1073741824).toFixed(2);
    const quotaGB = (est.quota / 1073741824).toFixed(1);
    if (valEl) valEl.textContent = `${usedGB}/${quotaGB}G`;
    if (fillEl) fillEl.style.width = `${Math.min(est.percent, 100)}%`;
  } else if (valEl) {
    valEl.textContent = formatSize(est.used);
  }
}

async function refreshRecordings() {
  recordings = await listRecordings(CAM.id);
  renderDates();
  updateStats();
  await refreshStorage();
}

async function openPlay(id: string) {
  const meta = recordings.find((r) => r.id === id);
  const blob = await getRecordingBlob(id);
  if (!blob) {
    showError('無法讀取錄影');
    return;
  }
  await showPlayer(meta?.time ?? 'PLAYBACK', blob);
}

function hideSplash() {
  document.getElementById('splash')?.classList.add('hide');
}

async function init() {
  setInterval(updateClock, 1000);
  updateClock();
  setTimeout(hideSplash, 2000);

  initViewport();
  applyTransform();

  if (navigator.storage?.persist) {
    navigator.storage.persist().catch(() => {});
  }

  const video = document.getElementById('live-video') as HTMLVideoElement;
  const spinner = document.getElementById('player-spin')!;
  const corsWarn = document.getElementById('cors-warn');

  player = new HlsPlayer(video, CAM.streamUrl);
  player.setOnError(() => corsWarn?.classList.add('show'));
  player.setOnStatus(setSignal);
  player.start(spinner);

  recorder = new BrowserRecorder(video, CAM);
  recorder.setCallbacks(updateRecUI, () => refreshRecordings());

  const recBtn = document.getElementById('rec-btn') as HTMLButtonElement;
  recBtn.addEventListener('click', async () => {
    recBtn.disabled = true;
    if (recorder!.isRecording) {
      await recorder!.stop();
    } else {
      const ok = await recorder!.start(48);
      if (!ok) {
        recBtn.disabled = false;
        showError('無法開始錄影', '請確認直播已正常播放。');
      }
    }
  });

  await refreshRecordings();
  setInterval(refreshRecordings, 120000);
  setInterval(refreshStorage, 60000);
}

init().catch(console.error);
