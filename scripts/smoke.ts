/**
 * End-to-end smoke test: drives the Worker's fetch handler over real JSON-RPC
 * against the live seq.design API. Node 22 supplies every global the Worker
 * runtime does (fetch, Blob, DecompressionStream, Response.json).
 *
 *   node --experimental-strip-types scripts/smoke.ts <job_id>
 *
 * Reads SEQDESIGN_API_KEY from the environment, or from the file named by
 * SEQDESIGN_ENV_FILE. Override the variable name with SEQDESIGN_KEY_VAR.
 * Prints shapes and counts only: never a sequence, never coordinates.
 */
import { readFileSync, existsSync } from 'node:fs';
import worker from '../server/src/index.ts';

const JOB = process.argv[2] ?? 'c870f9cd-d9d5-4bff-85cd-b4653f0ff112';

// An env file can hold keys for more than one seq.design account, so take the
// NAMED variable rather than the first thing that looks like a key: a key from
// the wrong account authenticates fine and then 404s on every job.
const KEY_VAR = process.env.SEQDESIGN_KEY_VAR ?? 'SEQDESIGN_API_KEY';
const ENV_FILE = process.env.SEQDESIGN_ENV_FILE;

function key(): string {
  if (process.env[KEY_VAR]) return process.env[KEY_VAR] as string;
  if (ENV_FILE && existsSync(ENV_FILE)) {
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = new RegExp(`^${KEY_VAR}=(.*)$`).exec(line.trim());
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    }
  }
  throw new Error(
    `No ${KEY_VAR}. Set it in the environment, or point SEQDESIGN_ENV_FILE at a file that defines it. ` +
      `Use SEQDESIGN_KEY_VAR to read a differently named variable.`,
  );
}

const AUTH = `Bearer ${key()}`;
let id = 0;
let failures = 0;

async function rpc(method: string, params?: unknown, auth = AUTH) {
  const res = await worker.fetch(
    new Request('https://mcp.seq.design/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    }),
  );
  return (await res.json()) as any;
}

async function call(tool: string, args: Record<string, unknown>, auth = AUTH) {
  const r = await rpc('tools/call', { name: tool, arguments: args }, auth);
  if (r.error) throw new Error(`rpc error: ${r.error.message}`);
  if (r.result?.isError) return { failed: r.result.content[0].text };
  return { ok: r.result?.structuredContent };
}

function check(label: string, cond: boolean, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
}

console.log(`\nseq.design MCP smoke test — job ${JOB}\n`);

console.log('initialize');
const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
check('protocolVersion returned', !!init.result?.protocolVersion, init.result?.protocolVersion);
check('serverInfo.name', init.result?.serverInfo?.name === 'seq.design');

console.log('\ntools/list');
const list = await rpc('tools/list');
const tools = list.result?.tools ?? [];
check('tool count', tools.length === 6, String(tools.length));
check('all declare readOnlyHint', tools.every((t: any) => t.annotations?.readOnlyHint === true));
check('all have inputSchema', tools.every((t: any) => t.inputSchema?.type === 'object'));

console.log('\nauth handling');
const noAuth = await call('get_job', { job_id: JOB }, '');
check('missing credential is a clean tool error', !!(noAuth as any).failed);
const badAuth = await call('get_job', { job_id: JOB }, 'Bearer not-a-real-key');
check('bad credential is a clean tool error', !!(badAuth as any).failed);

console.log('\nget_job');
const job: any = (await call('get_job', { job_id: JOB })).ok;
check('status present', !!job?.status, job?.status);
check('terminal flag present', typeof job?.terminal === 'boolean', String(job?.terminal));
check('tool name present', !!job?.tool, job?.tool);

console.log('\nget_results');
const results: any = (await call('get_results', { job_id: JOB, limit: 3 })).ok;
const rows = results?.results ?? [];
check('rows returned', rows.length > 0, `${rows.length} of ${results?.total}`);
check('rows carry design_id', rows.every((r: any) => 'design_id' in r));

console.log('\nlist_structures');
const structs: any = (await call('list_structures', { job_id: JOB, limit: 5 })).ok;
const recs = structs?.structures ?? [];
check('structures returned', recs.length > 0, String(recs.length));
check('records carry design_id', recs.every((r: any) => !!r.design_id));
check('records carry structure_url', recs.every((r: any) => !!r.structure_url));

console.log('\nget_structure by design_id');
const did = recs[0]?.design_id;
const st: any = (await call('get_structure', { job_id: JOB, design_id: did })).ok;
check('content returned', typeof st?.content === 'string' && st.content.length > 0, `${st?.bytes} chars`);
check('format reported', st?.format === 'pdb' || st?.format === 'mmcif', st?.format);
check('gzip was decompressed', !/^\x1f\x8b/.test(st?.content ?? ''));
const looksStructural = /^(ATOM|HETATM|data_|loop_|_atom_site)/m.test(st?.content ?? '');
check('parses as coordinates', looksStructural);
check('echoes design_id', st?.design_id === did);

console.log('\nerror paths');
const badJob = await call('get_structure', { job_id: '00000000-0000-0000-0000-000000000000' });
check('unknown job is a clean tool error', !!(badJob as any).failed);
const badDesign = await call('get_structure', { job_id: JOB, design_id: 'nope' });
check('unknown design_id is a clean tool error', !!(badDesign as any).failed);
const badTool = await rpc('tools/call', { name: 'drop_database', arguments: {} });
check('unknown tool rejected', badTool.error?.code === -32602);

console.log('\nhttp surface');
const health = await worker.fetch(new Request('https://mcp.seq.design/health'));
check('/health ok', health.status === 200);
const notFound = await worker.fetch(new Request('https://mcp.seq.design/'));
check('/ is 404', notFound.status === 404);
const options = await worker.fetch(new Request('https://mcp.seq.design/mcp', { method: 'OPTIONS' }));
check('CORS preflight', options.status === 204 && !!options.headers.get('Access-Control-Allow-Headers'));

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
