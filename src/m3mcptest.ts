// M3 over the real MCP wire: spawn the built server, call the new tools.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'node', args: ['dist/server.js'] });
const client = new Client({ name: 'm3-mcp', version: '0.0.0' });
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name);
async function call(name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  return r.structuredContent as Record<string, any>;
}

const refsTo = await call('refs_to', { path: 'materials/models/heroes/axe/axe_body_color.vmat_c' });
const refsFrom = await call('refs_from', { path: 'models/heroes/axe/axe.vmdl_c' });
const val = await call('validate_attachment', { model: 'models/heroes/axe/axe.vmdl_c', attachment: 'attach_hitlock' });
const gen = await call('gen_attach_snippet', {
  model: 'models/heroes/axe/axe.vmdl_c', attachment: 'attach_attack1',
  particle: 'particles/units/heroes/hero_axe/axe_culling_blade.vpcf',
});

const expected = ['refs_from', 'refs_to', 'build_graph', 'validate_attachment', 'gen_attach_snippet'];
const haveAll = expected.every((t) => tools.includes(t));
const pass =
  haveAll &&
  refsFrom.count === 5 &&
  refsTo.total >= 1 && refsTo.referrers.includes('models/heroes/axe/axe.vmdl_c') &&
  val.ok === false && val.attachment.suggestions.includes('attach_hitloc') &&
  gen.ok === true && typeof gen.lua === 'string' && gen.lua.includes('attach_attack1');

console.log('M3MCP:' + JSON.stringify({
  pass, toolCount: tools.length, haveAllM3: haveAll,
  refsFromCount: refsFrom.count, refsToTotal: refsTo.total,
  validateOk: val.ok, validateSug: val.attachment?.suggestions,
  genOk: gen.ok,
}));
await client.close();
process.exit(pass ? 0 : 1);
