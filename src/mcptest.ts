// End-to-end MCP check: spawn the built server over stdio and call tools.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/server.js'],
});
const client = new Client({ name: 'smoke-client', version: '0.0.0' });
await client.connect(transport);

const tools = await client.listTools();
console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '));

async function call(name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  const data = (r.structuredContent ?? r.content) as Record<string, unknown>;
  console.log(`\n=== ${name}(${JSON.stringify(args)}) ===`);
  console.log(JSON.stringify(data, null, 2).slice(0, 2200));
}

await call('index_status', {});
await call('model_info', { path: 'models/heroes/axe/axe.vmdl_c' });
await call('particle_info', { path: 'particles/units/heroes/hero_axe/axe_culling_blade.vpcf_c' });
await call('material_info', { path: 'materials/models/heroes/axe/axe_body.vmat_c' });
await call('decompile', { path: 'particles/units/heroes/hero_axe/axe_culling_blade.vpcf_c', limit: 600 });
await call('model_info', { path: 'models/heroes/axe/ax.vmdl_c' }); // miss -> suggestions

await client.close();
console.log('\nOK: MCP round-trip succeeded.');
