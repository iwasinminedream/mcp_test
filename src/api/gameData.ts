import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDotaDataDir } from '../config.js';
import { boundedLevenshtein } from '../fuzzy.js';

/**
 * Loads the real Dota 2 game KeyValues (parsed to JSON by @moddota/dota-data):
 * abilities (npc_abilities), heroes (npc_heroes), units (npc_units), the
 * ability→hero map, and per-language localization strings. These are the actual
 * in-game values — cast ranges, AbilityValues, hero stats, tooltip text — so a
 * modder can read true numbers instead of guessing.
 *
 * Each file is loaded lazily on first use and cached; localization is loaded per
 * language on demand (each file is ~10 MB).
 */

export type KvEntry = Record<string, unknown> | string | number;
type KvMap = Record<string, KvEntry>;

/** Default display language. */
export const DEFAULT_LANG = 'english';

/** Implicit base templates each entry type inherits from when resolveBase is on. */
const BASE_KEY: Record<EntryType, string> = {
  ability: 'ability_base',
  hero: 'npc_dota_hero_base',
  unit: 'npc_dota_units_base',
};

export type EntryType = 'ability' | 'hero' | 'unit';

export interface KvLookup {
  found: boolean;
  name?: string;
  /** The raw KeyValues for the entry (optionally merged with its base template). */
  kv?: KvEntry;
  /** For abilities: the hero this ability belongs to (from ability-hero-map). */
  hero?: string;
  /** For heroes/units: the ability_1..N names declared on the entry. */
  abilities?: string[];
  /** Localized display name / description, when found. */
  localized?: { name?: string; description?: string; lore?: string };
  suggestions?: { name: string; score: number }[];
}

export interface LocalizeResult {
  found: boolean;
  key: string;
  lang: string;
  value?: string;
  /** The actual key that matched (localization keys sometimes carry a leading '#'). */
  matchedKey?: string;
  suggestions?: { key: string; value: string }[];
  availableLanguages?: string[];
}

function readJsonMap(dir: string, rel: string): KvMap | null {
  const p = join(dir, rel);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as KvMap) : null;
  } catch {
    return null;
  }
}

/** Collects "Ability1".."AbilityN" values from a hero/unit KV entry, skipping blanks. */
function abilityList(kv: KvEntry | undefined): string[] {
  if (!kv || typeof kv !== 'object') return [];
  const out: string[] = [];
  for (let i = 1; i <= 30; i++) {
    const v = (kv as Record<string, unknown>)[`Ability${i}`];
    if (typeof v === 'string' && v && v !== 'generic_hidden') out.push(v);
  }
  return out;
}

function fuzzy(query: string, keys: string[], limit: number): { name: string; score: number }[] {
  const q = query.toLowerCase();
  const scored: { name: string; score: number }[] = [];
  for (const k of keys) {
    const lk = k.toLowerCase();
    let score = 0;
    if (lk === q) score = 1;
    else if (lk.startsWith(q)) score = 0.9;
    else if (lk.includes(q)) score = 0.75;
    else if (q.length >= 3) {
      const cap = Math.max(2, Math.floor(q.length * 0.4));
      const d = boundedLevenshtein(q, lk, cap);
      if (d <= cap) score = 0.5 * (1 - d / Math.max(q.length, lk.length));
    }
    if (score > 0) scored.push({ name: k, score: Math.round(score * 1000) / 1000 });
  }
  scored.sort((a, b) => b.score - a.score || a.name.length - b.name.length);
  return scored.slice(0, limit);
}

export class GameData {
  private dir: string | null;
  private err: string | null = null;

  private _abilities: KvMap | null = null;
  private _heroes: KvMap | null = null;
  private _units: KvMap | null = null;
  private _abilityHero: KvMap | null = null;
  private readonly _locale = new Map<string, Record<string, string>>();

  constructor() {
    this.dir = resolveDotaDataDir();
    if (!this.dir) {
      this.err = 'dota-data not found. Set DOTA_DATA_PATH to the @moddota/dota-data files/ dir, or vendor it.';
    }
  }

  private map(type: EntryType): KvMap | null {
    if (!this.dir) return null;
    if (type === 'ability') return (this._abilities ??= readJsonMap(this.dir, 'abilities.json') ?? {});
    if (type === 'hero') return (this._heroes ??= readJsonMap(this.dir, 'heroes.json') ?? {});
    return (this._units ??= readJsonMap(this.dir, 'units.json') ?? {});
  }

  private abilityHeroMap(): KvMap {
    if (!this.dir) return {};
    return (this._abilityHero ??= readJsonMap(this.dir, 'ability-hero-map.json') ?? {});
  }

  /** Loads (and caches) a localization language file. */
  private locale(lang: string): Record<string, string> | null {
    const key = lang.toLowerCase();
    const hit = this._locale.get(key);
    if (hit) return hit;
    if (!this.dir) return null;
    const raw = readJsonMap(this.dir, join('localization', `${key}.json`));
    if (!raw) return null;
    const obj = raw as Record<string, string>;
    this._locale.set(key, obj);
    return obj;
  }

  /** Lists the localization languages actually present on disk. */
  availableLanguages(): string[] {
    if (!this.dir) return [];
    try {
      return readdirSync(join(this.dir, 'localization'))
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
        .sort();
    } catch {
      return [];
    }
  }

  get status() {
    const counts: Record<string, number> = {};
    const count = (m: KvMap | null) => (m ? Object.keys(m).length : 0);
    if (this.dir) {
      counts.abilities = count(this.map('ability'));
      counts.heroes = count(this.map('hero'));
      counts.units = count(this.map('unit'));
      counts.abilityHeroMap = Object.keys(this.abilityHeroMap()).length;
    }
    return {
      loaded: !!this.dir,
      dir: this.dir,
      counts,
      languages: this.availableLanguages(),
      error: this.err ?? undefined,
    };
  }

  /** Localizes a single key, tolerating a leading '#' (Dota uses it for some keys). */
  private loc(lang: string, ...candidates: string[]): { key: string; value: string } | null {
    const table = this.locale(lang);
    if (!table) return null;
    for (const c of candidates) {
      for (const k of [c, `#${c}`, c.replace(/^#/, '')]) {
        if (k in table) return { key: k, value: table[k]! };
      }
    }
    return null;
  }

  getEntry(type: EntryType, name: string, opts: { resolveBase?: boolean } = {}): KvLookup {
    const map = this.map(type);
    if (!map) return { found: false, suggestions: [] };

    let kv = map[name];
    if (kv === undefined) {
      return { found: false, suggestions: fuzzy(name, Object.keys(map), 8) };
    }

    if (opts.resolveBase && typeof kv === 'object') {
      const base = map[BASE_KEY[type]];
      if (base && typeof base === 'object') kv = { ...base, ...(kv as Record<string, unknown>) };
    }

    const out: KvLookup = { found: true, name, kv };

    if (type === 'ability') {
      const hero = this.abilityHeroMap()[name];
      if (typeof hero === 'string') out.hero = hero;
      const loc = this.loc(DEFAULT_LANG, `DOTA_Tooltip_ability_${name}`);
      const desc = this.loc(DEFAULT_LANG, `DOTA_Tooltip_ability_${name}_Description`);
      const lore = this.loc(DEFAULT_LANG, `DOTA_Tooltip_ability_${name}_Lore`);
      if (loc || desc || lore) {
        out.localized = { name: loc?.value, description: desc?.value, lore: lore?.value };
      }
    } else {
      out.abilities = abilityList(kv);
      const loc = this.loc(DEFAULT_LANG, name);
      if (loc) out.localized = { name: loc.value };
    }

    return out;
  }

  /** Exact (then '#'-tolerant) localization lookup with substring suggestions on a miss. */
  localize(key: string, opts: { lang?: string; limit?: number } = {}): LocalizeResult {
    const lang = (opts.lang ?? DEFAULT_LANG).toLowerCase();
    const table = this.locale(lang);
    if (!table) {
      return { found: false, key, lang, availableLanguages: this.availableLanguages() };
    }
    const hit = this.loc(lang, key);
    if (hit) return { found: true, key, lang, value: hit.value, matchedKey: hit.key };

    // substring suggestions over keys (case-insensitive)
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
    const q = key.toLowerCase().replace(/^#/, '');
    const suggestions: { key: string; value: string }[] = [];
    for (const k of Object.keys(table)) {
      if (k.toLowerCase().includes(q)) {
        suggestions.push({ key: k, value: table[k]! });
        if (suggestions.length >= limit) break;
      }
    }
    return { found: false, key, lang, suggestions, availableLanguages: this.availableLanguages() };
  }

  /** Clears all cached file contents (used after a data refresh). */
  reset(): void {
    this.dir = resolveDotaDataDir();
    this.err = this.dir ? null : 'dota-data not found.';
    this._abilities = this._heroes = this._units = this._abilityHero = null;
    this._locale.clear();
  }
}
