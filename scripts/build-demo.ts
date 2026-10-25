/**
 * Builds the public Mol* demo page: a real RCSB entry with its coordinates
 * embedded, no connector and no credential involved.
 *
 *   node --experimental-strip-types scripts/build-demo.ts <PDB_ID> <outDir>
 *
 * Why embedded rather than fetched: an artifact cannot fetch() files.rcsb.org,
 * or anywhere else. Embedding is only acceptable because this is public data —
 * never do it with an unpublished design.
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';

const ID = (process.argv[2] ?? '6XS8').toUpperCase();
const OUT = process.argv[3] ?? '.';
const ref = (f: string) => new URL(`../skills/seqdesign-viewer/references/${f}`, import.meta.url);

const version = readFileSync(ref('molstar.version.txt'), 'utf8').trim();

const cif = await (await fetch(`https://files.rcsb.org/download/${ID}.cif`)).text();
if (!cif.includes('_atom_site.')) throw new Error(`${ID}.cif has no coordinates.`);
if (/<\/script/i.test(cif)) throw new Error(`${ID}.cif would break out of its script block.`);

const meta = (await (await fetch(`https://data.rcsb.org/rest/v1/core/entry/${ID}`)).json()) as any;
const title: string = meta.struct?.title ?? ID;
const resolution: number | undefined = meta.rcsb_entry_info?.resolution_combined?.[0];
const method: string = meta.exptl?.[0]?.method ?? '';
const deposited: string = (meta.rcsb_accession_info?.deposit_date ?? '').slice(0, 10);

// Chain inventory straight from the coordinates, so the page states what is
// actually in the file rather than what the abstract claims.
const chains = new Map<string, { residues: Set<string>; nonstd: Set<string> }>();
let inAtoms = false;
let cols: string[] = [];
for (const line of cif.split('\n')) {
  if (line.startsWith('_atom_site.')) { inAtoms = true; cols.push(line.trim().split('.')[1]); continue; }
  if (inAtoms && (line.startsWith('#') || line.startsWith('loop_'))) break;
  if (!inAtoms || !line.trim()) continue;
  const f = line.trim().split(/\s+/);
  const get = (n: string) => f[cols.indexOf(n)];
  const comp = get('label_comp_id');
  if (comp === 'HOH') continue;
  const ch = get('auth_asym_id') ?? get('label_asym_id');
  const seq = get('auth_seq_id');
  if (!ch) continue;
  const e = chains.get(ch) ?? { residues: new Set(), nonstd: new Set() };
  e.residues.add(seq);
  if (get('group_PDB') === 'HETATM') e.nonstd.add(comp);
  chains.set(ch, e);
}
const chainRows = [...chains.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([id, e]) => ({ id, n: e.residues.size, nonstd: [...e.nonstd].sort() }));

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const chip = (label: string, value: string) =>
  `<div class="chip"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;

const chips = [
  chip('entry', ID),
  resolution ? chip('resolution', `${resolution.toFixed(2)} Å`) : '',
  method ? chip('method', method.replace('X-RAY DIFFRACTION', 'X-ray')) : '',
  deposited ? chip('deposited', deposited) : '',
  ...chainRows.map((c) =>
    chip(`chain ${c.id}`, `${c.n} res${c.nonstd.length ? ' · ' + c.nonstd.slice(0, 3).join(' ') : ''}`),
  ),
].filter(Boolean).join('\n      ');

const page = `<title>Vps29 Macrocycle Complex</title>
<link rel="stylesheet" href="molstar.css">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<script src="https://cdn.jsdelivr.net/npm/molstar@${version}/build/viewer/molstar.js"></script>
<style>
  :root {
    --bg: #f7f8f9; --panel: #ffffff; --ink: #12161a; --muted: #5d666e;
    --line: #dfe3e7; --accent: #0b7285; --warn: #9a5b00;
    --sans: "IBM Plex Sans", ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
    --mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
  }
  :root:not([data-theme="light"]) {
    @media (prefers-color-scheme: dark) {
      color-scheme: dark;
      --bg: #0f1316; --panel: #161b1f; --ink: #e8ecef; --muted: #8e979f;
      --line: #262d33; --accent: #3fb6c8; --warn: #d99a4e;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #0f1316; --panel: #161b1f; --ink: #e8ecef; --muted: #8e979f;
    --line: #262d33; --accent: #3fb6c8; --warn: #d99a4e;
  }
  * { box-sizing: border-box; }
  body {
    background: var(--bg); color: var(--ink); font-family: var(--sans);
    font-size: 15px; line-height: 1.5; -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1200px; margin: 0 auto; padding-block: 22px 40px; padding-inline: 16px; }
  h1 { font-size: 17px; font-weight: 600; margin: 0 0 3px; letter-spacing: -0.01em; text-wrap: balance; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 14px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
  .chip {
    border: 1px solid var(--line); border-radius: 7px; background: var(--panel);
    padding: 6px 11px; min-width: 84px;
  }
  .chip span {
    display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--muted); font-weight: 600;
  }
  .chip b {
    display: block; font-family: var(--mono); font-size: 13.5px; font-weight: 500;
    font-variant-numeric: tabular-nums; margin-top: 2px;
  }
  .viewer {
    position: relative; height: min(70vh, 640px); min-height: 400px;
    border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: #1b1b1b;
  }
  #molstar { position: absolute; inset: 0; }
  .gate {
    position: absolute; inset: 0; display: grid; place-items: center; text-align: center;
    padding: 16px; background: var(--panel); z-index: 2; color: var(--muted); font-size: 13px;
  }
  .gate b { display: block; color: var(--warn); font-weight: 600; margin-bottom: 3px; }
  .foot { margin-top: 12px; font-size: 12px; color: var(--muted); max-width: 70ch; }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>

<div class="wrap">
  <h1>${esc(title)}</h1>
  <div class="sub">RCSB ${ID} &middot; a macrocyclic peptide bound to its target, the public analogue of an rfpeptides design</div>
  <div class="chips">
      ${chips}
  </div>
  <div class="viewer">
    <div id="molstar"></div>
    <div class="gate" id="gate">Starting Mol&#42;&hellip;</div>
  </div>
  <div class="foot" id="foot"></div>
</div>

<script id="coords" type="chemical/x-cif">
${cif}
</script>
<script>
const ID = ${JSON.stringify(ID)};

function fail(title, detail) {
  const g = document.getElementById("gate");
  g.hidden = false;
  g.replaceChildren(
    Object.assign(document.createElement("b"), { textContent: title }),
    Object.assign(document.createElement("div"), { textContent: detail })
  );
}

(async function init() {
  if (typeof molstar === "undefined") {
    fail("Mol* did not load", "The viewer script was blocked or failed to parse.");
    return;
  }
  const cif = document.getElementById("coords").textContent.trim();
  try {
    const viewer = await molstar.Viewer.create(document.getElementById("molstar"), {
      layoutIsExpanded: false,
      layoutShowControls: true,
      layoutShowSequence: true,
      layoutShowLeftPanel: true,
      layoutShowLog: false,
      layoutShowRemoteState: false,  // every remote source is CSP-blocked here
    });
    // Coordinates are already in the page. Never loadPdb(): it reaches for RCSB
    // and the artifact CSP blocks it silently.
    await viewer.loadStructureFromData(cif, "mmcif", {});
    document.getElementById("gate").hidden = true;
    document.getElementById("foot").textContent =
      "mmCIF, " + cif.length.toLocaleString() + " bytes, embedded in this page. "
      + "Public RCSB data, so embedding is fine here. Unpublished designs are fetched at view time instead, "
      + "so they are never stored in the page.";
  } catch (e) {
    fail("Could not render " + ID, String((e && e.message) || e));
  }
})();
</script>
`;

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/${ID.toLowerCase()}-demo.html`, page, 'utf8');
copyFileSync(ref('molstar.css'), `${OUT}/molstar.css`);
console.log(`${ID}  ${title}`);
console.log(`  chains: ${chainRows.map((c) => `${c.id}=${c.n}${c.nonstd.length ? '(' + c.nonstd.join(',') + ')' : ''}`).join('  ')}`);
console.log(`  page: ${(page.length / 1024).toFixed(0)} KB  (cif ${(cif.length / 1024).toFixed(0)} KB)  molstar v${version}`);
console.log(`  wrote ${OUT}/${ID.toLowerCase()}-demo.html + molstar.css`);
