import { appendFileSync, mkdirSync, existsSync, statSync, renameSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { packageRoot } from './config.js';

/**
 * Persistent, append-only activity log for the server. Every tool call is
 * recorded as one JSON line (JSONL): tool name, (truncated) args, duration,
 * ok/error, and isError flag. This is what you grep after the fact to see
 * whether the server errored or returned something wrong during a session.
 *
 * Location: LOG_FILE env, else `<package root>\logs\dota2-mcp.log` (project-local
 * and easy to find/inspect). Rotated when it exceeds ~5 MB (one `.1` backup
 * kept). Logging never throws — a logging failure must not break a tool call.
 * Disable entirely with LOG=0.
 */

const ENABLED = process.env.LOG !== '0';
const MAX_BYTES = (() => {
  const v = Number(process.env.LOG_MAX_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 5 << 20;
})();

export function logFilePath(): string {
  return process.env.LOG_FILE?.trim() || join(packageRoot(), 'logs', 'dota2-mcp.log');
}

let ensured = false;
function ensureDir(): void {
  if (ensured) return;
  try {
    mkdirSync(dirname(logFilePath()), { recursive: true });
  } catch {
    /* ignore */
  }
  ensured = true;
}

function rotateIfNeeded(file: string): void {
  try {
    if (!existsSync(file)) return;
    if (statSync(file).size < MAX_BYTES) return;
    const bak = file + '.1';
    try {
      if (existsSync(bak)) renameSync(bak, bak + '.tmp'); // best-effort; will be overwritten
    } catch {
      /* ignore */
    }
    renameSync(file, bak);
  } catch {
    /* ignore */
  }
}

/** Truncates a value to a short JSON-safe preview for the log. */
function preview(v: unknown, max = 600): unknown {
  if (v === undefined) return undefined;
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    return '[unserializable]';
  }
  if (s.length <= max) return v;
  return { _truncated: true, preview: s.slice(0, max) + '…', length: s.length };
}

export interface LogRecord {
  ts: string;
  level: 'info' | 'error';
  event: string;
  tool?: string;
  ms?: number;
  isError?: boolean;
  args?: unknown;
  error?: string;
  [k: string]: unknown;
}

let monotonic = 0;

/** Writes one record. Best-effort; never throws. The caller passes a wall clock
 * timestamp (Date is unavailable in some sandboxes for the harness, but the
 * server process itself has a real clock). */
export function writeLog(rec: Omit<LogRecord, 'ts'> & { ts?: string }): void {
  if (!ENABLED) return;
  ensureDir();
  const file = logFilePath();
  rotateIfNeeded(file);
  const full: LogRecord = {
    ...rec,
    ts: rec.ts ?? new Date().toISOString(),
    seq: ++monotonic,
  } as unknown as LogRecord;
  if (full.args !== undefined) full.args = preview(full.args);
  try {
    appendFileSync(file, JSON.stringify(full) + '\n');
  } catch {
    /* logging must never break the server */
  }
}

/** Logs the start/end of a tool call; returns the elapsed ms. */
export function logToolCall(
  tool: string,
  args: unknown,
  outcome: { ms: number; isError?: boolean; error?: string },
): void {
  writeLog({
    level: outcome.error || outcome.isError ? 'error' : 'info',
    event: 'tool_call',
    tool,
    ms: outcome.ms,
    isError: outcome.isError ?? false,
    error: outcome.error,
    args,
  });
}

export interface ReadLogOptions {
  limit?: number;
  /** Only entries at/above this level. */
  level?: 'info' | 'error';
  /** Substring filter on tool name. */
  tool?: string;
  /** Only entries with isError=true (or thrown error). */
  errorsOnly?: boolean;
}

export interface ReadLogResult {
  path: string;
  exists: boolean;
  totalLines: number;
  returned: number;
  entries: LogRecord[];
  note?: string;
}

/** Reads the tail of the log, newest-first, with optional filters. Reads at most
 * the last ~4 MB so a huge log can't blow memory. */
export function readLog(opts: ReadLogOptions = {}): ReadLogResult {
  const path = logFilePath();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
  if (!existsSync(path)) {
    return { path, exists: false, totalLines: 0, returned: 0, entries: [], note: 'No log yet.' };
  }
  const size = statSync(path).size;
  const want = Math.min(size, 4 << 20);
  let text: string;
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(want);
    readSync(fd, buf, 0, want, size - want);
    text = buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
  if (want < size) {
    const nl = text.indexOf('\n');
    if (nl >= 0) text = text.slice(nl + 1); // drop partial first line
  }

  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const parsed: LogRecord[] = [];
  for (const l of lines) {
    try {
      parsed.push(JSON.parse(l) as LogRecord);
    } catch {
      /* skip malformed */
    }
  }

  let filtered = parsed;
  if (opts.errorsOnly) filtered = filtered.filter((e) => e.isError || e.level === 'error');
  else if (opts.level === 'error') filtered = filtered.filter((e) => e.level === 'error');
  if (opts.tool) filtered = filtered.filter((e) => (e.tool ?? '').includes(opts.tool!));

  const entries = filtered.slice(-limit).reverse(); // newest first
  return {
    path,
    exists: true,
    totalLines: parsed.length,
    returned: entries.length,
    entries,
    note: want < size ? `Showing only the last ${(want / 1e6).toFixed(0)} MB of the log.` : undefined,
  };
}
