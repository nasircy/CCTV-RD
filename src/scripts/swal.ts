import Swal from 'sweetalert2';
import 'sweetalert2/dist/sweetalert2.min.css';

export const NySwal = Swal.mixin({
  background: '#111111',
  color: '#dddddd',
  confirmButtonColor: '#c8960c',
  cancelButtonColor: '#2a2a2a',
  customClass: {
    popup: 'ny-swal',
    title: 'ny-swal-title',
    htmlContainer: 'ny-swal-body',
    confirmButton: 'ny-swal-confirm',
    cancelButton: 'ny-swal-cancel',
    closeButton: 'ny-swal-close',
  },
});

export async function confirmDelete(label: string): Promise<boolean> {
  const r = await NySwal.fire({
    title: '刪除錄影',
    text: `確定刪除「${label}」？此操作無法復原。`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: '刪除',
    cancelButtonText: '取消',
    reverseButtons: true,
  });
  return r.isConfirmed;
}

export function showError(title: string, text?: string) {
  return NySwal.fire({
    title,
    text,
    icon: 'error',
    confirmButtonText: '知道了',
  });
}

export function showInfo(title: string, text?: string) {
  return NySwal.fire({
    title,
    text,
    icon: 'info',
    confirmButtonText: '知道了',
  });
}

export async function showPlayer(title: string, blob: Blob): Promise<void> {
  const url = URL.createObjectURL(blob);
  await NySwal.fire({
    title,
    html: `<video src="${url}" controls autoplay playsinline class="swal-video"></video>`,
    width: 920,
    showConfirmButton: false,
    showCloseButton: true,
    didDestroy: () => URL.revokeObjectURL(url),
  });
}

export async function withProgress<T>(
  title: string,
  task: (update: (msg: string) => void) => Promise<T>,
): Promise<T> {
  NySwal.fire({
    title,
    html: '<p class="swal-prog" id="swal-prog">準備中…</p>',
    allowOutsideClick: false,
    showConfirmButton: false,
    didOpen: () => Swal.showLoading(),
  });
  const update = (msg: string) => {
    const el = document.getElementById('swal-prog');
    if (el) el.textContent = msg;
  };
  try {
    const result = await task(update);
    Swal.close();
    return result;
  } catch (err) {
    Swal.close();
    throw err;
  }
}
