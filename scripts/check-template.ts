/**
 * Validates both artifact templates against the Artifact page contract and,
 * for the pool view, against live data:
 *  - the page script parses and carries no document skeleton
 *  - external resources stay inside the CSP allowlist
 *  - pickColumns() picks useful metrics out of the ~80 an engine emits
 *  - no sequence or path column can ever reach the screen
 *  - the Mol* page never reaches for a CSP-blocked remote structure source
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
const ref = (f: string) => new URL(`../skills/seqdesign-viewer/references/${f}`, import.meta.url);
const read = (f: string) => readFileSync(ref(f), 'utf8');

/**
 * Strip JS comments before pattern-matching for forbidden calls. The templates
 * document the CSP traps by naming them ("never loadPdb()"), so a naive grep
 * flags the warning instead of a real call.
 */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// Hosts the artifact CSP admits for <script>. Everything else is blocked silently.
const SCRIPT_HOSTS = ['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net/npm/'];

/** Checks that must hold for any page we publish. */
function contractChecks(name: string, html: string) {
  console.log(`\n${name}`);
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  check('exactly one inline script', scripts.length === 1);
  const src = scripts[0] ?? '';
  let parses = true;
  try { new vm.Script(src); } catch (e) { parses = false; console.log('     ' + (e as Error).message); }
  check('page script parses', parses);
  check('has a <title>', /<title>[^<]{3,}<\/title>/.test(html));

  // The platform wraps the file in its own skeleton, so these must not appear.
  // Comments are stripped first: the templates' own notes name the tags they avoid.
  const markup = html.replace(/<!--[\s\S]*?-->/g, '');
  check('no document skeleton tags', !/<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i.test(markup));

  const srcs = [...markup.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  check('every external script on an allowed CDN',
    srcs.every((u) => SCRIPT_HOSTS.some((h) => u.startsWith(h))), `${srcs.length} script(s)`);

  // External stylesheets are Google-Fonts-only; a relative one ships as a sibling file.
  const sheets = [...markup.matchAll(/<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"/gi)].map((m) => m[1]);
  check('stylesheets are Google Fonts or same-origin siblings',
    sheets.every((h) => h.startsWith('https://fonts.googleapis.com/') || !/^https?:\/\//.test(h)),
    `${sheets.length} link(s)`);

  check('dark mode guarded on :root:not([data-theme="light"])', html.includes(':root:not([data-theme="light"])'));
  check('dark palette sets color-scheme', (html.match(/color-scheme:\s*dark/g) ?? []).length >= 2);
  check('body has an explicit background', /body\s*\{[^}]*background:/.test(html));
  check('side gutter set without a zeroing shorthand', /padding-inline:\s*16px/.test(html));
  check('declares no capabilities inline', !/capabilities\s*:/.test(src));
  check('no unescaped \\u in markup', !/>[^<]*\\u[0-9a-f]{4}/i.test(markup.replace(/<script[\s\S]*?<\/script>/g, '')));
  check('sequence is on the deny-list', /HIDDEN\s*=\s*new Set\(\[\s*"sequence"/.test(src));
  return src;
}

const pool = read('viewer-template.html');
const detail = read('detail-template.html');

const poolSrc = contractChecks('viewer-template.html (pool review, 3Dmol)', pool);
check('placeholders present', pool.includes('__JOB_ID__') && pool.includes('__SERVER__'));

const detailSrc = contractChecks('detail-template.html (one design, Mol*)', detail);
check('placeholders present', ['__JOB_ID__', '__DESIGN_ID__', '__SERVER__'].every((p) => detail.includes(p)));
check('links the vendored stylesheet as a sibling', /<link[^>]+href="molstar\.css"/.test(detail));
// Mol* carries RCSB/EBI endpoints for loading by id. Every one is CSP-blocked.
check('never loads a structure from a remote source',
  !/loadPdb\s*\(|loadStructureFromUrl\s*\(|loadPdbDev\s*\(|setRemoteSnapshot\s*\(/.test(code(detailSrc)));
check('loads coordinates from data', /loadStructureFromData\s*\(/.test(detailSrc));
check('remote state panel disabled', /layoutShowRemoteState:\s*false/.test(detailSrc));

console.log('\nvendored molstar.css');
const css = read('molstar.css');
const version = read('molstar.version.txt').trim();
check('stylesheet vendored', css.length > 50_000, `${css.length} bytes`);
const ext = [...css.matchAll(/url\((["']?)(https?:\/\/[^)"']+)/g)].map((m) => m[2]);
check('stylesheet has no off-origin url() refs', ext.length === 0, ext.slice(0, 2).join(' '));
check('no @font-face or @import', !/@font-face|@import/.test(css));
check('script tag version matches the vendored file',
  detail.includes(`molstar@${version}/build/viewer/molstar.js`), `v${version}`);

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

const block = /\/\* -+ table -+ \*\/([\s\S]*?)function renderTable/.exec(poolSrc);
check('column logic located in page source', !!block);
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
