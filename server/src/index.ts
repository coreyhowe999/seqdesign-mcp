/**
 * seq.design MCP server — remote, stateless, Streamable HTTP.
 *
 * Wraps https://public.seq.design/v1 so a Claude connector (and therefore a
 * published Artifact via the `mcp` capability) can read jobs, metrics and
 * structures without ever holding the user's API key in page code.
 *
 * Auth model: pass-through. Whichever credential header arrives (`X-API-Key`
 * preferred, `Authorization` also accepted) is forwarded upstream verbatim.
 * This server stores no credentials and has no key of its own.
 */

const UPSTREAM = 'https://public.seq.design/v1';
const PROTOCOL_VERSION = '2025-06-18';
const UA = 'seqdesign-mcp/0.1';

// Structures come back as public R2 URLs; cap what we inline into a tool result
// so a 200-design job can't blow the context window.
const MAX_STRUCTURE_BYTES = 4 * 1024 * 1024;

type Json = Record<string, unknown>;

/**
 * Headers forwarded upstream verbatim.
 *
 * claude.ai reserves `Authorization` on a custom connector for its own auth, so
 * a key configured there does not reach us intact. seq.design also accepts
 * `X-API-Key`, which nothing in the middle touches — prefer it, and keep
 * `Authorization` working for direct callers and for Claude Code.
 */
type Auth = Record<string, string>;

const AUTH_HEADERS = ['x-api-key', 'authorization'];

function readAuth(req: Request): Auth {
  const out: Auth = {};
  for (const name of AUTH_HEADERS) {
    const v = req.headers.get(name);
    if (v && v.trim()) out[name] = v.trim();
  }
  return out;
}

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  /**
   * Every tool here is a read. Declaring readOnlyHint explicitly matters:
   * the Artifact `mcp` capability only lets a page `watchTool` a read, and
   * only caches results for tools that declare the hint on the wire.
   */
  readOnly: boolean;
  handler: (args: Json, auth: Auth) => Promise<unknown>;
}

class ToolError extends Error {}

async function upstream(path: string, auth: Auth): Promise<Json> {
  const res = await fetch(`${UPSTREAM}${path}`, {
    headers: { ...auth, 'User-Agent': UA, Accept: 'application/json' },
  });
  const text = await res.text();
  let body: Json;
  try {
    body = JSON.parse(text) as Json;
  } catch {
    throw new ToolError(`seq.design returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const err = (body.error ?? {}) as Json;
    throw new ToolError(
      `seq.design ${res.status} ${(err.code as string) ?? 'error'}: ${(err.message as string) ?? text.slice(0, 200)}`,
    );
  }
  return (body.data ?? body) as Json;
}

const str = (d: string) => ({ type: 'string', description: d });
const int = (d: string, def?: number) => ({ type: 'integer', description: d, ...(def !== undefined && { default: def }) });

const TOOLS: ToolDef[] = [
  {
    name: 'list_engines',
    title: 'List design engines',
    description:
      'List the design, folding and scoring engines available on seq.design, with their slugs and per-run pricing. Use this to pick a tool slug before submitting a job.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
    handler: (_a, auth) => upstream('/tools', auth),
  },
  {
    name: 'get_engine',
    title: 'Describe one engine',
    description: 'Full parameter schema and pricing for a single engine, by slug.',
    inputSchema: {
      type: 'object',
      properties: { slug: str('Engine slug, e.g. "bindcraft", "chai1", "boltz2".') },
      required: ['slug'],
    },
    readOnly: true,
    handler: (a, auth) => upstream(`/tools/${encodeURIComponent(String(a.slug))}`, auth),
  },
  {
    name: 'get_job',
    title: 'Job status',
    description:
      'Status and progress for one job (experiment): pending/running/completed counts, terminal flag, outcome, and accepted design count.',
    inputSchema: {
      type: 'object',
      properties: { job_id: str('Experiment / job id.') },
      required: ['job_id'],
    },
    readOnly: true,
    handler: (a, auth) => upstream(`/jobs/${encodeURIComponent(String(a.job_id))}`, auth),
  },
  {
    name: 'get_results',
    title: 'Design metrics',
    description:
      'Per-design metric rows for a completed job (ipTM, pLDDT, ipSAE, ddG and whatever else the engine emits). This is the table to chart or rank on.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: str('Experiment / job id.'),
        limit: int('Max rows to return.', 100),
        offset: int('Row offset for paging.', 0),
        sort_by: str('Column to sort on. Defaults to id.'),
        sort_dir: str('ASC or DESC.'),
      },
      required: ['job_id'],
    },
    readOnly: true,
    handler: (a, auth) => {
      const q = new URLSearchParams();
      for (const k of ['limit', 'offset', 'sort_by', 'sort_dir']) {
        if (a[k] !== undefined && a[k] !== null) q.set(k, String(a[k]));
      }
      return upstream(`/jobs/${encodeURIComponent(String(a.job_id))}/results?${q}`, auth);
    },
  },
  {
    name: 'list_structures',
    title: 'List structures',
    description:
      'List the predicted structures for a job, with download URLs. Returns metadata only, no coordinates. Call get_structure to actually load one into a viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: str('Experiment / job id.'),
        limit: int('Max structures to list.', 100),
        offset: int('Offset for paging.', 0),
      },
      required: ['job_id'],
    },
    readOnly: true,
    handler: (a, auth) => {
      const q = new URLSearchParams();
      for (const k of ['limit', 'offset']) {
        if (a[k] !== undefined && a[k] !== null) q.set(k, String(a[k]));
      }
      return upstream(`/jobs/${encodeURIComponent(String(a.job_id))}/structures?${q}`, auth);
    },
  },
  {
    name: 'get_structure',
    title: 'Load structure coordinates',
    description:
      'Fetch the actual coordinate file (CIF or PDB text) for one design, ready to hand to a molecular viewer. Identify the design either by its index in the job (0-based) or by matching its filename.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: str('Experiment / job id.'),
        design_id: str('Preferred selector. The design_id from a results row or a list_structures record.'),
        index: int('Fallback: 0-based index into the job\'s structure list.'),
        name: str('Fallback: match a structure whose record contains this string.'),
      },
      required: ['job_id'],
    },
    readOnly: true,
    handler: async (a, auth) => {
      const listed = await upstream(`/jobs/${encodeURIComponent(String(a.job_id))}/structures?limit=500`, auth);
      const structures = (listed.structures ?? []) as Json[];
      if (!structures.length) {
        throw new ToolError(
          'This job has no structures. It may still be running, or it finished with zero accepted designs (check get_job outcome).',
        );
      }

      // Results rows and structure records are NOT 1:1 — a job can have 984
      // result rows and one structure. design_id is the only reliable join.
      let pick: Json | undefined;
      if (a.design_id) {
        pick = structures.find((s) => s.design_id === a.design_id);
        if (!pick) throw new ToolError(`No structure for design_id "${a.design_id}". This job has ${structures.length}.`);
      } else if (a.name) {
        const needle = String(a.name).toLowerCase();
        pick = structures.find((s) => JSON.stringify(s).toLowerCase().includes(needle));
        if (!pick) throw new ToolError(`No structure matching "${a.name}". ${structures.length} available.`);
      } else {
        const i = Number(a.index ?? 0);
        if (!Number.isInteger(i) || i < 0 || i >= structures.length) {
          throw new ToolError(`index ${i} out of range; this job has ${structures.length} structures.`);
        }
        pick = structures[i];
      }

      // structure_fetch_url is often empty; structure_url is a direct R2 object.
      const url = (pick.structure_url || pick.structure_fetch_url) as string | undefined;
      if (!url) throw new ToolError(`Structure record carries no download URL. Keys: ${Object.keys(pick).join(', ')}`);

      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new ToolError(`Could not download coordinates (HTTP ${res.status}).`);

      // Objects are stored gzipped but served as application/octet-stream with
      // no Content-Encoding, so fetch() will not decompress them for us.
      const bytes = new Uint8Array(await res.arrayBuffer());
      let text: string;
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        text = await new Response(stream).text();
      } else {
        text = new TextDecoder().decode(bytes);
      }
      if (text.length > MAX_STRUCTURE_BYTES) {
        throw new ToolError(`Structure is ${text.length} bytes decompressed, over the ${MAX_STRUCTURE_BYTES} limit.`);
      }

      const stem = (String(pick.structure_key || url).split('?')[0] || '').toLowerCase().replace(/\.gz$/, '');
      return {
        job_id: a.job_id,
        design_id: pick.design_id ?? null,
        format: stem.endsWith('.cif') || stem.endsWith('.mmcif') ? 'mmcif' : 'pdb',
        bytes: text.length,
        viewer_url: pick.viewer_url ?? null,
        content: text,
      };
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleRpc(msg: Json, auth: Auth): Promise<Json | null> {
  const { method, id, params } = msg as { method: string; id?: unknown; params?: Json };

  // Notifications get no response body.
  if (id === undefined || id === null) return null;

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'seq.design', version: '0.1.0' },
        instructions:
          'Protein design jobs on seq.design. Read job status, per-design metrics and predicted structures. ' +
          'get_structure returns coordinate text suitable for a Mol* viewer.',
      });

    case 'ping':
      return rpcResult(id, {});

    case 'tools/list':
      return rpcResult(id, {
        tools: TOOLS.map(({ name, title, description, inputSchema, readOnly }) => ({
          name,
          title,
          description,
          inputSchema,
          annotations: { title, readOnlyHint: readOnly, destructiveHint: false },
        })),
      });

    case 'tools/call': {
      const name = String(params?.name ?? '');
      const tool = TOOL_MAP.get(name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      if (!Object.keys(auth).length) {
        return rpcResult(id, {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'No seq.design credential reached this server. Configure the connector with the header "X-API-Key: <your seq.design API key>". Use X-API-Key rather than Authorization: claude.ai reserves Authorization for its own connector auth, so a key put there does not arrive.',
            },
          ],
        });
      }
      try {
        const out = await tool.handler((params?.arguments ?? {}) as Json, auth);
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(out) }],
          structuredContent: out as Json,
        });
      } catch (e) {
        const message = e instanceof ToolError ? e.message : `Unexpected failure: ${(e as Error).message}`;
        return rpcResult(id, { isError: true, content: [{ type: 'text', text: message }] });
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === '/health') {
      // Echo WHICH credential headers arrived, never their values: the only way
      // to tell from outside whether a host stripped or replaced one.
      const seen = Object.fromEntries(
        AUTH_HEADERS.map((h) => [h, request.headers.get(h)?.length ?? 0]).filter(([, n]) => n),
      );
      return Response.json(
        { ok: true, tools: TOOLS.length, upstream: UPSTREAM, auth_headers_seen: seen },
        { headers: CORS },
      );
    }

    if (url.pathname !== '/mcp') {
      return Response.json({ error: 'Not found. The MCP endpoint is /mcp.' }, { status: 404, headers: CORS });
    }

    // Stateless: no session to resume, so an SSE GET has nothing to stream.
    if (request.method === 'GET') {
      return new Response('Method Not Allowed', { status: 405, headers: CORS });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: CORS });
    }

    const auth = readAuth(request);

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json(rpcError(null, -32700, 'Parse error'), { status: 400, headers: CORS });
    }

    // A batch is an array; a single call is an object.
    if (Array.isArray(payload)) {
      const out = (await Promise.all(payload.map((m) => handleRpc(m as Json, auth)))).filter(Boolean);
      if (!out.length) return new Response(null, { status: 202, headers: CORS });
      return Response.json(out, { headers: CORS });
    }

    const out = await handleRpc(payload as Json, auth);
    if (!out) return new Response(null, { status: 202, headers: CORS });
    return Response.json(out, { headers: CORS });
  },
};
