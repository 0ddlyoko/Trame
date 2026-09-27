// Banc de mesure dans Chrome headless : 1 000 lignes (composant Row), 5 champs, 2 boutons conditionnels.
// Variantes : lignes à 5 champs, puis à 30 champs dont 5 affichés ; Trame (copie de travail ou commits
// donnés en argument, mesurés dans le même passage) et OWL 3 s'il est installé.
// Usage : npm install --no-save @odoo/owl@3.0.0-alpha.49
//         node bench/props/run.mjs [ref git ...]        (CHROME=chemin pour un autre navigateur)
// Les mesures d'un passage à l'autre dépendent de l'état de la machine : ne comparer que des variantes
// mesurées dans le même passage (d'où les refs en argument).
// Mesures par opération : durée mesurée dans la page (avec et sans la mise en page), CPU du thread
// principal (TaskDuration via DevTools ; ScriptDuration n'est pas utilisable : il ignore les microtasks).
// La mémoire se mesure avec memory.mjs : sur une page réutilisée, HeapProfiler.collectGarbage ne libère
// pas toujours la génération précédente de lignes, ce qui faussait la mesure.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVariants } from "./variants.mjs";

const chromePath = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9333;
const ROUNDS = Number(process.env.ROUNDS ?? 3); // pages par variante (alternées)
const WARMUP = 3;
const CYCLES = 15;
const OPS = ["create", "updatePrice", "updateLabel", "sameTotal", "toggleReadonly", "toggleReadonly", "clear"];
/** Opérations qui modifient forcément la première ligne (vérification que le DOM a bien été mis à jour). */
const CHANGES_FIRST_ROW = new Set(["updatePrice", "updateLabel", "sameTotal", "toggleReadonly"]);

const { variants: VARIANTS, cleanup } = await buildVariants(process.argv.slice(2));

const profile = mkdtempSync(join(tmpdir(), "trame-bench-"));
const chrome = spawn(chromePath, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--allow-file-access-from-files",
    "about:blank",
]);

const http = (path, method = "GET") => fetch(`http://127.0.0.1:${PORT}${path}`, { method }).then((r) => r.json());
for (let i = 0; ; i++) {
    try {
        const version = await http("/json/version");
        console.log(`Navigateur : ${version.Browser}`);
        break;
    } catch {
        if (i > 100) throw new Error("Chrome ne répond pas");
        await new Promise((r) => setTimeout(r, 100));
    }
}

/** Connexion DevTools à une page. */
async function connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
    });
    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.method === "Runtime.exceptionThrown") {
            errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
        }
        if (msg.id !== undefined && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        }
    };
    const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
            const msgId = ++id;
            pending.set(msgId, { resolve, reject });
            ws.send(JSON.stringify({ id: msgId, method, params }));
        });
    const evaluate = async (expression) => {
        const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
        return result.value;
    };
    const metrics = async () => Object.fromEntries((await send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
    return { ws, send, evaluate, metrics, errors };
}

async function runPage(variant) {
    const target = await http(`/json/new?${encodeURIComponent(variant.url)}`, "PUT");
    const page = await connect(target.webSocketDebuggerUrl);
    await page.send("Performance.enable", { timeDomain: "threadTicks" });
    await page.send("Runtime.enable");
    await page.send("HeapProfiler.enable");
    for (let i = 0; !(await page.evaluate("window.bench?.ready === true")); i++) {
        if (i > 200) throw new Error(`${variant.name} : page non prête : ${page.errors.join(" | ")}`);
        await new Promise((r) => setTimeout(r, 25));
    }
    const samples = {};
    let first = "";
    for (let cycle = 0; cycle < WARMUP + CYCLES; cycle++) {
        const measured = cycle >= WARMUP;
        for (let i = 0; i < OPS.length; i++) {
            const op = OPS[i];
            const m0 = await page.metrics();
            const r = await page.evaluate(`bench.op(${JSON.stringify(op)})`);
            const m1 = await page.metrics();
            const expected = op === "clear" ? 0 : 1000;
            if (r.rows !== expected) throw new Error(`${variant.name}/${op} : ${r.rows} lignes`);
            if (CHANGES_FIRST_ROW.has(op) && r.first === first) throw new Error(`${variant.name}/${op} : DOM non mis à jour`);
            first = r.first;
            if (!measured) continue;
            const key = op === "toggleReadonly" ? (i === 4 ? "readonly : masquer" : "readonly : afficher") : op;
            samples[key] ??= { total: [], task: [], script: [] };
            samples[key].total.push(r.total);
            samples[key].task.push((m1.TaskDuration - m0.TaskDuration) * 1000);
            samples[key].script.push(r.script);
        }
    }
    if (page.errors.length) throw new Error(`${variant.name} : ${page.errors.join(" | ")}`);
    page.ws.close();
    await http(`/json/close/${target.id}`).catch(() => {});
    return { samples };
}

const results = Object.fromEntries(VARIANTS.map((v) => [v.name, []]));
for (let round = 0; round < ROUNDS; round++) {
    const order = round % 2 === 0 ? VARIANTS : [...VARIANTS].reverse();
    for (const variant of order) {
        results[variant.name].push(await runPage(variant));
        process.stdout.write(".");
    }
}
console.log("");
chrome.kill();
cleanup();
setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);

const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
};
const value = (name, key, field) => median(results[name].flatMap((r) => r.samples[key][field]));
const names = VARIANTS.map((v) => v.name);

for (const [field, title] of [
    ["total", "Durée jusqu'au DOM à jour, mise en page comprise (ms, médiane)"],
    ["task", "CPU du thread principal (ms, médiane)"],
    ["script", "JS + modifications du DOM, sans la mise en page (ms, médiane)"],
]) {
    console.log(`\n${title}`);
    const rows = Object.keys(results[names[0]][0].samples).map((key) => {
        const row = { opération: key };
        for (const name of names) {
            row[name] = value(name, key, field).toFixed(2);
        }
        // Rapport à la première variante (5 champs) et à la deuxième variante Trame (5 champs) le cas échéant.
        const narrow = names.filter((n) => !n.endsWith(" 30 ch."));
        for (const n of narrow.slice(1)) {
            row[`${n} / ${narrow[0]}`] = `${(value(n, key, field) / value(narrow[0], key, field)).toFixed(2)}x`;
        }
        return row;
    });
    console.table(rows);
}
console.log("\nMémoire : voir bench/props/memory.mjs (page neuve par mesure, GC forcé).");
