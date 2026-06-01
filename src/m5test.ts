// M5 verification: Dota 2 API search + get + class over the MCP wire.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';

const transport = new StdioClientTransport({ command: 'node', args: ['dist/server.js'] });
const client = new Client({ name: 'm5', version: '0.0.0' });
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name);
const call = async (n: string, a: Record<string, unknown>) =>
  (await client.callTool({ name: n, arguments: a })).structuredContent as any;

const status = await call('index_status', {});
const search = await call('api_search', { query: 'SetParticleControlEnt', limit: 5 });
const getFn = await call('api_get', { name: 'ParticleManager:CreateParticle' });
const getEnum = await call('api_get', { name: 'PATTACH_POINT_FOLLOW' });
const cls = await call('api_class', { name: 'CDOTA_BaseNPC_Hero' });
const css = await call('api_search', { query: 'flow-children', domain: 'panorama-css', limit: 3 });

const firstFn = getFn.matches?.find((m: any) => m.kind === 'method' || m.kind === 'function');
const result = {
  hasM5Tools: ['api_search', 'api_get', 'api_class'].every((t) => tools.includes(t)),
  noDocsTools: !tools.includes('docs_search') && !tools.includes('docs_get'),
  apiLoaded: status.api?.loaded,
  apiCounts: status.api?.counts,
  searchTop: search.results?.[0]?.name,
  createParticleSig: firstFn?.name,
  createParticleArgs: firstFn?.args?.map((a: any) => `${a.name}:${a.types?.join('|')}`),
  pattachKind: getEnum.matches?.[0]?.kind,
  classFound: cls.found,
  classInheritedChain: cls.inheritanceChain,
  classInherited: cls.inheritedMembers?.length,
  cssTop: css.results?.[0]?.name,
};

const pass =
  result.hasM5Tools &&
  result.noDocsTools &&
  result.apiLoaded === true &&
  (result.searchTop?.includes('SetParticleControlEnt') ?? false) &&
  !!result.createParticleSig &&
  (result.createParticleArgs?.length ?? 0) >= 2 &&
  result.classFound === true &&
  (result.classInheritedChain?.length ?? 0) >= 1 &&
  (result.classInherited ?? 0) > 0;

writeFileSync('m5result.json', JSON.stringify({ pass, result }, null, 2));
console.log(pass ? 'M5_PASS' : 'M5_FAIL');
await client.close();
process.exit(pass ? 0 : 1);
