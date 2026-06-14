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
  id: 'C000024',
  name: '板橋區四川路、中央路',
  streamUrl: 'https://cctvatis3.ntpc.gov.tw/hls/C000024/live.m3u8',
};

let recordings: RecordingMeta[] = [];
let selDate: string | null = null;
let player: HlsPlayer | null = null;
let recorder: BrowserRecorder | null = null;

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
  if (txt) txt.textContent = online ? '訊號正常' : '重新連線';
}

function updateRecUI(active: boolean, remaining: number) {
  const recBtn = document.getElementById('rec-btn') as HTMLButtonElement;
  const recTimer = document.getElementById('rec-timer');
  const recStat = document.getElementById('rec-status');
  const recInd = document.getElementById('rec-ind');

  if (active && remaining > 0) {
    recBtn.textContent = '停止錄影';
    recBtn.className = 'btn-rec active';
    recBtn.disabled = false;
    if (recStat) {
      recStat.textContent = '錄影進行中';
      recStat.className = 'rec-hint on';
    }
    recInd?.classList.add('show');
    if (recTimer) {
      recTimer.textContent = fmtRemain(remaining);
      recTimer.className = 'rec-time' + (remaining < 300 ? ' warn' : '');
    }
  } else {
    recBtn.textContent = '開始錄影';
    recBtn.className = 'btn-rec';
    recBtn.disabled = false;
    if (recTimer) {
      recTimer.textContent = '';
      recTimer.className = 'rec-time';
    }
    if (recStat) {
      recStat.textContent = '待機';
      recStat.className = 'rec-hint';
    }
    recInd?.classList.remove('show');
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
    el.innerHTML = '<div class="empty">尚無錄影</div>';
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  el.innerHTML = dates
    .map(
      (d) => `
    <div class="d-item ${d === selDate ? 'on' : ''}" data-d="${d}">
      <span>${d === today ? '今天' : d}</span>
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
    el.innerHTML = '<div class="empty">這天沒有錄影</div>';
    return;
  }

  el.innerHTML =
    `<div class="f-grp">${files.length} 段 · 下載為 MP4</div>` +
    files
      .map(
        (f) => `
      <div class="f-item" data-id="${f.id}">
        <span class="f-time">${f.time}</span>
        <span class="f-sz">${formatSize(f.size)}</span>
        <span class="f-act">
          <button data-act="play">播放</button>
          <button data-act="dl">MP4</button>
          <button data-act="del">刪</button>
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
    await withProgress('匯出 MP4', (update) =>
      exportRecording(id, update),
    );
  } catch {
    showError('轉檔失敗', '檔案可能過大或瀏覽器記憶體不足，請稍後再試。');
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
    if (valEl) valEl.textContent = `${usedGB} / ${quotaGB} GB`;
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
  await showPlayer(meta?.name ?? meta?.time ?? '播放', blob);
}

function hideSplash() {
  document.getElementById('splash')?.classList.add('hide');
}

async function init() {
  document.getElementById('cam-name')!.textContent = CAM.name;
  document.getElementById('cam-id-label')!.textContent = CAM.id;
  document.getElementById('dvr-cam-label')!.textContent = `${CAM.name} · ${CAM.id}`;

  setInterval(updateClock, 1000);
  updateClock();
  setTimeout(hideSplash, 2000);

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
        showError('無法開始錄影', '請確認直播已正常播放後再試。');
      }
    }
  });

  await refreshRecordings();
  setInterval(refreshRecordings, 120000);
  setInterval(refreshStorage, 60000);
}

init().catch(console.error);
