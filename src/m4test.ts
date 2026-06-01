// M4 verification: preview_texture (PNG) + export_model (glb) over the MCP wire.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'node', args: ['dist/server.js'] });
const client = new Client({ name: 'm4', version: '0.0.0' });
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name);

const findRes = await client.callTool({ name: 'find_assets', arguments: { query: 'axe_body_color', kind: 'texture', limit: 1 } });
const texPath = (findRes.structuredContent as any).results?.[0]?.path
  ?? 'materials/models/heroes/axe/axe_body_color_psd_ef6c0027.vtex_c';

const prev = await client.callTool({ name: 'preview_texture', arguments: { path: texPath, maxDim: 128 } });
const prevImg = (prev.content as any[]).find((c) => c.type === 'image');
const prevMeta = prev.structuredContent as any;

const exp = await client.callTool({ name: 'export_model', arguments: { path: 'models/heroes/axe/axe.vmdl_c', format: 'glb', materials: true } });
const e = exp.structuredContent as any;

const result = {
  hasM4Tools: ['preview_texture', 'export_model'].every((t) => tools.includes(t)),
  texPath,
  previewOk: prevMeta?.ok,
  previewDims: prevMeta ? `${prevMeta.width}x${prevMeta.height} -> ${prevMeta.previewWidth}x${prevMeta.previewHeight}` : null,
  hasImage: !!prevImg,
  imageMime: prevImg?.mimeType,
  imageBytesB64: prevImg ? prevImg.data.length : 0,
  exportOk: e?.ok,
  exportFormat: e?.format,
  exportFiles: e?.files?.map((f: any) => `${f.path}:${f.bytes}`),
};

const pass =
  result.hasM4Tools &&
  result.previewOk === true && result.hasImage && result.imageMime === 'image/png' && result.imageBytesB64 > 100 &&
  result.exportOk === true && Array.isArray(e.files) && e.files.some((f: any) => /\.(glb|gltf)$/.test(f.path));

const { writeFileSync } = await import('node:fs');
writeFileSync('m4result.json', JSON.stringify({ pass, result }, null, 2));
console.log(pass ? 'M4_PASS' : 'M4_FAIL');
await client.close();
process.exit(pass ? 0 : 1);
