// Verifies the packaged RELEASE artifact works standalone: spawns
// release/dota2-mcp/server.mjs and confirms it resolves the *vendored* CLI and
// that introspection works end-to-end (attachments + particle decompile).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';

const server = resolve('release/dota2-mcp/server.mjs');
const transport = new StdioClientTransport({ command: 'node', args: [server] });
const client = new Client({ name: 'release-test', version: '0.0.0' });
await client.connect(transport);

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  return r.structuredContent as Record<string, any>;
}

const status = await call('index_status');
const cliPath: string = status.cli?.path ?? '';
const usesVendored = cliPath.replace(/\\/g, '/').includes('release/dota2-mcp/vendor');

const model = await call('model_info', { path: 'models/heroes/axe/axe.vmdl_c' });
const pcf = await call('particle_info', {
  path: 'particles/units/heroes/hero_axe/axe_culling_blade.vpcf_c',
});
// M3: dependency graph + attachment codegen on the packaged artifact.
const refsTo = await call('refs_to', { path: 'materials/models/heroes/axe/axe_body_color.vmat_c' });
const gen = await call('gen_attach_snippet', {
  model: 'models/heroes/axe/axe.vmdl_c', attachment: 'attach_attack1',
  particle: 'particles/units/heroes/hero_axe/axe_culling_blade.vpcf',
});

const checks = {
  serverPath: server,
  indexReady: status.ready === true,
  totalAssets: status.totalAssets,
  cliAvailable: status.cli?.available === true,
  cliPath,
  usesVendoredCli: usesVendored,
  modelAttachments: model.attachments?.length ?? 0,
  modelHasAttack1: model.attachments?.includes('attach_attack1') ?? false,
  modelAttachmentsVia: model.attachmentsVia,
  modelReferencesVia: model.referencesVia,
  particleDecompiledVia: pcf.decompiledVia,
  particleChildCount: pcf.childParticles?.length ?? 0,
  particleClassCount: pcf.functionClasses?.length ?? 0,
  refsToCount: refsTo.total ?? 0,
  refsToHasModel: refsTo.referrers?.includes('models/heroes/axe/axe.vmdl_c') ?? false,
  genOk: gen.ok === true,
  genHasAttach: typeof gen.lua === 'string' && gen.lua.includes('attach_attack1'),
};
console.log(JSON.stringify(checks, null, 2));

const pass =
  checks.indexReady &&
  checks.cliAvailable &&
  checks.usesVendoredCli &&
  checks.modelHasAttack1 &&
  checks.particleDecompiledVia === 'cli' &&
  checks.refsToHasModel &&
  checks.genOk && checks.genHasAttach;
console.log(pass ? '\nRELEASE PASS' : '\nRELEASE FAIL');

await client.close();
process.exit(pass ? 0 : 1);
