// Mémoire des 1 000 lignes, mesurée proprement : une page neuve par mesure (aucune génération
// précédente), GC forcé (gc() exposé + DevTools) avant et après la création.
// Usage : node bench/props/memory.mjs [ref git ...]
//   Sans argument : la copie de travail. Avec des refs : chaque commit est extrait dans un worktree
//   temporaire et mesuré avec la même page (Trame uniquement) ; OWL 3 est mesuré une fois.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVariants } from "./variants.mjs";

const PAGES = 5;
const { variants, cleanup } = await buildVariants(process.argv.slice(2));

const PORT = 9336;
const profile = mkdtempSync(join(tmpdir(), "trame-mem-"));
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--allow-file-access-from-files",
    "--js-flags=--expose-gc",
    "about:blank",
]);
const http = (p, m = "GET") => fetch(`http://127.0.0.1:${PORT}${p}`, { method: m }).then((r) => r.json());
for (;;) {
    try {
        console.log(`Navigateur : ${(await http("/json/version")).Browser}`);
        break;
    } catch {
        await new Promise((r) => setTimeout(r, 100));
    }
}

async function measure(url) {
    const target = await http(`/json/new?${encodeURIComponent(url)}`, "PUT");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pending = new Map();
    ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (pending.has(m.id)) {
            pending.get(m.id)(m);
            pending.delete(m.id);
        }
    };
    const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
    const ev = async (expression) => {
        const m = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description);
        return m.result.result.value;
    };
    await send("Performance.enable");
    await send("HeapProfiler.enable");
    while (!(await ev("window.bench?.ready === true"))) await new Promise((r) => setTimeout(r, 50));
    const heap = async () => {
        for (let i = 0; i < 4; i++) {
            await ev("new Promise((r) => setTimeout(() => { gc(); r(); }, 20))");
        }
        await send("HeapProfiler.collectGarbage");
        const metrics = (await send("Performance.getMetrics")).result.metrics;
        return metrics.find((m) => m.name === "JSHeapUsedSize").value;
    };
    const before = await heap();
    const r = await ev("bench.op('create')");
    if (r.rows !== 1000) throw new Error(`${url} : ${r.rows} lignes`);
    const after = await heap();
    ws.close();
    await http(`/json/close/${target.id}`).catch(() => {});
    return after - before;
}

const results = Object.fromEntries(variants.map((v) => [v.name, []]));
for (let i = 0; i < PAGES; i++) {
    for (const v of i % 2 ? [...variants].reverse() : variants) {
        results[v.name].push(await measure(v.url));
    }
    process.stdout.write(".");
}
console.log("");
chrome.kill();
cleanup();
setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log("Mémoire JS des 1 000 lignes (page neuve, GC forcé, médiane de " + PAGES + " pages)");
console.table(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { Ko: Math.round(median(v) / 1024), "min Ko": Math.round(Math.min(...v) / 1024), "max Ko": Math.round(Math.max(...v) / 1024) }])));
