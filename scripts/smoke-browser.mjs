// Test de fumée dans Chrome headless : les fichiers de dist/ s'utilisent comme une application les
// embarque (voir README, « Utiliser Trame dans une application ») :
// - module ES + import map : trame.min.js et testing.js partagent une seule instance de Trame ;
// - script classique : trame.iife.js expose la variable globale Trame.
// Usage (après npm run build) : node scripts/smoke-browser.mjs   (CHROME=chemin pour un autre navigateur)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const chromePath =
    process.env.CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "google-chrome");

const pages = {
    "/esm.html": `<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">{ "imports": { "trame": "/trame.min.js", "trame/testing": "/testing.js" } }</script>
<script type="module">
import { Component, VERSION, xml } from "trame";
import { render } from "trame/testing";
class Hello extends Component {
    static template = xml\`<p>Bonjour {{ name }}</p>\`;
    name = "ERP";
}
try {
    const r = await render(Hello);
    window.result = { version: VERSION, html: r.html() };
} catch (e) {
    window.result = { error: String(e) };
}
</script></head><body></body></html>`,
    "/iife.html": `<!doctype html><html><head><meta charset="utf-8"><script src="/trame.iife.js"></script></head><body>
<script>
(async () => {
    try {
        const { Component, mount, xml } = Trame;
        class Hello extends Component {
            static template = xml\`<p>Bonjour {{ name }}</p>\`;
            name = "ERP";
        }
        const el = document.createElement("div");
        document.body.appendChild(el);
        await mount(Hello, el);
        window.result = { version: Trame.VERSION, html: el.innerHTML };
    } catch (e) {
        window.result = { error: String(e) };
    }
})();
</script></body></html>`,
};

const types = { ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".map": "application/json", ".html": "text/html; charset=utf-8" };
const server = createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (pages[path]) {
        res.writeHead(200, { "content-type": types[".html"] });
        res.end(pages[path]);
        return;
    }
    const file = normalize(join(dist, path));
    if (!file.startsWith(dist)) {
        res.writeHead(403).end();
        return;
    }
    try {
        const body = readFileSync(file);
        res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
        res.end(body);
    } catch {
        res.writeHead(404).end();
    }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const PORT = 9340;
const profile = mkdtempSync(join(tmpdir(), "trame-smoke-"));
const chrome = spawn(chromePath, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-sandbox", "about:blank"]);
const http = (p, m = "GET") => fetch(`http://127.0.0.1:${PORT}${p}`, { method: m }).then((r) => r.json());
for (let i = 0; ; i++) {
    try {
        await http("/json/version");
        break;
    } catch {
        if (i > 150) throw new Error("Chrome ne répond pas");
        await new Promise((r) => setTimeout(r, 100));
    }
}

async function run(page) {
    const target = await http(`/json/new?${encodeURIComponent(base + page)}`, "PUT");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pending = new Map();
    ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (pending.has(m.id)) {
            pending.get(m.id)(m.result);
            pending.delete(m.id);
        }
    };
    const evaluate = (expression) =>
        new Promise((r) => {
            pending.set(++id, r);
            ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
        });
    for (let i = 0; i < 100; i++) {
        const { result } = await evaluate("window.result ?? null");
        if (result.value) {
            ws.close();
            return result.value;
        }
        await new Promise((r) => setTimeout(r, 50));
    }
    ws.close();
    return { error: "aucun résultat (page bloquée ?)" };
}

let failed = false;
for (const page of Object.keys(pages)) {
    const r = await run(page);
    const ok = !r.error && r.version === version && r.html === "<p>Bonjour ERP</p>";
    console.log(`${ok ? "ok  " : "ÉCHEC"} ${page} ${JSON.stringify(r)}`);
    failed ||= !ok;
}
chrome.kill();
server.close();
setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
process.exitCode = failed ? 1 : 0;
