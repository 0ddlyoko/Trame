// Diagnostic : chemin de rétention d'une ligne supprimée, dans Chrome (instantané du tas via DevTools).
// Usage : node bench/props/retainers.mjs  (construit la page sans minification)
import * as esbuild from "esbuild";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
await esbuild.build({
    entryPoints: [join(root, "bench", "props", "page.ts")],
    bundle: true,
    format: "iife",
    target: ["es2022"],
    keepNames: true,
    outfile: join(root, "bench", "dist", "props-page.js"),
    logLevel: "warning",
});
const PORT = 9335;
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "tb-"))}`, "--allow-file-access-from-files", "about:blank"]);
const http = (p, m = "GET") => fetch(`http://127.0.0.1:${PORT}${p}`, { method: m }).then((r) => r.json());
for (;;) {
    try {
        await http("/json/version");
        break;
    } catch {
        await new Promise((r) => setTimeout(r, 100));
    }
}
const url = pathToFileURL(join(root, "bench", "dist", "props.html")).href + "?mode=off&wide=1";
const target = await http(`/json/new?${encodeURIComponent(url)}`, "PUT");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
let chunks = [];
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "HeapProfiler.addHeapSnapshotChunk") chunks.push(m.params.chunk);
    if (pending.has(m.id)) {
        pending.get(m.id)(m.result);
        pending.delete(m.id);
    }
};
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;
await send("HeapProfiler.enable");
while (!(await ev("window.bench?.ready === true"))) await new Promise((r) => setTimeout(r, 50));
await ev("bench.op('create')");
await ev("bench.op('clear')");
await send("HeapProfiler.collectGarbage");
chunks = [];
await send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
const snap = JSON.parse(chunks.join(""));
chrome.kill();

const nf = snap.snapshot.meta.node_fields, ef = snap.snapshot.meta.edge_fields;
const nodeTypes = snap.snapshot.meta.node_types[0], edgeTypes = snap.snapshot.meta.edge_types[0];
const N = nf.length, E = ef.length, nodes = snap.nodes, edges = snap.edges, S = snap.strings;
const iName = nf.indexOf("name"), iType = nf.indexOf("type"), iEC = nf.indexOf("edge_count");
const eType = ef.indexOf("type"), eName = ef.indexOf("name_or_index"), eTo = ef.indexOf("to_node");
const count = nodes.length / N;
const first = new Int32Array(count + 1);
for (let i = 0, e = 0; i < count; i++) { first[i] = e; e += nodes[i * N + iEC] * E; }
first[count] = edges.length;
const ret = Array.from({ length: count }, () => []);
for (let i = 0; i < count; i++) for (let e = first[i]; e < first[i + 1]; e += E) if (edgeTypes[edges[e + eType]] !== "weak") ret[edges[e + eTo] / N].push([i, e]);
const label = (i) => `${nodeTypes[nodes[i * N + iType]]}:${S[nodes[i * N + iName]]}`.slice(0, 80);
const edgeLabel = (e) => { const t = edgeTypes[edges[e + eType]]; const n = edges[e + eName]; return t === "element" || t === "hidden" ? `[${n}]` : `.${S[n]}`; };
const targets = [];
for (let i = 0; i < count; i++) if (nodeTypes[nodes[i * N + iType]] === "object" && S[nodes[i * N + iName]] === "WideLine") targets.push(i);
console.log(`WideLine encore en mémoire après clear : ${targets.length}`);
if (targets.length) {
    const prev = new Map([[targets[0], null]]);
    const queue = [targets[0]];
    let found = -1;
    while (queue.length) {
        const n = queue.shift();
        if (n === 0) { found = 0; break; }
        for (const [from, e] of ret[n]) if (!prev.has(from)) { prev.set(from, [n, e]); queue.push(from); }
    }
    const path = [];
    for (let n = found; n !== -1 && prev.get(n) !== null; ) { const [to, e] = prev.get(n); path.push(`${label(n)}  --${edgeLabel(e)}-->`); n = to; }
    path.push(label(targets[0]));
    console.log(path.slice(-16).join("\n"));
}
process.exit(0);
