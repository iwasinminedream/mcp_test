import type { AssetIndex } from '../index/assetIndex.js';
import { decompileToText, cliAvailable } from '../cli/decompiler.js';

export interface DecompileResult {
  path: string;
  source: string;
  totalChars: number;
  offset: number;
  returnedChars: number;
  truncated: boolean;
  text: string;
  error?: string;
  suggestions?: { path: string; score: number }[];
}

const MAX_CHARS = 60_000;

/**
 * Decompiles any supported compiled resource to its KV3 source text, with simple
 * char-offset pagination so large resources don't blow the token budget.
 */
export async function decompileAsset(
  index: AssetIndex,
  path: string,
  offset = 0,
  limit = MAX_CHARS,
): Promise<DecompileResult> {
  const read = index.read(path);
  if (!read) {
    const suggestions = index.resolve(path, { limit: 5 }).results.map((r) => ({
      path: r.path,
      score: r.score,
    }));
    return {
      path, source: '', totalChars: 0, offset, returnedChars: 0, truncated: false, text: '',
      error: `No asset at "${path}".`, suggestions,
    };
  }

  if (!cliAvailable()) {
    return {
      path: read.path, source: read.source, totalChars: 0, offset, returnedChars: 0,
      truncated: false, text: '',
      error:
        'Source2Viewer-CLI not found. Set S2V_CLI or place it under vendor/. ' +
        'For models, use model_info (no CLI needed).',
    };
  }

  let text: string;
  try {
    text = await decompileToText(read.bytes, read.path);
  } catch (err) {
    return {
      path: read.path, source: read.source, totalChars: 0, offset, returnedChars: 0,
      truncated: false, text: '', error: (err as Error).message,
    };
  }

  const cap = Math.min(Math.max(1, limit), MAX_CHARS);
  const start = Math.max(0, offset);
  const slice = text.slice(start, start + cap);
  return {
    path: read.path,
    source: read.source,
    totalChars: text.length,
    offset: start,
    returnedChars: slice.length,
    truncated: start + slice.length < text.length,
    text: slice,
  };
}
