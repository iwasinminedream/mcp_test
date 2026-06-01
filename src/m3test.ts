// M3 verification: RERL-based dependency graph + attachment validators/codegen.
// Prints a single compact JSON summary line (prefixed RESULT:) to stdout.
import { buildIndex } from './indexer.js';
import { DepGraph } from './graph/depGraph.js';
import { validateAttachment, genAttachSnippet } from './introspect/attach.js';

const { index } = buildIndex();

const g = new DepGraph();
const st = g.build(index, { force: true, log: () => {} });

const refsFromModel = g.refsFrom('models/heroes/axe/axe.vmdl_c');
const refsFromPcf = g.refsFrom('particles/units/heroes/hero_axe/axe_culling_blade.vpcf_c');
const toTex = g.refsTo('materials/particle/water_splash/water_splash.vtex_c');
const toMat = g.refsTo('materials/models/heroes/axe/axe_body_color.vmat_c');

const vGood = await validateAttachment(
  index, 'models/heroes/axe/axe.vmdl_c', 'attach_hitloc',
  'particles/units/heroes/hero_axe/axe_culling_blade.vpcf_c');
const vBad = await validateAttachment(index, 'models/heroes/axe/axe.vmdl_c', 'attach_hitlock');
const gen = await genAttachSnippet(index, {
  model: 'models/heroes/axe/axe.vmdl_c',
  attachment: 'attach_attack1',
  particle: 'particles/units/heroes/hero_axe/axe_culling_blade.vpcf',
});

const pass =
  st.edges > 1000 &&
  st.fromCache === false &&
  refsFromModel.length === 5 &&
  toMat.length >= 1 && toMat.includes('models/heroes/axe/axe.vmdl_c') &&
  toTex.length >= 2 &&
  vGood.ok === true && vGood.attachment.available.length >= 5 &&
  vBad.ok === false && vBad.attachment.suggestions.includes('attach_hitloc') &&
  gen.ok === true && gen.lua.includes('SetParticleControlEnt') && gen.lua.includes('attach_attack1');

const summary = {
  pass,
  graph: { edges: st.edges, scanned: st.scanned, buildMs: st.buildMs, fromCache: st.fromCache,
           nodesOut: st.nodesWithOutgoing, nodesIn: st.nodesWithIncoming },
  refsFromModel,
  refsFromPcf,
  refsToTex_count: toTex.length,
  refsToMat: toMat,
  validateGood_ok: vGood.ok,
  validateBad_ok: vBad.ok,
  validateBad_suggestions: vBad.attachment.suggestions,
  gen_ok: gen.ok,
  gen_warnings: gen.warnings,
  lua: gen.lua,
};
console.log('RESULT:' + JSON.stringify(summary));
process.exit(pass ? 0 : 1);
