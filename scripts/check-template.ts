/**
 * Validates references/viewer-template.html against live data:
 *  - the page script parses
 *  - pickColumns() picks useful metric columns out of the ~80 an engine emits
 *  - no sequence or path column can ever reach the table
 *
 *   node --experimental-strip-types scripts/check-template.ts [job_id]
 */
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import worker from '../server/src/index.ts';

const JOB = process.argv[2] ?? 'c870f9cd-d9d5-4bff-85cd-b4653f0ff112';
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
  throw new Error(`No ${KEY_VAR}. Set it, or point SEQDESIGN_ENV_FILE at a file that defines it.`);
}

let failures = 0;
const check = (label: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
};

const html = readFileSync(new URL('../skills/seqdesign-viewer/references/viewer-template.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

console.log(`\nviewer-template.html — ${html.length} bytes, ${scripts.length} inline script block(s)\n`);

console.log('static checks');
check('exactly one inline script', scripts.length === 1);
const src = scripts[0] ?? '';
let parses = true;
try { new vm.Script(src); } catch (e) { parses = false; console.log('     ' + (e as Error).message); }
check('page script parses', parses);
check('placeholders present', html.includes('__JOB_ID__') && html.includes('__SERVER__'));
check('viewer library from an allowed CDN', /src="https:\/\/cdn\.jsdelivr\.net\/npm\//.test(html));
check('no external stylesheet', !/<link[^>]+rel="stylesheet"/i.test(html));
check('dark mode guarded on :root:not([data-theme="light"])', html.includes(':root:not([data-theme="light"])'));
check('body has an explicit background', /body\s*\{[^}]*background:/.test(html));
check('declares no capabilities inline', !/capabilities\s*:/.test(src));

// Pull the column-selection logic out of the page and exercise it for real.
const block = /\/\* -+ table -+ \*\/([\s\S]*?)function renderTable/.exec(src);
check('column logic located in page source', !!block);

console.log('\nlive data');
const res = await worker.fetch(
  new Request('https://mcp.seq.design/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key()}` },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_results', arguments: { job_id: JOB, limit: 60 } },
    }),
  }),
);
const rows = ((await res.json()) as any).result?.structuredContent?.results ?? [];
check('rows fetched', rows.length > 0, String(rows.length));
const allKeys = Object.keys(rows[0] ?? {});
check('row is wide, as expected', allKeys.length > 40, `${allKeys.length} columns`);
check('raw rows do contain a sequence column', allKeys.includes('sequence'));

const sandbox: any = { rows, console };
vm.createContext(sandbox);
// runInContext returns the completion value; a `const` here would not escape.
const cols: string[] = vm.runInContext(`${block?.[1] ?? ''}; pickColumns();`, sandbox);

console.log('\npickColumns output');
console.log('  ->', cols.join(', '));
check('first column is design_id', cols[0] === 'design_id');
check('sequence excluded', !cols.includes('sequence'));
check('no path/key column leaked', !cols.some((c) => /path|key|_map$/.test(c)));
check('picked at least two metrics', cols.length >= 3, `${cols.length - 1} metrics`);
check('every metric varies across the pool',
  cols.slice(1).every((c) => new Set(rows.map((r: any) => r[c]).filter((v: any) => v !== null && v !== undefined)).size > 1));
check('no all-null column picked',
  cols.slice(1).every((c) => rows.some((r: any) => typeof r[c] === 'number')));

console.log(failures === 0 ? '\nTemplate checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
