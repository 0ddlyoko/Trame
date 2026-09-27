import "./setup.mjs";
import * as trame from "../src/index";
import * as owl from "@odoo/owl";

const N = 1000;
const adjectives = ["joli", "grand", "petit", "rouge", "vert", "rapide", "lent", "calme"];
let idCounter = 1;
const label = () => `${adjectives[idCounter % adjectives.length]} ${idCounter++}`;
const settle = async () => { for (let i = 0; i < 50; i++) { await Promise.resolve(); } };

// ---------- Trame ----------
class TRow { id = idCounter; @trame.state accessor label = label(); }
class TBench extends trame.Component {
  static template = trame.xml`<table><tbody><tr t-foreach="rows" t-as="row" t-key="row.id"><td>{{ row.id }}</td><td>{{ row.label }}</td></tr></tbody></table>`;
  @trame.state accessor rows: TRow[] = [];
}

// ---------- OWL 3 ----------
class OBench extends owl.Component {
  static template = owl.xml`<table><tbody><tr t-foreach="this.state.rows" t-as="row" t-key="row.id"><td t-out="row.id"/><td t-out="row.label"/></tr></tbody></table>`;
  state = owl.proxy({ rows: [] as { id: number; label: string }[] });
}

interface Impl { name: string; mount(el: HTMLElement): Promise<void>; create(n: number): void; update(): void; swap(): void; clear(): void; }

function trameImpl(): Impl {
  let c!: TBench;
  return {
    name: "Trame",
    async mount(el) { c = (await trame.mount(TBench, el)).component; },
    create(n) { c.rows = Array.from({ length: n }, () => new TRow()); },
    update() { const rows = c.rows; for (let i = 0; i < rows.length; i += 10) rows[i].label += " !!!"; },
    swap() { const rows = c.rows; const a = rows[1]; rows[1] = rows[998]; rows[998] = a; },
    clear() { c.rows = []; },
  };
}
function owlImpl(): Impl {
  let c!: OBench;
  return {
    name: "OWL 3",
    async mount(el) { c = (await owl.mount(OBench, el)) as unknown as OBench; },
    create(n) { c.state.rows = Array.from({ length: n }, () => ({ id: idCounter, label: label() })); },
    update() { const rows = c.state.rows; for (let i = 0; i < rows.length; i += 10) rows[i].label += " !!!"; },
    swap() { const rows = c.state.rows; const a = rows[1]; rows[1] = rows[998]; rows[998] = a; },
    clear() { c.state.rows = []; },
  };
}

async function measure(impl: Impl, check: (el: HTMLElement) => void) {
  const el = document.createElement("div"); document.body.appendChild(el);
  await impl.mount(el);
  const t: Record<string, number[]> = { "créer 1000": [], "remplacer 1000": [], "maj 1/10": [], "échanger 2": [], "vider": [] };
  for (let run = 0; run < 15; run++) {
    let s = performance.now(); impl.create(N); await settle(); t["créer 1000"].push(performance.now() - s);
    if (el.querySelectorAll("tr").length !== N) throw new Error(impl.name + " create");
    s = performance.now(); impl.create(N); await settle(); t["remplacer 1000"].push(performance.now() - s);
    if (el.querySelectorAll("tr").length !== N) throw new Error(impl.name + " replace");
    s = performance.now(); impl.update(); await settle(); t["maj 1/10"].push(performance.now() - s);
    check(el);
    s = performance.now(); impl.swap(); await settle(); t["échanger 2"].push(performance.now() - s);
    { const trs = el.querySelectorAll("tr"); if (trs[1].firstChild!.textContent === trs[998].firstChild!.textContent || Number(trs[1].firstChild!.textContent) < Number(trs[998].firstChild!.textContent)) throw new Error(impl.name + " swap"); }
    s = performance.now(); impl.clear(); await settle(); t["vider"].push(performance.now() - s);
    if (el.querySelectorAll("tr").length !== 0) throw new Error(impl.name + " clear");
  }
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(t)) { const w = v.slice(2).sort((a, b) => a - b); result[k] = w[Math.floor(w.length / 2)].toFixed(1) + " ms"; }
  el.remove();
  return result;
}

const check = (el: HTMLElement) => { const tds = el.querySelectorAll("tr")[0].querySelectorAll("td"); if (!tds[1].textContent!.endsWith("!!!")) throw new Error("update not applied"); };
const results: Record<string, Record<string, string>> = {};
for (const make of [trameImpl, owlImpl, trameImpl, owlImpl]) { const impl = make(); results[impl.name] = await measure(impl, check); }
console.table(results);
