// Game-data verification: css_prop + ability/hero/unit KV + localize over the MCP wire.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';

const transport = new StdioClientTransport({ command: 'node', args: ['dist/server.js'] });
const client = new Client({ name: 'gametest', version: '0.0.0' });
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name);
const call = async (n: string, a: Record<string, unknown>) =>
  (await client.callTool({ name: n, arguments: a })).structuredContent as any;

const status = await call('index_status', {});
const css = await call('css_prop', { name: 'flow-children' });
const cssMiss = await call('css_prop', { name: 'flow-childrenn' });
const ability = await call('ability_kv', { name: 'abaddon_death_coil' });
const abilityFuzzy = await call('ability_kv', { name: 'abaddon_death_coilx' });
const hero = await call('hero_kv', { name: 'npc_dota_hero_axe' });
const unit = await call('unit_kv', { name: 'npc_dota_units_base' });
const locEn = await call('localize', { key: 'DOTA_Tooltip_ability_abaddon_death_coil' });
const locRu = await call('localize', { key: '#npc_dota_hero_axe', lang: 'russian' });

const gd = status.gameData ?? {};
const result = {
  hasTools: ['css_prop', 'ability_kv', 'hero_kv', 'unit_kv', 'localize'].every((t) => tools.includes(t)),
  gameDataLoaded: gd.loaded,
  counts: gd.counts,
  languages: gd.languages,
  cssFound: css.found,
  cssName: css.name,
  cssMissSuggests: (cssMiss.suggestions?.length ?? 0) > 0,
  abilityFound: ability.found,
  abilityBehavior: typeof ability.kv === 'object' ? ability.kv.AbilityBehavior : undefined,
  abilityHero: ability.hero,
  abilityLocalized: ability.localized?.name,
  abilityFuzzySuggests: abilityFuzzy.suggestions?.[0]?.name,
  heroFound: hero.found,
  heroModel: typeof hero.kv === 'object' ? hero.kv.Model : undefined,
  heroAbilities: hero.abilities?.length,
  unitFound: unit.found,
  locEnValue: locEn.value,
  locRuValue: locRu.value,
  locRuMatchedKey: locRu.matchedKey,
};

const pass =
  result.hasTools &&
  result.gameDataLoaded === true &&
  (result.counts?.abilities ?? 0) > 100 &&
  (result.counts?.heroes ?? 0) > 100 &&
  (result.languages?.includes('english') ?? false) &&
  (result.languages?.includes('russian') ?? false) &&
  result.cssFound === true &&
  result.cssMissSuggests === true &&
  result.abilityFound === true &&
  typeof result.abilityBehavior === 'string' &&
  result.abilityHero === 'abaddon' &&
  !!result.abilityLocalized &&
  !!result.abilityFuzzySuggests &&
  result.heroFound === true &&
  typeof result.heroModel === 'string' &&
  (result.heroAbilities ?? 0) > 0 &&
  result.unitFound === true &&
  !!result.locEnValue &&
  !!result.locRuValue;

writeFileSync('gameresult.json', JSON.stringify({ pass, result }, null, 2));
console.log(pass ? 'GAME_PASS' : 'GAME_FAIL');
await client.close();
process.exit(pass ? 0 : 1);
