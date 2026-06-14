import { HlsPlayer, BrowserRecorder, type CamConfig } from './recorder';
import {
  cleanupOldRecordings,
  deleteRecording,
  exportRecording,
  formatSize,
  getStorageEstimate,
  listRecordings,
  getRecordingBlob,
  RETENTION_DAYS,
  type RecordingMeta,
} from './storage';

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
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

function updateClock() {
  const t = new Date().toLocaleTimeString('zh-TW', { hour12: false });
  const clock = document.getElementById('clock');
  const liveTs = document.getElementById('live-ts');
  if (clock) clock.textContent = t;
  if (liveTs) liveTs.textContent = t;
}

function updateRecUI(active: boolean, remaining: number) {
  const recBtn = document.getElementById('rec-btn') as HTMLButtonElement;
  const recTimer = document.getElementById('rec-timer');
  const recStat = document.getElementById('rec-status');
  const recInd = document.getElementById('rec-ind');
  const badge = document.getElementById('rec-badge');

  if (active && remaining > 0) {
    recBtn.textContent = '⏹ 停止錄影';
    recBtn.className = 'rec-btn active';
    recBtn.disabled = false;
    if (recStat) {
      recStat.textContent = '● 錄影中';
      recStat.className = 'rec-status on';
    }
    recInd?.classList.add('show');
    if (badge) {
      badge.textContent = 'REC';
      badge.className = 'badge-live';
    }
    if (recTimer) {
      recTimer.textContent = fmtRemain(remaining);
      recTimer.className = 'rec-timer' + (remaining < 300 ? ' warning' : '');
    }
  } else {
    recBtn.textContent = '⏺ 開始錄影';
    recBtn.className = 'rec-btn idle';
    recBtn.disabled = false;
    if (recTimer) {
      recTimer.textContent = '';
      recTimer.className = 'rec-timer';
    }
    if (recStat) {
      recStat.textContent = '● 待機';
      recStat.className = 'rec-status off';
    }
    recInd?.classList.remove('show');
    if (badge) {
      badge.textContent = 'LIVE';
      badge.className = 'badge-live off';
    }
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
    el.innerHTML = '<div class="dvr-empty">尚無錄影<br><span style="font-size:11px;color:var(--ny-dim)">點「開始錄影」即可在瀏覽器本地儲存</span></div>';
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  el.innerHTML = dates
    .map(
      (d) => `
    <div class="d-item ${d === selDate ? 'on' : ''}" data-d="${d}">
      <span class="d-date">${d === today ? '📅 今天' : d}</span>
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
    el.innerHTML = '<div class="dvr-empty">這天沒有錄影</div>';
    return;
  }

  el.innerHTML =
    `<div class="f-grp-label">共 ${files.length} 段 · WebM 格式</div>` +
    files
      .map(
        (f) => `
      <div class="f-item" data-id="${f.id}">
        <span class="f-time">${f.time}</span>
        <span class="f-sz">${formatSize(f.size)}</span>
        <span class="f-act">
          <button data-act="play" title="播放">▶</button>
          <button data-act="dl" title="下載">↓</button>
          <button data-act="del" title="刪除">✕</button>
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
      const meta = files.find((f) => f.id === id);
      if (meta) exportRecording(id, meta.name);
    });
    item.querySelector('[data-act="del"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('確定刪除此錄影？')) return;
      await deleteRecording(id);
      await refreshRecordings();
    });
    item.addEventListener('click', () => openPlay(id));
  });
}

function updateStats() {
  const today = new Date().toISOString().slice(0, 10);
  const td = recordings.filter((f) => f.date === today);
  const totalEl = document.getElementById('st-total');
  const todayEl = document.getElementById('st-today');
  const retEl = document.getElementById('st-ret');
  if (totalEl) totalEl.textContent = String(recordings.length);
  if (todayEl) todayEl.textContent = String(td.length);
  if (retEl) retEl.textContent = `${RETENTION_DAYS}天`;
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
  const modal = document.getElementById('modal');
  const pb = document.getElementById('pb') as HTMLVideoElement;
  const ttl = document.getElementById('modal-ttl');
  const meta = recordings.find((r) => r.id === id);
  if (!modal || !pb) return;

  if (ttl) ttl.textContent = meta ? `📹 ${meta.name}` : '播放錄影';
  const blob = await getRecordingBlob(id);
  if (!blob) {
    alert('無法讀取錄影資料');
    return;
  }
  pb.src = URL.createObjectURL(blob);
  pb.load();
  pb.play().catch(() => {});
  modal.classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closePlay() {
  const modal = document.getElementById('modal');
  const pb = document.getElementById('pb') as HTMLVideoElement;
  if (modal) modal.classList.remove('show');
  if (pb) {
    pb.pause();
    if (pb.src.startsWith('blob:')) URL.revokeObjectURL(pb.src);
    pb.src = '';
  }
  document.body.style.overflow = '';
}

function hideSplash() {
  const splash = document.getElementById('splash');
  splash?.classList.add('hide');
  setTimeout(() => splash?.remove(), 900);
}

async function init() {
  document.getElementById('cam-name')!.textContent = CAM.name;
  document.getElementById('cam-id-label')!.textContent = `CAM: ${CAM.id}`;
  document.getElementById('dvr-cam-label')!.textContent =
    `${CAM.name} · ${CAM.id}`;

  setInterval(updateClock, 1000);
  updateClock();

  setTimeout(hideSplash, 2600);

  if (navigator.storage?.persist) {
    navigator.storage.persist().catch(() => {});
  }

  const video = document.getElementById('live-video') as HTMLVideoElement;
  const spinner = document.getElementById('player-spin')!;
  const corsWarn = document.getElementById('cors-warn');

  player = new HlsPlayer(video, CAM.streamUrl);
  player.setOnError((msg) => corsWarn?.classList.add('show'));
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
      if (!ok) recBtn.disabled = false;
    }
  });

  document.getElementById('modal-close')?.addEventListener('click', closePlay);
  document.getElementById('modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closePlay();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePlay();
  });

  await cleanupOldRecordings();
  await refreshRecordings();
  setInterval(refreshRecordings, 120000);
  setInterval(refreshStorage, 60000);
}

init().catch(console.error);
