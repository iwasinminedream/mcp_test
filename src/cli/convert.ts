import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, readdirSync, readFileSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import { resolveCliPath } from '../config.js';
import { withTempDir } from '../cache.js';

const pExecFile = promisify(execFile);

/** Persistent output root for model exports (not ephemeral — the user keeps these). */
const EXPORT_ROOT = process.env.EXPORT_DIR || join(tmpdir(), 'dota2-mcp', 'exports');

export interface TexturePreview {
  ok: boolean;
  width?: number;
  height?: number;
  previewWidth?: number;
  previewHeight?: number;
  pngBase64?: string;
  note: string;
  error?: string;
}

/** Reads PNG width/height from the IHDR header (bytes 16-23). */
function pngSize(buf: Buffer): { w: number; h: number } {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** Nearest-neighbour downscale of a decoded PNG to fit within maxDim. */
function downscale(src: PNG, maxDim: number): PNG {
  const scale = Math.min(1, maxDim / Math.max(src.width, src.height));
  if (scale >= 1) return src;
  const dw = Math.max(1, Math.round(src.width * scale));
  const dh = Math.max(1, Math.round(src.height * scale));
  const dst = new PNG({ width: dw, height: dh });
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(src.height - 1, Math.floor(y / scale));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(src.width - 1, Math.floor(x / scale));
      const si = (sy * src.width + sx) << 2;
      const di = (y * dw + x) << 2;
      dst.data[di] = src.data[si]!;
      dst.data[di + 1] = src.data[si + 1]!;
      dst.data[di + 2] = src.data[si + 2]!;
      dst.data[di + 3] = src.data[si + 3]!;
    }
  }
  return dst;
}

/**
 * Decompiles a vtex_c texture to PNG via Source2Viewer-CLI, downscales it to fit
 * `maxDim`, and returns a base64 PNG preview plus dimensions. The temp PNG is
 * deleted immediately after reading.
 */
export async function previewTexture(
  bytes: Buffer,
  fileName: string,
  maxDim = 512,
): Promise<TexturePreview> {
  const cli = resolveCliPath();
  if (!cli) {
    return { ok: false, note: 'CLI required for texture preview.', error: 'Source2Viewer-CLI not found (set S2V_CLI or vendor it).' };
  }
  const cap = Math.min(Math.max(32, maxDim), 1024);

  return withTempDir(async (dir) => {
    const base = basename(fileName);
    const inP = join(dir, base);
    writeFileSync(inP, bytes);
    try {
      await pExecFile(cli, ['-i', inP, '-o', dir, '-d'], {
        timeout: 90_000, windowsHide: true, maxBuffer: 64 << 20,
      });
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      return { ok: false, note: 'Texture decompile failed.', error: e.stderr || e.message };
    }
    const png = readdirSync(dir).find((f) => f.toLowerCase().endsWith('.png'));
    if (!png) return { ok: false, note: 'No PNG produced.', error: 'CLI emitted no PNG for this texture.' };

    const full = readFileSync(join(dir, png));
    const { w, h } = pngSize(full);
    const decoded = PNG.sync.read(full);
    const small = downscale(decoded, cap);
    const outBuf = PNG.sync.write(small);
    return {
      ok: true,
      width: w,
      height: h,
      previewWidth: small.width,
      previewHeight: small.height,
      pngBase64: outBuf.toString('base64'),
      note:
        small.width < w
          ? `Downscaled from ${w}x${h} to ${small.width}x${small.height} for preview (raise maxDim up to 1024 for more detail).`
          : `Full resolution ${w}x${h}.`,
    };
  });
}

export interface ModelExport {
  ok: boolean;
  format: string;
  outDir?: string;
  files?: { path: string; bytes: number }[];
  note: string;
  error?: string;
}

/**
 * Exports a vmdl_c model to glTF/GLB via Source2Viewer-CLI into a PERSISTENT
 * export directory (so the user can use the file), returning the output path and
 * file list. Tries with materials first, then without (materials need referenced
 * textures that aren't present when feeding a single extracted _c). The result is
 * intentionally NOT deleted.
 */
export async function exportModel(
  bytes: Buffer,
  assetPath: string,
  opts: { format?: 'glb' | 'gltf'; animations?: boolean; materials?: boolean } = {},
): Promise<ModelExport> {
  const cli = resolveCliPath();
  if (!cli) {
    return { ok: false, format: opts.format ?? 'glb', note: 'CLI required for model export.', error: 'Source2Viewer-CLI not found.' };
  }
  const format = opts.format ?? 'glb';
  const safe = assetPath.replace(/[^a-z0-9._/-]/gi, '_').replace(/\//g, '__').replace(/_c$/, '');
  const outDir = join(EXPORT_ROOT, safe);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const base = basename(assetPath);
  const inP = join(outDir, base);
  writeFileSync(inP, bytes);

  const baseArgs = ['-i', inP, '-o', outDir, '-d', '--gltf_export_format', format];
  if (opts.animations) baseArgs.push('--gltf_export_animations');

  const attempts: string[][] = [];
  if (opts.materials !== false) attempts.push([...baseArgs, '--gltf_export_materials']);
  attempts.push([...baseArgs]);

  let lastErr = '';
  let materialsExported = opts.materials !== false;
  try {
    for (let i = 0; i < attempts.length; i++) {
      try {
        await pExecFile(cli, attempts[i]!, { timeout: 240_000, windowsHide: true, maxBuffer: 128 << 20 });
        lastErr = '';
        materialsExported = i === 0 && opts.materials !== false;
        break;
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        lastErr = e.stderr || e.message || 'unknown error';
      }
    }
  } finally {
    try { rmSync(inP, { force: true }); } catch { /* ignore */ }
  }
  if (lastErr) {
    return { ok: false, format, outDir, note: 'Model export failed (both with and without materials).', error: lastErr };
  }

  const files: { path: string; bytes: number }[] = [];
  const walk = (d: string, rel = ''): void => {
    for (const n of readdirSync(d)) {
      const f = join(d, n);
      const r = rel ? rel + '/' + n : n;
      const st = statSync(f);
      if (st.isDirectory()) walk(f, r);
      else files.push({ path: r, bytes: st.size });
    }
  };
  walk(outDir);

  if (files.length === 0) {
    return { ok: false, format, outDir, note: 'Export produced no files (model type may be unsupported).', error: 'no output' };
  }
  return {
    ok: true,
    format,
    outDir,
    files,
    note:
      `Exported to ${outDir} (persists on disk; not auto-deleted).` +
      (opts.materials !== false && !materialsExported
        ? ' NOTE: materials were skipped (not resolvable from a standalone file); mesh/skeleton exported.'
        : ''),
  };
}
