// M6 verification: console log read via byte cursor over the MCP wire.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';

const transport = new StdioClientTransport({ command: 'node', args: ['dist/server.js'] });
const client = new Client({ name: 'm6', version: '0.0.0' });
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name);
const call = async (n: string, a: Record<string, unknown> = {}) =>
  (await client.callTool({ name: n, arguments: a })).structuredContent as any;

// 1. Errors over the WHOLE file (since offset 0) — proves classification works.
const whole = await call('console_errors', {
  since: { offset: 0, size: 0, mtimeMs: 0, sig: '' },
  level: 'error',
  limit: 5,
});

// 2. Mark, then errors since the mark — should be ~0 on an idle log.
const mark = await call('console_mark', {});
const sinceMark = await call('console_errors', { since: mark, level: 'error', limit: 5 });

// 3. Tail.
const tail = await call('console_tail', { lines: 3 });

const result = {
  hasM6Tools: ['console_mark', 'console_errors', 'console_tail'].every((t) => tools.includes(t)),
  logExists: mark.exists,
  wholeMatched: whole.totalMatched,
  wholeReturned: whole.returned,
  wholeBytesScanned: whole.bytesScanned,
  firstErrLevel: whole.entries?.[0]?.level,
  firstErrChannel: whole.entries?.[0]?.channel,
  firstErrCount: whole.entries?.[0]?.count,
  firstErrMsg: whole.entries?.[0]?.message?.slice(0, 80),
  markOffset: mark.offset,
  sinceMarkScanned: sinceMark.bytesScanned,
  sinceMarkMatched: sinceMark.totalMatched,
  tailLines: tail.lines?.length,
};

const pass =
  result.hasM6Tools &&
  result.logExists === true &&
  result.wholeMatched > 0 &&
  result.firstErrLevel === 'error' &&
  result.markOffset > 0 &&
  // since-mark scanned only a tiny delta vs the whole 40MB+ file
  result.sinceMarkScanned < result.wholeBytesScanned &&
  (result.tailLines ?? 0) >= 1;

writeFileSync('m6result.json', JSON.stringify({ pass, result }, null, 2));
console.log(pass ? 'M6_PASS' : 'M6_FAIL');
await client.close();
process.exit(pass ? 0 : 1);
