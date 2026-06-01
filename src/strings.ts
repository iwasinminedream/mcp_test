/**
 * Extracts printable ASCII runs from a binary buffer (like the Unix `strings`
 * tool). Source 2 compiled resources store asset paths and attachment names as
 * plain ASCII, so a strings scan recovers them without parsing binary KV3/NTRO.
 */
export function extractStrings(buf: Buffer, min = 4): string[] {
  const out: string[] = [];
  let start = -1;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]!;
    if (c >= 0x20 && c < 0x7f) {
      if (start === -1) start = i;
    } else {
      if (start !== -1 && i - start >= min) out.push(buf.toString('latin1', start, i));
      start = -1;
    }
  }
  if (start !== -1 && buf.length - start >= min) {
    out.push(buf.toString('latin1', start, buf.length));
  }
  return out;
}

/** Source 2 asset extensions we recognize inside reference strings. */
const REF_EXT =
  /(?:vmat|vmdl|vmesh|vtex|vpcf|vsnd|vsndevts|vphys|vanim|vagrp|vseq|vmorf|vsmart|vpost|vsurf|vmap)(?:_c)?/
    .source;

const REF_RE = new RegExp(`[\\w./\\-]+\\.${REF_EXT}\\b`, 'gi');
const ATTACH_RE = /^attach_[a-z0-9_]+$/i;

/**
 * Finds attachment-point names (attach_*) among a list of strings, deduped and
 * sorted. These are the names you bind particles to (PATTACH_POINT_FOLLOW).
 */
export function findAttachments(strings: string[]): string[] {
  const set = new Set<string>();
  for (const s of strings) if (ATTACH_RE.test(s)) set.add(s.toLowerCase());
  return [...set].sort();
}

/**
 * Finds referenced Source 2 asset paths inside a list of strings (e.g. materials
 * and sub-models a model uses). Normalizes slashes and dedupes. Used only as a
 * fallback when the CLI (and its clean RERL block) is unavailable.
 */
export function findAssetRefs(strings: string[]): string[] {
  const set = new Set<string>();
  for (const s of strings) {
    for (const m of s.matchAll(REF_RE)) {
      const path = m[0]!.replace(/\\/g, '/').replace(/^\/+/, '');
      if (path.includes('/') && !path.startsWith('.')) set.add(path);
    }
  }
  return [...set].sort();
}

/** Parses resource names from a Source2Viewer-CLI RERL block dump. */
export function parseRerlNames(rerlText: string): string[] {
  const set = new Set<string>();
  for (const m of rerlText.matchAll(/m_pResourceName\s*=\s*"([^"]+)"/g)) {
    const v = m[1]!.trim();
    if (v) set.add(v.replace(/\\/g, '/'));
  }
  return [...set].sort();
}

/** Extracts `resource:"..."` / `resource_name:"..."` refs from decompiled KV3 text. */
export function findKv3ResourceRefs(text: string): string[] {
  const set = new Set<string>();
  for (const m of text.matchAll(/resource(?:_name)?:"([^"]+)"/g)) {
    const v = m[1]!.trim();
    if (v) set.add(v.replace(/\\/g, '/'));
  }
  return [...set].sort();
}

/**
 * Extracts attachment-point names (attach_*) from any text dump (e.g. the model's
 * `-a` all-blocks output). Matches the token wherever it appears, lowercased,
 * deduped, sorted.
 */
export function findAttachmentsInText(text: string): string[] {
  const set = new Set<string>();
  for (const m of text.matchAll(/attach_[a-z0-9_]+/gi)) set.add(m[0].toLowerCase());
  return [...set].sort();
}
