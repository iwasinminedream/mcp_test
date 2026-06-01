import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDotaDataDir } from '../config.js';

/**
 * Loads the pre-built @moddota/dota-data JSON dumps and normalizes them into a
 * single flat list of API symbols for search/lookup. Covers the Lua (vscripts)
 * API, Panorama JS API + CSS + enums + events, game events, engine enums, and
 * modifier metadata. No build step needed — the JSON is already generated.
 */

export type ApiDomain =
  | 'lua'
  | 'panorama-js'
  | 'panorama-css'
  | 'panorama-enum'
  | 'panorama-event'
  | 'event'
  | 'engine-enum'
  | 'modifier';

export type ApiKind =
  | 'class'
  | 'function'
  | 'method'
  | 'constant'
  | 'enum'
  | 'css-property'
  | 'event'
  | 'modifier-property'
  | 'modifier';

export interface ApiArg {
  name: string;
  types: string[];
}

export interface ApiSymbol {
  name: string;
  domain: ApiDomain;
  kind: ApiKind;
  className?: string;
  /** Runtime instance/global name for a method's owning class (e.g. "ParticleManager"). */
  instance?: string;
  member?: string;
  available?: string;
  description?: string;
  args?: ApiArg[];
  returns?: string[];
  extend?: string;
  enumMembers?: { name: string; value: number | string }[];
  value?: number | string;
  examples?: string[];
  fields?: { name: string; type?: string; description?: string }[];
}

export interface ApiData {
  symbols: ApiSymbol[];
  classes: Map<string, ApiSymbol>;
  byName: Map<string, ApiSymbol[]>;
  status: { loaded: boolean; dir: string | null; counts: Record<string, number>; error?: string };
}

function readJson(dir: string, rel: string): unknown | null {
  const p = join(dir, rel);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function argList(args: unknown): ApiArg[] {
  if (!Array.isArray(args)) return [];
  return args.map((a: Record<string, unknown>) => ({
    name: String(a.name ?? ''),
    types: Array.isArray(a.types) ? (a.types as string[]) : a.type ? [String(a.type)] : [],
  }));
}

function enumMembers(raw: unknown): { name: string; value: number | string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((obj: unknown) => {
    if (obj && typeof obj === 'object') {
      const [name, value] = Object.entries(obj as Record<string, unknown>)[0] ?? ['', 0];
      return { name, value: value as number | string };
    }
    return { name: String(obj), value: 0 };
  });
}

let cached: ApiData | null = null;

export function loadApiData(): ApiData {
  if (cached) return cached;

  const dir = resolveDotaDataDir();
  const symbols: ApiSymbol[] = [];
  const classes = new Map<string, ApiSymbol>();
  const counts: Record<string, number> = {};

  const data: ApiData = { symbols, classes, byName: new Map(), status: { loaded: false, dir, counts } };

  if (!dir) {
    data.status.error = 'dota-data not found. Set DOTA_DATA_PATH to the @moddota/dota-data files/ dir, or vendor it.';
    cached = data;
    return data;
  }

  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

  const luaApi = readJson(dir, 'vscripts/api.json') as Record<string, any>[] | null;
  if (luaApi) {
    for (const e of luaApi) {
      if (e.kind === 'class') {
        const cls: ApiSymbol = { name: e.name, domain: 'lua', kind: 'class', extend: e.extend, description: e.description };
        classes.set(e.name, cls);
        symbols.push(cls);
        bump('lua-class');
        for (const mem of e.members ?? []) {
          if (mem.kind !== 'function') continue;
          symbols.push({
            name: `${e.name}:${mem.name}`,
            domain: 'lua',
            kind: 'method',
            className: e.name,
            instance: e.instance,
            member: mem.name,
            available: mem.available,
            description: mem.description,
            args: argList(mem.args),
            returns: Array.isArray(mem.returns) ? mem.returns : mem.returns ? [mem.returns] : [],
          });
          bump('lua-method');
        }
      } else if (e.kind === 'function') {
        symbols.push({
          name: e.name,
          domain: 'lua',
          kind: 'function',
          available: e.available,
          description: e.description,
          args: argList(e.args),
          returns: Array.isArray(e.returns) ? e.returns : e.returns ? [e.returns] : [],
        });
        bump('lua-function');
      }
    }
  }

  const luaEnums = readJson(dir, 'vscripts/enums.json') as Record<string, any>[] | null;
  if (luaEnums) {
    for (const e of luaEnums) {
      if (e.kind === 'enum') {
        symbols.push({ name: e.name, domain: 'lua', kind: 'enum', enumMembers: enumMembers(e.members), description: e.description });
        bump('lua-enum');
      } else if (e.kind === 'constant') {
        symbols.push({ name: e.name, domain: 'lua', kind: 'constant', value: e.value, available: e.available });
        bump('lua-constant');
      }
    }
  }

  const panApi = readJson(dir, 'panorama/api.json') as Record<string, any>[] | null;
  if (panApi) {
    for (const iface of panApi) {
      symbols.push({ name: iface.name, domain: 'panorama-js', kind: 'class', description: iface.description });
      bump('panorama-class');
      for (const mem of iface.members ?? []) {
        symbols.push({
          name: `${iface.name}.${mem.name}`,
          domain: 'panorama-js',
          kind: 'method',
          className: iface.name,
          member: mem.name,
          description: mem.description,
          args: argList(mem.args),
          returns: mem.returns ? [String(mem.returns)] : [],
        });
        bump('panorama-method');
      }
    }
  }

  const css = readJson(dir, 'panorama/css.json') as Record<string, any> | null;
  if (css && !Array.isArray(css)) {
    for (const [name, info] of Object.entries(css)) {
      symbols.push({
        name,
        domain: 'panorama-css',
        kind: 'css-property',
        description: (info as Record<string, unknown>).description as string,
        examples: ((info as Record<string, unknown>).examples as string[]) ?? [],
      });
      bump('panorama-css');
    }
  }

  const panEnums = readJson(dir, 'panorama/enums.json') as Record<string, any>[] | null;
  if (Array.isArray(panEnums)) {
    for (const e of panEnums) {
      symbols.push({ name: e.name, domain: 'panorama-enum', kind: 'enum', enumMembers: enumMembers(e.members) });
      bump('panorama-enum');
    }
  }

  const panEvents = readJson(dir, 'panorama/events.json') as Record<string, any>[] | null;
  if (Array.isArray(panEvents)) {
    for (const e of panEvents) {
      symbols.push({ name: e.name, domain: 'panorama-event', kind: 'event', description: e.description });
      bump('panorama-event');
    }
  }

  const events = readJson(dir, 'events.json') as Record<string, any>[] | null;
  if (Array.isArray(events)) {
    for (const e of events) {
      symbols.push({
        name: e.name,
        domain: 'event',
        kind: 'event',
        description: e.description,
        fields: (e.fields ?? []).map((f: Record<string, unknown>) => ({
          name: String(f.name), type: f.type as string, description: f.description as string,
        })),
      });
      bump('event');
    }
  }

  const engEnums = readJson(dir, 'engine-enums.json') as Record<string, any>[] | null;
  if (Array.isArray(engEnums)) {
    for (const e of engEnums) {
      symbols.push({ name: e.name, domain: 'engine-enum', kind: 'enum', enumMembers: enumMembers(e.members) });
      bump('engine-enum');
    }
  }

  const modProps = readJson(dir, 'vscripts/modifier_properties.json') as string[] | null;
  if (Array.isArray(modProps)) {
    for (const name of modProps) {
      symbols.push({ name, domain: 'modifier', kind: 'modifier-property' });
      bump('modifier-property');
    }
  }

  const modList = readJson(dir, 'vscripts/modifier_list.json') as Record<string, unknown> | null;
  if (modList && !Array.isArray(modList)) {
    for (const name of Object.keys(modList)) {
      symbols.push({ name, domain: 'modifier', kind: 'modifier' });
      bump('modifier');
    }
  }

  for (const s of symbols) {
    const key = s.name.toLowerCase();
    let arr = data.byName.get(key);
    if (!arr) data.byName.set(key, (arr = []));
    arr.push(s);
    if (s.member) {
      const mk = s.member.toLowerCase();
      let marr = data.byName.get(mk);
      if (!marr) data.byName.set(mk, (marr = []));
      marr.push(s);
    }
    // Alias methods under their runtime instance name (e.g. ParticleManager:X →
    // CScriptParticleManager:X) so lookups by the global resolve.
    if (s.member && s.instance) {
      const ik = `${s.instance}:${s.member}`.toLowerCase();
      let iarr = data.byName.get(ik);
      if (!iarr) data.byName.set(ik, (iarr = []));
      iarr.push(s);
    }
  }

  data.status.loaded = symbols.length > 0;
  if (!data.status.loaded) data.status.error = `No API symbols loaded from ${dir}.`;
  cached = data;
  return data;
}
