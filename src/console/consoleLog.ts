import { openSync, readSync, closeSync, statSync, existsSync } from 'node:fs';
import { resolveConsoleLog } from '../config.js';

/**
 * Reads the Dota 2 console log (`…/game/dota/console.log`) incrementally.
 *
 * The log is append-only and grows without bound (tens of MB, hundreds of
 * thousands of lines), so we never read it whole: a BYTE CURSOR marks "the
 * moment" and `consoleErrors` reads only the delta since then. Lines look like
 * `MM/DD HH:MM:SS [Channel] message` (some have no [Channel]); the file is UTF-8
 * with a BOM. Errors stack up over a session, so identical messages are deduped
 * with a count, and multi-line Lua tracebacks are stitched into one entry.
 */

export interface ConsoleCursor {
  /** Byte offset marking "the moment" (end of file when the mark was taken). */
  offset: number;
  /** File size at mark time. */
  size: number;
  /** mtime (ms) at mark time. */
  mtimeMs: number;
  /** Signature: first 64 bytes (hex) — detects rotation/recreation. */
  sig: string;
}

export type LogLevel = 'error' | 'warning' | 'info';

export interface ConsoleEntry {
  level: LogLevel;
  /** Channel in [brackets], or '' if none. */
  channel: string;
  /** First timestamp seen for this (deduped) message, e.g. "05/31 22:58:39". */
  firstTs: string;
  lastTs: string;
  /** The (collapsed) message; tracebacks keep their newlines. */
  message: string;
  /** How many times this exact message repeated in the delta. */
  count: number;
}

const HEAD_BYTES = 64;
const LINE_RE = /^(\d{2}\/\d{2} \d{2}:\d{2}:\d{2})\s+(?:\[([^\]]+)\]\s*)?(.*)$/;

// Channels that are pure idle/engine noise — excluded from error/warning scans.
const NOISE_CHANNELS = new Set([
  'GCClient', 'SteamNetSockets', 'RenderSystem', 'SignonState', 'Steam Voice',
]);

// Substrings that mark a line as an error (case-insensitive).
const ERROR_PATTERNS = [
  'script error', '[vscript]', 'stack traceback', 'lua error',
  'attempt to call', 'attempt to index', 'attempt to perform',
  'cannot find', 'could not find', 'failed to load', 'failed loading',
  'error creating', 'error loading', 'parse error', 'assert', 'assertion',
  'exception', 'fatal', 'access violation', 'not found', 'missing',
  'invalid', 'failed to open', 'error_fileopen',
];
const WARNING_PATTERNS = ['warning', 'deprecat', 'unable to'];

// A continuation line of a Lua traceback (no leading timestamp).
const TRACEBACK_CONT_RE = /^\s+/;

function classify(channel: string, msg: string): LogLevel | null {
  const lc = msg.toLowerCase();
  // Explicit error wins even on a noisy channel; otherwise skip noise channels.
  const isErr = ERROR_PATTERNS.some((p) => lc.includes(p)) || /\berror\b/.test(lc);
  if (isErr) return 'error';
  if (NOISE_CHANNELS.has(channel)) return null;
  if (WARNING_PATTERNS.some((p) => lc.includes(p))) return 'warning';
  return 'info';
}

/** Reads bytes `[start, start+len)` of a file via a single fd. */
function readBytes(path: string, start: number, len: number): Buffer {
  if (len <= 0) return Buffer.alloc(0);
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, start);
    return n === len ? buf : buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

function fileSig(path: string): string {
  try {
    return readBytes(path, 0, HEAD_BYTES).toString('hex');
  } catch {
    return '';
  }
}

export interface MarkResult extends ConsoleCursor {
  exists: boolean;
  path: string;
}

/**
 * Captures a cursor at the current end of the log — call this at the start of a
 * task to define "the moment". `consoleErrors({ since })` then reports only what
 * the game logs afterwards.
 */
export function consoleMark(): MarkResult {
  const path = resolveConsoleLog();
  if (!existsSync(path)) {
    return { path, exists: false, offset: 0, size: 0, mtimeMs: 0, sig: '' };
  }
  const st = statSync(path);
  return {
    path,
    exists: true,
    offset: st.size,
    size: st.size,
    mtimeMs: st.mtimeMs,
    sig: fileSig(path),
  };
}

export interface ConsoleErrorsResult {
  path: string;
  exists: boolean;
  /** True if the file was rotated/recreated since the cursor (we reread from 0). */
  rotated: boolean;
  /** Bytes scanned in this call. */
  bytesScanned: number;
  /** Cursor to pass as `since` next time (current EOF). */
  newCursor: ConsoleCursor;
  level: LogLevel;
  totalMatched: number;
  returned: number;
  entries: ConsoleEntry[];
  note?: string;
}

export interface ConsoleErrorsOptions {
  /** Cursor from consoleMark (or a previous call's newCursor). Omit = whole file. */
  since?: ConsoleCursor;
  /** Minimum severity to include. Default 'error'. */
  level?: LogLevel;
  /** Collapse identical messages with a count. Default true. */
  dedupe?: boolean;
  /** Max entries returned. Default 100. */
  limit?: number;
  /** Hard cap on bytes read from the delta (tail-most). Default 8 MB. */
  maxBytes?: number;
}

/**
 * Reads new log lines since `since.offset` and returns classified entries at or
 * above `level`. Multi-line Lua tracebacks are stitched onto their error line.
 * Identical messages are deduped with a count (unless dedupe=false). Handles
 * rotation: if the file shrank or its signature changed, rereads from offset 0.
 */
export function consoleErrors(opts: ConsoleErrorsOptions = {}): ConsoleErrorsResult {
  const level = opts.level ?? 'error';
  const dedupe = opts.dedupe ?? true;
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const maxBytes = Math.min(Math.max(opts.maxBytes ?? 8 << 20, 64 << 10), 64 << 20);
  const path = resolveConsoleLog();

  if (!existsSync(path)) {
    return {
      path, exists: false, rotated: false, bytesScanned: 0,
      newCursor: { offset: 0, size: 0, mtimeMs: 0, sig: '' },
      level, totalMatched: 0, returned: 0, entries: [],
      note: 'console.log not found (launch Dota with -condebug to create it).',
    };
  }

  const st = statSync(path);
  const size = st.size;
  let start = opts.since?.offset ?? 0;
  let rotated = false;

  // Rotation/recreation detection: file shrank, or its head signature changed.
  if (opts.since) {
    if (size < opts.since.offset) {
      rotated = true;
      start = 0;
    } else if (opts.since.sig && opts.since.sig !== fileSig(path)) {
      rotated = true;
      start = 0;
    }
  }

  // Cap the delta to the tail-most maxBytes so a huge backlog can't blow memory.
  let note: string | undefined;
  if (size - start > maxBytes) {
    start = size - maxBytes;
    note = `Delta exceeded maxBytes; scanned only the last ${(maxBytes / 1e6).toFixed(0)} MB.`;
  }

  const buf = readBytes(path, start, size - start);
  let text = buf.toString('utf8');
  if (start === 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  // Drop a possibly-partial first line when starting mid-file.
  const lines = text.split(/\r?\n/);
  if (start > 0 && lines.length) lines.shift();

  const order: string[] = [];
  const byKey = new Map<string, ConsoleEntry>();
  let totalMatched = 0;
  const wantWarn = level === 'warning' || level === 'info';
  const wantInfo = level === 'info';

  let current: { level: LogLevel; channel: string; ts: string; lines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const message = current.lines.join('\n').replace(/\s+$/, '');
    const key = dedupe ? `${current.channel}|${message}` : `${order.length}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count++;
      existing.lastTs = current.ts;
    } else {
      const entry: ConsoleEntry = {
        level: current.level, channel: current.channel,
        firstTs: current.ts, lastTs: current.ts, message, count: 1,
      };
      byKey.set(key, entry);
      order.push(key);
    }
    totalMatched++;
    current = null;
  };

  for (const raw of lines) {
    if (!raw) continue;
    const m = LINE_RE.exec(raw);
    if (!m) {
      // Continuation line (e.g. Lua traceback frame): attach to the open entry.
      if (current && TRACEBACK_CONT_RE.test(raw)) current.lines.push(raw.replace(/\s+$/, ''));
      continue;
    }
    const [, ts, channelRaw, msg] = m;
    const channel = channelRaw ?? '';
    const lvl = classify(channel, msg ?? '');
    flush(); // close any open entry before starting a new timestamped line

    const include =
      lvl === 'error' || (lvl === 'warning' && wantWarn) || (lvl === 'info' && wantInfo);
    if (include && lvl) {
      current = { level: lvl, channel, ts: ts!, lines: [msg ?? ''] };
    }
  }
  flush();

  const entries = order.map((k) => byKey.get(k)!).slice(0, limit);
  return {
    path,
    exists: true,
    rotated,
    bytesScanned: buf.length,
    newCursor: { offset: size, size, mtimeMs: st.mtimeMs, sig: fileSig(path) },
    level,
    totalMatched,
    returned: entries.length,
    entries,
    note,
  };
}

export interface ConsoleTailResult {
  path: string;
  exists: boolean;
  lines: string[];
  note?: string;
}

/** Returns the last `lines` raw lines of the log (no filtering). */
export function consoleTail(lines = 50): ConsoleTailResult {
  const path = resolveConsoleLog();
  if (!existsSync(path)) return { path, exists: false, lines: [], note: 'console.log not found.' };
  const n = Math.min(Math.max(lines, 1), 2000);
  const st = statSync(path);
  const want = Math.min(st.size, 2 << 20); // read at most last 2 MB
  const buf = readBytes(path, st.size - want, want);
  let text = buf.toString('utf8');
  const all = text.split(/\r?\n/).filter((l) => l.length > 0);
  return { path, exists: true, lines: all.slice(-n) };
}
