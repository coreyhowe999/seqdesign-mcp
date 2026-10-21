---
name: seqdesign-viewer
description: Show seq.design protein design results as an interactive Mol* structure viewer and metrics table inside the chat, instead of sending the user to a link. Use when the user asks to see, view, inspect, look at, render, or compare designs, structures, binders or metrics from a seq.design job or experiment id; when a seq.design job finishes and its results are worth looking at; or when they say "show me the structure", "open the designs", "chart the metrics", or paste a seq.design job id. Requires the seq.design connector.
---

# seq.design viewer

Turn a seq.design job into a live Artifact: a Mol* viewer plus a sortable metrics
table, fetching from seq.design at view time through the `mcp` capability.

## The rule that matters

**Never inline coordinates, sequences or metric rows into the published HTML.**
The page must call `get_structure` / `get_results` at view time. Two reasons:

1. Pre-patent designs embedded in a page are stored on claude.ai and readable by
   anyone the artifact is shared with. Fetching at view time means data arrives
   under the viewer's own seq.design credential and is never persisted.
2. A snapshot goes stale. A live page follows the job.

If the user explicitly asks for a shareable static snapshot of public data, say
plainly that it will embed the sequences, and get a yes first.

## Steps

1. **Resolve the job.** If the user gave a job id, use it. Otherwise call
   `get_job` on the id in context. Check `terminal` and `completed` before
   building a viewer for a job that is still running; for a running job, report
   progress instead and offer to build the viewer when it lands.

2. **Look before you render.** Call `get_results` with `limit: 5` to learn the
   actual metric column names for this engine. They differ per engine: BindCraft,
   Boltz and Chai do not emit the same columns. Never assume `iptm` exists.
   Call `list_structures` to confirm structures exist and see how many.

3. **Publish the artifact.** Start from
   `references/viewer-template.html`. Declare:

   ```
   capabilities: {
     mcp: { servers: [{ server: "seq.design",
                        tools: ["get_job", "get_results", "list_structures", "get_structure"] }] }
   }
   ```

   The `server` value in the page's own `callTool` / `watchTool` calls is the
   connector's **display name** as the viewer sees it in claude.ai. The publish
   result states the resolved display name; if it does not match what the page
   calls, fix the page and publish again.

4. **Wire the two panes.** `watchTool` for the metrics table (it replays cache
   and refreshes when stale). `callTool` for loading a structure, on click, never
   on load for every design.

5. **Tell the user one line** about what they are looking at and what they can do
   with it. Do not describe the page back to them.

## Degradation, which is not optional

`await claude.use("mcp")` returns `null` when the viewer has no seq.design
connector, has not granted it, or is outside the organization. These are
indistinguishable by design. The page must render its chrome, show one plain line
explaining that the seq.design connector is needed, and light up if the promise
resolves. It must never show a spinner forever or a stack trace.

Tool failures **reject** with `tool_error`. An expired or missing API key surfaces
as an auth failure from the server. Catch it and say so in the page, in words, not
as a console error.

## Engine notes

- **Results rows and structures are not 1:1.** One real job has 984 result rows
  and far fewer structures. Join on `design_id`. Never on row index. A row whose
  design has no stored structure is normal, not an error.
- **A results row has ~79 columns and most are null** for any given engine. An
  rfpeptides job populates `i_plddt` and the liability metrics while leaving
  `iptm`, `plddt` and `ipsae` empty. Pick columns from the data, not from a list
  you remember.
- `ipSAE` is frequently exactly `0.0` across a whole pool and cannot rank it. If
  a column is constant, drop it and say why in the page.
- Structure records also carry a `metrics` object, which is sometimes populated
  where the results row is not. Worth checking when the table looks thin.
- Structures come back as mmCIF or PDB text; `get_structure` reports which in
  `format`. Pass that through rather than sniffing the string.
- `get_structure` takes `design_id` (use this), or `index` / `name` as fallbacks.
- `sequence` is a column on both results rows and structure records. Do not
  render it. The template's `HIDDEN` set exists for this.

## Terminal sessions

Artifacts do not render in the terminal. If there is no app surface, skip the
viewer, print the metrics as a table, and give the seq.design job link.
