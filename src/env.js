// Nạp file .env ngay trong code — không phụ thuộc cờ `--env-file-if-exists` của Node.
//
// Vì sao cần: nhiều hosting panel (Pterodactyl/Wispbyte, pm2, systemd, Docker CMD…)
// tự chạy `node index.js` hoặc `node src/index.js` mà bỏ mất cờ env-file, nên bot
// chết với "fatal: Thiếu ZALO_BOT_TOKEN" dù .env nằm ngay đó. Nạp trong code thì
// chạy kiểu gì cũng có config.
//
// Nguyên tắc: biến đã có sẵn trong process.env (panel/CI/terminal) LUÔN thắng file,
// trừ khi nó rỗng — panel hay khai báo sẵn `ZALO_BOT_TOKEN=` rỗng, khi đó .env được
// quyền điền vào.

import fs from 'node:fs';
import path from 'node:path';

/** File được thử nạp, theo thứ tự ưu tiên (file trước thắng). */
export const DEFAULT_ENV_FILES = ['.env', '.env.local'];

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** @typedef {{ name: string, path: string, found: boolean, applied: string[], kept: string[], error?: string }} EnvFileReport */
/** @typedef {{ cwd: string, files: EnvFileReport[], applied: string[], missing: string[] }} EnvReport */

/** @type {EnvReport|null} */
let lastReport = null;

/**
 * Bỏ quote + comment cuối dòng của 1 giá trị.
 * @param {string} raw
 */
function normalizeValue(raw) {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && last === first) {
      const inner = value.slice(1, -1);
      if (first === "'") return inner;
      // Chỉ giải escape cơ bản cho "..."; \n trong .env hay dùng cho PEM.
      return inner.replace(/\\([nrt"\\])/g, (_, ch) =>
        ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch,
      );
    }
  }
  // Giá trị không quote: "abc  # chú thích" → "abc"
  const hash = value.search(/\s#/);
  if (hash >= 0) return value.slice(0, hash).trim();
  return value;
}

/**
 * Parse nội dung file .env thành danh sách [key, value] theo thứ tự xuất hiện.
 * Chấp nhận: BOM, CRLF, dòng trắng, comment, tiền tố `export `, quote đơn/kép.
 * @param {string} text
 * @returns {Array<[string, string]>}
 */
export function parseEnvFile(text) {
  /** @type {Array<[string, string]>} */
  const entries = [];
  const clean = String(text).replace(/^\uFEFF/, '');
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;
    entries.push([key, normalizeValue(body.slice(eq + 1))]);
  }
  return entries;
}

/**
 * Đọc danh sách file .env và gán vào env (không ghi đè biến đã có giá trị).
 * @param {{ cwd?: string, env?: Record<string, string|undefined>, files?: string[] }} [options]
 * @returns {EnvReport}
 */
export function loadEnvFiles(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? /** @type {Record<string, string|undefined>} */ (process.env);
  const files = options.files ?? DEFAULT_ENV_FILES;

  /** @type {EnvFileReport[]} */
  const reports = [];
  /** @type {string[]} */
  const appliedAll = [];

  for (const name of files) {
    const file = path.resolve(cwd, name);
    /** @type {EnvFileReport} */
    const report = { name, path: file, found: false, applied: [], kept: [] };
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
      report.found = true;
    } catch (error) {
      const code = /** @type {any} */ (error)?.code;
      // Không có file là bình thường (panel cấp biến qua UI). Lỗi khác thì giữ lại để báo.
      if (code !== 'ENOENT' && code !== 'EISDIR') {
        report.error = `${code ?? 'ERROR'}: ${/** @type {any} */ (error)?.message ?? error}`;
      }
      reports.push(report);
      continue;
    }

    for (const [key, value] of parseEnvFile(text)) {
      const current = env[key];
      if (current === undefined || current === '') {
        env[key] = value;
        report.applied.push(key);
        appliedAll.push(key);
      } else {
        report.kept.push(key);
      }
    }
    reports.push(report);
  }

  /** @type {EnvReport} */
  const report = {
    cwd,
    files: reports,
    applied: appliedAll,
    missing: reports.filter((item) => !item.found).map((item) => item.name),
  };
  lastReport = report;
  return report;
}

/** @returns {EnvReport|null} Report của lần loadEnvFiles() gần nhất. */
export function getEnvReport() {
  return lastReport;
}

/**
 * Gợi ý sửa lỗi cấu hình: đã tìm .env ở đâu, thấy gì.
 * Dùng khi loadConfig() ném ConfigError để người dùng biết sửa ở đâu.
 * @returns {string[]}
 */
export function describeEnvHints() {
  const report = lastReport;
  if (!report) return [];
  /** @type {string[]} */
  const lines = [`  thư mục làm việc: ${report.cwd}`];
  for (const item of report.files) {
    if (item.found) {
      lines.push(`  ${item.name}: có (${item.applied.length} biến nạp từ file)`);
    } else if (item.error) {
      lines.push(`  ${item.name}: LỖI ĐỌC — ${item.error}`);
    } else {
      lines.push(`  ${item.name}: không tìm thấy`);
    }
  }
  if (report.missing.length) {
    lines.push(
      `  → tạo file .env ngay trong thư mục trên (copy từ .env.example), ` +
        'hoặc khai báo biến môi trường trực tiếp trong panel host',
    );
  }
  if (report.applied.length) {
    lines.push(`  biến nạp từ file: ${report.applied.join(', ')}`);
  }
  return lines;
}

export const __test__ = { normalizeValue };
