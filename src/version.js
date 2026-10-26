// Version của bot, đọc từ package.json để log luôn khớp với bản đang chạy
// (panel tự git pull nên rất cần biết đang ở commit/version nào).
import fs from 'node:fs';

/** @type {string} */
let cached = '';

/**
 * @param {URL} [url] đường dẫn package.json (mặc định: ../package.json so với file này)
 * @returns {string}
 */
export function readVersion(url = new URL('../package.json', import.meta.url)) {
  if (cached) return cached;
  try {
    // BOM: Notepad/PowerShell Windows hay ghi kèm, JSON.parse sẽ chết nếu không cắt.
    const raw = fs.readFileSync(url, 'utf8').replace(/^\uFEFF/, '');
    const pkg = JSON.parse(raw);
    const version = String(pkg?.version ?? '').trim();
    cached = version && version !== 'undefined' ? version : '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}

export const VERSION = readVersion();

export const __test__ = {
  /** Xoá cache (chỉ dùng trong test). */
  reset() {
    cached = '';
  },
};
