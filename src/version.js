// Bot version, read from package.json so logs always match the running build
// (panels git pull on their own, so knowing the commit/version matters a lot).
import fs from 'node:fs';

/** @type {string} */
let cached = '';

/**
 * @param {URL} [url] path to package.json (default: ../package.json relative to this file)
 * @returns {string}
 */
export function readVersion(url = new URL('../package.json', import.meta.url)) {
  if (cached) return cached;
  try {
    // BOM: Notepad/PowerShell on Windows often writes one, and JSON.parse dies if it is not stripped.
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
  /** Clear the cache (test use only). */
  reset() {
    cached = '';
  },
};
