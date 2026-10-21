# seq.design for Claude

See protein design results inside Claude: an interactive structure viewer and a
live metrics table, in the chat, instead of opening a link.

Two parts that work together.

**A remote MCP server** (`server/`) wrapping the seq.design public API. Stateless,
credential pass-through, deployed as a Cloudflare Worker. It holds no keys of its
own: whatever `Authorization` header arrives is forwarded to
`public.seq.design/v1` and the result comes straight back.

**A skill** (`skills/seqdesign-viewer/`) that teaches Claude to publish an
Artifact wired to that server through the Artifact `mcp` capability. The page
calls the connector at view time using the viewer's own credential, so no key and
no design data is ever baked into published HTML.

## Install

Two routes, and you probably want both.

**As a connector** (this is what makes the viewer work). In claude.ai:
Settings, Connectors, Add custom connector. URL `https://mcp.seq.design/mcp`,
and add a request header `Authorization: Bearer <your seq.design API key>`.
Unlimited custom connectors on Pro and above; one on Free.

**As a plugin** (adds the skill and wires the same server into Claude Code):

```
/plugin marketplace add <this repo>
/plugin install seqdesign
```

The plugin prompts for your API key and stores it in secure storage. Create a key
at seq.design; it needs the `jobs:read` scope.

## Tools

| Tool | What it does |
|---|---|
| `list_engines` | Available engines, slugs, per-run pricing |
| `get_engine` | One engine's parameter schema |
| `get_job` | Status, progress, outcome, accepted-design count |
| `get_results` | Per-design metric rows |
| `list_structures` | Structure records with download URLs, no coordinates |
| `get_structure` | Coordinate text for one design, gunzipped, ready to render |

All six are reads and declare `readOnlyHint`, which is what lets a published page
`watchTool` them and lets the shell cache results.

## Develop

```
cd server && npm install
npm run dev                  # wrangler dev
npm run deploy               # wrangler deploy
```

Tests run the real Worker handler against the live API. Node 22 supplies every
global the Workers runtime does, so there is no build step:

```
node --experimental-strip-types scripts/smoke.ts [job_id]
node --experimental-strip-types scripts/check-template.ts [job_id]
```

`smoke.ts` exercises the JSON-RPC surface, auth failures, gzip decompression and
the error paths. `check-template.ts` parses the artifact template and runs its
column-selection logic against real result rows, asserting that no sequence
column can reach the table.

Both read `SEQDESIGN_API_KEY` from the environment, or from the file named by
`SEQDESIGN_ENV_FILE`. Use `SEQDESIGN_KEY_VAR` to read a differently named
variable. If your env file holds keys for more than one seq.design account, name
the one you want: a key from the wrong account authenticates fine and then 404s
on every job.

## Things that will bite you

- **Structure objects are gzipped and served as `application/octet-stream` with
  no `Content-Encoding`.** `fetch()` will not decompress them. The server does it
  explicitly.
- **`structure_fetch_url` is often empty.** `structure_url` is the real one.
- **Structure URLs are public.** They are direct R2 objects and return 200 with
  no credential at all. Anyone with the URL has the coordinates. That is a
  property of the API, not of this server, and it matters for unpublished work.
- **Results rows and structures are not 1:1.** Join on `design_id`.
- **Artifacts cannot `fetch()` arbitrary origins.** The `mcp` capability is the
  only live data path. External scripts are limited to cdnjs and jsdelivr, and
  stylesheets to Google Fonts, which is why the viewer is 3Dmol.js rather than
  Mol*: Mol*'s plugin UI needs its own stylesheet.
