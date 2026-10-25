/**
 * Builds a standalone structure-review page: a real RCSB entry with its
 * coordinates embedded, no connector and no credential involved.
 *
 *   node --experimental-strip-types scripts/build-demo.ts <PDB_ID> <outDir>
 *
 * Why embedded rather than fetched: an artifact cannot fetch() files.rcsb.org,
 * or anywhere else. Embedding is only acceptable because this is public data —
 * never do it with an unpublished design.
 *
 * Why 3Dmol rather than Mol*: the Mol* *viewer* bundle on a CDN exposes
 * Viewer.create and loadStructureFromData and nothing else useful. Its
 * selection layer (MolScriptBuilder, StructureSelectionQuery,
 * createStructureRepresentationParams) is not on the global and the names are
 * minified, so per-residue selection would mean bundling the full npm package.
 * 3Dmol takes {chain, resi: [...]} directly.
 *
 * The interface is computed HERE, not in the page: a heavy-atom contact search
 * is exact, testable, and costs the viewer nothing.
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';

const ID = (process.argv[2] ?? '6XS8').toUpperCase();
const OUT = process.argv[3] ?? '.';
const ref = (f: string) => new URL(`../skills/seqdesign-viewer/references/${f}`, import.meta.url);

/** Heavy-atom distance defining a contact, in angstrom. 4.5 is the usual cut. */
const CONTACT = 4.5;

const AA3to1: Record<string, string> = {
  ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E', GLY: 'G',
  HIS: 'H', ILE: 'I', LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F', PRO: 'P', SER: 'S',
  THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V', SEC: 'U', PYL: 'O',
  // D-amino acids and common modified residues, mapped to their L parent so the
  // strip stays readable; `comp` keeps the real code for the tooltip.
  DAL: 'a', DAR: 'r', DAS: 'd', DCY: 'c', DGL: 'e', DGN: 'q', DHI: 'h', DIL: 'i',
  DLE: 'l', DLY: 'k', DPN: 'f', DPR: 'p', DSN: 's', DTH: 't', DTR: 'w', DTY: 'y',
  DVA: 'v', MSE: 'M',
};

interface Atom { x: number; y: number; z: number; el: string; het: boolean }
interface Residue { chain: string; seq: number; comp: string; one: string; het: boolean; atoms: Atom[] }

const cif = await (await fetch(`https://files.rcsb.org/download/${ID}.cif`)).text();
if (!cif.includes('_atom_site.')) throw new Error(`${ID}.cif has no coordinates.`);

/**
 * 3Dmol renders PDB, not mmCIF. Its bundle carries one "cif" string and one
 * _atom_site reference against eight for "pdb": the mmCIF path is a stub and
 * loading through it yields a model with zero atoms and no error. So analysis
 * runs on the mmCIF (richer, auth numbering) and the page embeds the PDB.
 */
let coords = await (await fetch(`https://files.rcsb.org/download/${ID}.pdb`)).text();
let coordFormat = 'pdb';
if (!/^ATOM|^HETATM/m.test(coords)) {
  // Entries too large for the PDB format have none; fall back and let the
  // page's atom-count assertion report it rather than render an empty box.
  coords = cif;
  coordFormat = 'cif';
  console.warn(`  WARNING: ${ID} has no PDB format file; falling back to mmCIF, which 3Dmol parses poorly.`);
}
if (/<\/script/i.test(coords)) throw new Error(`${ID} coordinates would break out of their script block.`);

// --- parse the _atom_site loop -------------------------------------------
const lines = cif.split('\n');
const cols: string[] = [];
let start = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith('_atom_site.')) { cols.push(lines[i].trim().slice('_atom_site.'.length)); start = i + 1; }
  else if (cols.length && start === i) break;
}
if (!cols.length) throw new Error('No _atom_site header found.');
const ix = (n: string) => cols.indexOf(n);
const C = {
  group: ix('group_PDB'), el: ix('type_symbol'), comp: ix('label_comp_id'),
  chain: ix('auth_asym_id') >= 0 ? ix('auth_asym_id') : ix('label_asym_id'),
  seq: ix('auth_seq_id') >= 0 ? ix('auth_seq_id') : ix('label_seq_id'),
  x: ix('Cartn_x'), y: ix('Cartn_y'), z: ix('Cartn_z'), model: ix('pdbx_PDB_model_num'),
};

const byKey = new Map<string, Residue>();
for (let i = start; i < lines.length; i++) {
  const line = lines[i];
  if (line.startsWith('#') || line.startsWith('loop_') || line.startsWith('_')) break;
  if (!line.trim()) continue;
  const f = line.trim().split(/\s+/);
  if (f.length < cols.length) continue;
  if (C.model >= 0 && f[C.model] !== '1') continue;          // first model only
  const comp = f[C.comp];
  if (comp === 'HOH') continue;
  const el = f[C.el];
  if (el === 'H' || el === 'D') continue;                     // heavy atoms only
  const chain = f[C.chain];
  const seq = Number(f[C.seq]);
  if (!chain || !Number.isFinite(seq)) continue;
  const key = `${chain}|${seq}`;
  let r = byKey.get(key);
  if (!r) {
    r = { chain, seq, comp, one: AA3to1[comp] ?? 'X', het: f[C.group] === 'HETATM', atoms: [] };
    byKey.set(key, r);
  }
  r.atoms.push({ x: +f[C.x], y: +f[C.y], z: +f[C.z], el, het: f[C.group] === 'HETATM' });
}
const residues = [...byKey.values()].sort((a, b) => a.chain.localeCompare(b.chain) || a.seq - b.seq);
if (!residues.length) throw new Error('Parsed no residues.');

// --- interface: residues with a heavy-atom contact across a chain boundary ---
// Grid hash so this stays linear rather than N^2 over ~1500 atoms per chain.
const CELL = CONTACT;
const grid = new Map<string, { r: Residue; a: Atom }[]>();
const cellOf = (a: Atom) => `${Math.floor(a.x / CELL)},${Math.floor(a.y / CELL)},${Math.floor(a.z / CELL)}`;
for (const r of residues) for (const a of r.atoms) {
  const k = cellOf(a);
  (grid.get(k) ?? grid.set(k, []).get(k)!).push({ r, a });
}
const contacts = new Map<string, Set<string>>();   // residue key -> partner chains
const cut2 = CONTACT * CONTACT;
for (const r of residues) {
  for (const a of r.atoms) {
    const [cx, cy, cz] = [Math.floor(a.x / CELL), Math.floor(a.y / CELL), Math.floor(a.z / CELL)];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const { r: r2, a: a2 } of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
        if (r2.chain === r.chain) continue;
        const d2 = (a.x - a2.x) ** 2 + (a.y - a2.y) ** 2 + (a.z - a2.z) ** 2;
        if (d2 > cut2) continue;
        const k = `${r.chain}|${r.seq}`;
        (contacts.get(k) ?? contacts.set(k, new Set()).get(k)!).add(r2.chain);
      }
    }
  }
}

// --- per-chain payload the page renders ----------------------------------
const chainIds = [...new Set(residues.map((r) => r.chain))].sort();
const chains = chainIds.map((id) => {
  const rs = residues.filter((r) => r.chain === id);
  return {
    id,
    n: rs.length,
    nonstd: [...new Set(rs.filter((r) => r.het).map((r) => r.comp))].sort(),
    residues: rs.map((r) => ({
      s: r.seq,
      c: r.one,
      t: r.comp,
      i: contacts.has(`${r.chain}|${r.seq}`) ? 1 : 0,
    })),
    interface: rs.filter((r) => contacts.has(`${r.chain}|${r.seq}`)).map((r) => r.seq),
  };
});
const interfaceTotal = chains.reduce((n, c) => n + c.interface.length, 0);

const meta = (await (await fetch(`https://data.rcsb.org/rest/v1/core/entry/${ID}`)).json()) as any;
const title: string = meta.struct?.title ?? ID;
const resolution: number | undefined = meta.rcsb_entry_info?.resolution_combined?.[0];
const method: string = (meta.exptl?.[0]?.method ?? '').replace('X-RAY DIFFRACTION', 'X-ray');

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const chip = (label: string, value: string) =>
  `<div class="chip"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
const chips = [
  chip('entry', ID),
  resolution ? chip('resolution', `${resolution.toFixed(2)} Å`) : '',
  method ? chip('method', method) : '',
  ...chains.map((c) => chip(`chain ${c.id}`, `${c.n} res${c.nonstd.length ? ' · ' + c.nonstd.slice(0, 2).join(' ') : ''}`)),
  chip('interface', `${interfaceTotal} res`),
].filter(Boolean).join('\n      ');

const version = readFileSync(ref('viewer3dmol.version.txt'), 'utf8').trim();

const page = `<title>Vps29 Macrocycle Interface</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<script src="https://cdn.jsdelivr.net/npm/3dmol@${version}/build/3Dmol-min.js"></script>
<style>
  :root {
    --bg: #f7f8f9; --panel: #ffffff; --ink: #12161a; --muted: #5d666e;
    --line: #dfe3e7; --accent: #0b7285; --hot: #c2410c; --stage: #eef1f3;
    --sans: "IBM Plex Sans", ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
    --mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
  }
  :root:not([data-theme="light"]) {
    @media (prefers-color-scheme: dark) {
      color-scheme: dark;
      --bg: #0f1316; --panel: #161b1f; --ink: #e8ecef; --muted: #8e979f;
      --line: #262d33; --accent: #3fb6c8; --hot: #f08c4b; --stage: #0b0e11;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #0f1316; --panel: #161b1f; --ink: #e8ecef; --muted: #8e979f;
    --line: #262d33; --accent: #3fb6c8; --hot: #f08c4b; --stage: #0b0e11;
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
  .chip { border: 1px solid var(--line); border-radius: 7px; background: var(--panel); padding: 6px 11px; }
  .chip span {
    display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--muted); font-weight: 600;
  }
  .chip b {
    display: block; font-family: var(--mono); font-size: 13.5px; font-weight: 500;
    font-variant-numeric: tabular-nums; margin-top: 2px;
  }

  .bar { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 10px; }
  .bar button {
    font: inherit; font-size: 12.5px; padding: 5px 11px; cursor: pointer; border-radius: 6px;
    border: 1px solid var(--line); background: var(--panel); color: var(--ink);
  }
  .bar button:hover { border-color: var(--accent); }
  .bar button[aria-pressed="true"] {
    border-color: var(--accent); color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }

  .stage { position: relative; height: min(58vh, 520px); min-height: 340px;
    border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--stage); }
  /* 3Dmol measures offsetWidth/offsetHeight of the element it is handed, so
     this must have a real box of its own, not just a sized ancestor. */
  #canvas { position: absolute; inset: 0; }
  .stage canvas { display: block; }
  .gate {
    position: absolute; inset: 0; display: grid; place-items: center; text-align: center;
    padding: 16px; background: var(--panel); z-index: 2; color: var(--muted); font-size: 13px;
  }
  .gate b { display: block; color: var(--hot); font-weight: 600; margin-bottom: 3px; }

  .seqs { margin-top: 14px; display: grid; gap: 10px; }
  .seq { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); overflow: hidden; }
  .seq h2 {
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em;
    color: var(--muted); margin: 0; padding: 9px 12px; border-bottom: 1px solid var(--line);
    display: flex; justify-content: space-between; gap: 10px;
  }
  .seq h2 em { font-style: normal; font-weight: 400; text-transform: none; letter-spacing: 0; }
  .track { padding: 10px 12px 12px; overflow-x: auto; }
  .row { display: flex; flex-wrap: wrap; font-family: var(--mono); font-size: 13px; line-height: 1.9; }
  .res {
    width: 1.15ch; text-align: center; cursor: pointer; border-radius: 2px;
    border-bottom: 2px solid transparent; padding: 0 1px;
  }
  .res[data-i="1"] { color: var(--hot); font-weight: 600; border-bottom-color: var(--hot); }
  .res[data-het="1"] { text-decoration: underline dotted; }
  .res:hover { background: color-mix(in srgb, var(--accent) 22%, transparent); }
  .res[aria-selected="true"] { background: var(--accent); color: #fff; }
  .legend { font-size: 11.5px; color: var(--muted); margin-top: 7px; display: flex; flex-wrap: wrap; gap: 4px 14px; }
  .legend i { font-style: normal; color: var(--hot); font-weight: 600; }
  .foot { margin-top: 12px; font-size: 12px; color: var(--muted); max-width: 72ch; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>

<div class="wrap">
  <h1>${esc(title)}</h1>
  <div class="sub">RCSB ${ID} &middot; interface computed from heavy-atom contacts within ${CONTACT}&nbsp;&#8491;</div>
  <div class="chips">
      ${chips}
  </div>

  <div class="bar" id="bar">
    <button type="button" id="b-iface" aria-pressed="true">Interface residues</button>
    <button type="button" id="b-side" aria-pressed="false">Side chains</button>
    <button type="button" id="b-surf" aria-pressed="false">Surface</button>
    <button type="button" id="b-reset">Reset view</button>
  </div>

  <div class="stage">
    <div id="canvas"></div>
    <div class="gate" id="gate">Starting viewer&hellip;</div>
  </div>

  <div class="seqs" id="seqs"></div>
  <div class="foot" id="foot"></div>
</div>

<script id="chains" type="application/json">${JSON.stringify(chains)}</script>
<script id="coords" type="chemical/x-${coordFormat}">
${coords}
</script>
<script>
const CHAINS = JSON.parse(document.getElementById("chains").textContent);
const CONTACT = ${CONTACT};
const COORD_FORMAT = ${JSON.stringify(coordFormat)};
const CHAIN_COLOR = ["#2f8f9d", "#c2410c", "#6d6875", "#3f7d20", "#8d5524"];

let viewer = null, selected = null;
const on = { iface: true, side: false, surf: false };

function fail(t, d) {
  const g = document.getElementById("gate");
  g.hidden = false;
  g.replaceChildren(
    Object.assign(document.createElement("b"), { textContent: t }),
    Object.assign(document.createElement("div"), { textContent: d })
  );
}
const colorOf = (chainId) => CHAIN_COLOR[CHAINS.findIndex(c => c.id === chainId) % CHAIN_COLOR.length];

/** Rebuild every representation from the current toggle state. */
function paint() {
  if (!viewer) return;
  viewer.removeAllSurfaces();
  viewer.removeAllLabels();
  viewer.setStyle({}, {});

  for (const c of CHAINS) {
    viewer.setStyle({ chain: c.id }, { cartoon: { color: colorOf(c.id) } });
  }
  // A 13-residue macrocycle is invisible as cartoon next to a 184-residue
  // domain, so always draw the short chains as sticks.
  for (const c of CHAINS) {
    if (c.n <= 30) viewer.addStyle({ chain: c.id }, { stick: { radius: 0.18, colorscheme: "default" } });
  }
  if (on.side) {
    for (const c of CHAINS) {
      if (c.interface.length) {
        viewer.addStyle({ chain: c.id, resi: c.interface }, { stick: { radius: 0.13, colorscheme: "default" } });
      }
    }
  }
  if (on.iface) {
    for (const c of CHAINS) {
      if (c.interface.length) {
        viewer.addStyle({ chain: c.id, resi: c.interface }, { cartoon: { color: "#e0631a" } });
      }
    }
  }
  if (on.surf) {
    const big = CHAINS.reduce((a, b) => (a.n >= b.n ? a : b));
    viewer.addSurface($3Dmol.SurfaceType.VDW, { opacity: 0.62, color: "#9bb0bb" }, { chain: big.id });
  }
  if (selected) {
    viewer.addStyle({ chain: selected.chain, resi: [selected.seq] },
      { stick: { radius: 0.26, colorscheme: "default" } });
    viewer.addLabel(selected.label, {
      position: { chain: selected.chain, resi: selected.seq },
      backgroundColor: "#0b7285", backgroundOpacity: 0.85, fontColor: "white", fontSize: 12,
    });
  }
  viewer.render();
}

function toggle(id, key) {
  const b = document.getElementById(id);
  b.onclick = () => { on[key] = !on[key]; b.setAttribute("aria-pressed", String(on[key])); paint(); };
}

function pick(chain, seq, label, el) {
  for (const n of document.querySelectorAll('.res[aria-selected="true"]')) n.removeAttribute("aria-selected");
  if (selected && selected.chain === chain && selected.seq === seq) { selected = null; paint(); viewer.zoomTo(); viewer.render(); return; }
  selected = { chain, seq, label };
  el.setAttribute("aria-selected", "true");
  paint();
  viewer.zoomTo({ chain, resi: [seq] });
  viewer.render();
}

function renderSequences() {
  const host = document.getElementById("seqs");
  host.replaceChildren(...CHAINS.map(c => {
    const box = document.createElement("section"); box.className = "seq";
    const h = document.createElement("h2");
    h.append("Chain " + c.id);
    const em = document.createElement("em");
    em.textContent = c.n + " residues · " + c.interface.length + " at the interface";
    h.append(em); box.append(h);

    const track = document.createElement("div"); track.className = "track";
    const row = document.createElement("div"); row.className = "row";
    for (const r of c.residues) {
      const s = document.createElement("span");
      s.className = "res"; s.textContent = r.c;
      s.dataset.i = String(r.i);
      if (r.t && !/^[A-Z]{3}$/.test(r.t) || r.c === "X") s.dataset.het = "1";
      s.title = r.t + " " + r.s + (r.i ? " · interface" : "");
      s.tabIndex = 0;
      const go = () => pick(c.id, r.s, r.t + r.s, s);
      s.onclick = go;
      s.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
      row.append(s);
    }
    track.append(row);
    const leg = document.createElement("div"); leg.className = "legend";
    const a = document.createElement("span");
    a.append(Object.assign(document.createElement("i"), { textContent: "orange" }), " = within " + CONTACT + " Å of another chain");
    leg.append(a, Object.assign(document.createElement("span"), { textContent: "click a residue to focus it" }));
    track.append(leg);
    box.append(track); return box;
  }));
}

(function init() {
  renderSequences();
  if (typeof $3Dmol === "undefined") { fail("Viewer did not load", "The 3Dmol script was blocked or failed to parse."); return; }
  try {
    const host = document.getElementById("canvas");
    if (!host.clientWidth || !host.clientHeight) {
      fail("Viewer has no size",
        "The canvas container measured " + host.clientWidth + "x" + host.clientHeight + "px, so there is nothing to draw into.");
      return;
    }
    const ground = getComputedStyle(document.documentElement).getPropertyValue("--stage").trim();
    viewer = $3Dmol.createViewer(host, { backgroundColor: ground || "#ffffff" });
    const model = viewer.addModel(document.getElementById("coords").textContent.trim(), COORD_FORMAT);

    // A failed parse returns a model with no atoms and throws nothing, which
    // renders as an empty viewer with no explanation. Refuse to pretend.
    const atoms = model && model.selectedAtoms ? model.selectedAtoms({}).length : 0;
    if (!atoms) {
      fail("No atoms parsed",
        "The " + COORD_FORMAT.toUpperCase() + " coordinates in this page did not parse into a structure.");
      return;
    }

    paint();
    viewer.zoomTo();
    viewer.render();
    document.getElementById("gate").hidden = true;

    // The artifact pane resizes (rotation, drawer open, split view) and 3Dmol
    // does not watch its container.
    if (window.ResizeObserver) {
      let t = 0;
      new ResizeObserver(() => {
        clearTimeout(t);
        t = setTimeout(() => { try { viewer.resize(); viewer.render(); } catch {} }, 80);
      }).observe(host);
    }
    document.getElementById("foot").textContent =
      atoms.toLocaleString() + " atoms, " + CHAINS.reduce((n, c) => n + c.n, 0) + " residues, embedded in this page. "
      + "Public RCSB data, so embedding is fine here. Unpublished designs are fetched at view time instead.";
  } catch (e) { fail("Could not render " + ${JSON.stringify(ID)}, String((e && e.message) || e)); return; }

  toggle("b-iface", "iface"); toggle("b-side", "side"); toggle("b-surf", "surf");
  document.getElementById("b-reset").onclick = () => {
    selected = null;
    for (const n of document.querySelectorAll('.res[aria-selected="true"]')) n.removeAttribute("aria-selected");
    paint(); viewer.zoomTo(); viewer.render();
  };
})();
</script>
`;

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/${ID.toLowerCase()}-demo.html`, page, 'utf8');
try { copyFileSync(ref('molstar.css'), `${OUT}/molstar.css`); } catch { /* 3Dmol needs no stylesheet */ }

console.log(`${ID}  ${title}`);
for (const c of chains) {
  console.log(`  chain ${c.id}: ${String(c.n).padStart(4)} res  ${String(c.interface.length).padStart(3)} interface` +
    (c.nonstd.length ? `  nonstd ${c.nonstd.join(',')}` : ''));
}
console.log(`  interface total: ${interfaceTotal} residues at ${CONTACT} A`);
console.log(`  page: ${(page.length / 1024).toFixed(0)} KB  (${coordFormat} ${(coords.length / 1024).toFixed(0)} KB)  3dmol v${version}`);
console.log(`  wrote ${OUT}/${ID.toLowerCase()}-demo.html`);
