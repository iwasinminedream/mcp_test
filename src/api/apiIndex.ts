import { loadApiData, type ApiSymbol, type ApiDomain, type ApiKind, type ApiData } from './apiData.js';
import { boundedLevenshtein } from '../fuzzy.js';

export interface ApiSearchHit {
  name: string;
  domain: ApiDomain;
  kind: ApiKind;
  className?: string;
  available?: string;
  signature?: string;
  score: number;
}

function signatureOf(s: ApiSymbol): string | undefined {
  if (s.kind !== 'function' && s.kind !== 'method') return undefined;
  const args = (s.args ?? []).map((a) => `${a.name}: ${a.types.join('|') || 'any'}`).join(', ');
  const ret = (s.returns ?? []).join('|') || 'nil';
  return `${s.name}(${args}) -> ${ret}`;
}

const DOMAINS: ApiDomain[] = [
  'lua', 'panorama-js', 'panorama-css', 'panorama-enum', 'panorama-event', 'event', 'engine-enum', 'modifier',
];

export class ApiIndex {
  private data: ApiData;

  constructor() {
    this.data = loadApiData();
  }

  get status() {
    return this.data.status;
  }

  get loaded() {
    return this.data.status.loaded;
  }

  search(
    query: string,
    opts: { domain?: ApiDomain; kind?: ApiKind; limit?: number } = {},
  ): { query: string; total: number; results: ApiSearchHit[] } {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    const q = query.toLowerCase().trim();
    const pool = this.data.symbols.filter(
      (s) => (!opts.domain || s.domain === opts.domain) && (!opts.kind || s.kind === opts.kind),
    );

    const scored: { s: ApiSymbol; score: number }[] = [];
    for (const s of pool) {
      const name = s.name.toLowerCase();
      const member = s.member?.toLowerCase();
      let score = 0;
      if (name === q || member === q) score = 1;
      else if (name.startsWith(q) || member?.startsWith(q)) score = 0.9;
      else if (name.includes(q) || member?.includes(q)) score = 0.75;
      else if (q.length >= 3) {
        const cap = Math.max(2, Math.floor(q.length * 0.4));
        const target = member && member.length < name.length ? member : name;
        const d = boundedLevenshtein(q, target, cap);
        if (d <= cap) score = 0.5 * (1 - d / Math.max(q.length, target.length));
      }
      if (score > 0) scored.push({ s, score });
    }

    scored.sort((a, b) => b.score - a.score || a.s.name.length - b.s.name.length);
    const results = scored.slice(0, limit).map(({ s, score }) => ({
      name: s.name,
      domain: s.domain,
      kind: s.kind,
      className: s.className,
      available: s.available,
      signature: signatureOf(s),
      score: Math.round(score * 1000) / 1000,
    }));
    return { query, total: scored.length, results };
  }

  get(name: string, opts: { domain?: ApiDomain; className?: string } = {}): {
    found: boolean;
    matches: ApiSymbol[];
    suggestions?: ApiSearchHit[];
  } {
    const key = name.toLowerCase();
    let matches = this.data.byName.get(key) ?? [];
    if (opts.domain) matches = matches.filter((s) => s.domain === opts.domain);
    if (opts.className) matches = matches.filter((s) => s.className?.toLowerCase() === opts.className!.toLowerCase());
    if (matches.length === 0) {
      return { found: false, matches: [], suggestions: this.search(name, { domain: opts.domain, limit: 6 }).results };
    }
    return { found: true, matches };
  }

  classInfo(name: string): {
    found: boolean;
    name?: string;
    extend?: string;
    inheritanceChain?: string[];
    ownMembers?: { name: string; signature?: string; available?: string }[];
    inheritedMembers?: { from: string; name: string; signature?: string }[];
    suggestions?: ApiSearchHit[];
  } {
    const cls =
      this.data.classes.get(name) ??
      [...this.data.classes.values()].find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!cls) {
      return { found: false, suggestions: this.search(name, { domain: 'lua', kind: 'class', limit: 6 }).results };
    }

    const memberSym = (className: string) =>
      this.data.symbols.filter((s) => s.kind === 'method' && s.className === className);

    const own = memberSym(cls.name).map((s) => ({
      name: s.member!, signature: signatureOf(s), available: s.available,
    }));

    const chain: string[] = [];
    const inherited: { from: string; name: string; signature?: string }[] = [];
    let cur = cls.extend;
    const guard = new Set<string>();
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      chain.push(cur);
      for (const s of memberSym(cur)) {
        inherited.push({ from: cur, name: s.member!, signature: signatureOf(s) });
      }
      cur = this.data.classes.get(cur)?.extend;
    }

    return {
      found: true,
      name: cls.name,
      extend: cls.extend,
      inheritanceChain: chain,
      ownMembers: own,
      inheritedMembers: inherited,
    };
  }

  /**
   * Looks up a single Panorama CSS property declaration (description + examples).
   * On a miss, returns fuzzy suggestions from the CSS domain.
   */
  cssProp(name: string): {
    found: boolean;
    name?: string;
    description?: string;
    examples?: string[];
    suggestions?: ApiSearchHit[];
  } {
    const got = this.get(name, { domain: 'panorama-css' });
    if (got.found) {
      const s = got.matches[0]!;
      return { found: true, name: s.name, description: s.description, examples: s.examples ?? [] };
    }
    return { found: false, suggestions: this.search(name, { domain: 'panorama-css', limit: 8 }).results };
  }

  get domains(): ApiDomain[] {
    return DOMAINS;
  }
}
