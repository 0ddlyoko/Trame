// Même scénario que page.ts, en OWL 3 : 1 000 lignes (composant Row), 5 champs, 2 boutons conditionnels.
// OWL n'est pas une dépendance du projet : npm install --no-save @odoo/owl@3.0.0-alpha.49
// requestAnimationFrame est remplacé par un microtask avant le chargement d'OWL (voir run.mjs) :
// on mesure le travail, pas l'attente de la frame suivante.
import { App, Component, props, proxy, t, xml } from "@odoo/owl";

let nextId = 1;

interface LineData {
    id: number;
    product: string;
    uom: string;
    qty: number;
    price: number;
    status: string;
}

const wide = new URLSearchParams(location.search).get("wide") === "1";

function makeLine(): LineData {
    const id = nextId++;
    const line: LineData = { id, product: `Produit ${id}`, uom: "u", qty: 2 + (id % 4) * 2, price: 10 + (id % 90), status: "draft" };
    if (wide) {
        // Enregistrement « large » : 30 champs, dont 5 affichés.
        for (let i = 0; i < 25; i++) {
            (line as unknown as Record<string, number>)[`f${i}`] = i;
        }
    }
    return line;
}

class Row extends Component {
    static template = xml`
        <tr>
            <td><t t-out="this.props.line.id"/></td>
            <td><t t-out="this.props.label"/></td>
            <td><t t-out="this.props.line.qty"/></td>
            <td><t t-out="this.props.line.price.toFixed(2)"/></td>
            <td><t t-out="this.props.total.toFixed(2)"/></td>
            <td>
                <button t-if="this.props.canEdit" t-on-click="this.props.onRemove">Supprimer</button>
                <button t-if="this.props.total > 300">Remise</button>
            </td>
        </tr>`;
    props = props({
        line: t.object(),
        label: t.string(),
        total: t.number(),
        canEdit: t.boolean(),
        onRemove: t.function(),
    });
}

class List extends Component {
    static components = { Row };
    static template = xml`
        <table><tbody>
            <t t-foreach="this.state.lines" t-as="line" t-key="line.id">
                <Row line="line"
                     label="line.product + ' (' + line.uom + ')'"
                     total="line.price * line.qty"
                     canEdit="!this.state.readonly and line.status === 'draft'"
                     onRemove="() => this.remove(line)"/>
            </t>
        </tbody></table>`;
    state = proxy({ lines: [] as LineData[], readonly: false });
    remove(line: LineData) {
        this.state.lines = this.state.lines.filter((l) => l !== line);
    }
}

let list!: List;
let app!: App;
let doubled = false;

const ops: Record<string, () => void> = {
    create() {
        list.state.lines = Array.from({ length: 1000 }, makeLine);
    },
    updatePrice() {
        const lines = list.state.lines;
        for (let i = 0; i < lines.length; i += 10) {
            lines[i].price += 1;
        }
    },
    updateLabel() {
        const lines = list.state.lines;
        for (let i = 0; i < lines.length; i += 10) {
            lines[i].product += "!";
        }
    },
    sameTotal() {
        const lines = list.state.lines;
        for (let i = 0; i < lines.length; i += 10) {
            const line = lines[i];
            if (doubled) {
                line.price /= 2;
                line.qty *= 2;
            } else {
                line.price *= 2;
                line.qty /= 2;
            }
        }
        doubled = !doubled;
    },
    toggleReadonly() {
        list.state.readonly = !list.state.readonly;
    },
    clear() {
        list.state.lines = [];
    },
};

/** Attend que le planificateur d'OWL n'ait plus rien à faire (rendu appliqué au DOM). */
async function idle(): Promise<void> {
    const scheduler = (app as unknown as { scheduler: { tasks: Set<unknown>; frame: number } }).scheduler;
    for (let i = 0; i < 10000; i++) {
        await Promise.resolve();
        if (scheduler.tasks.size === 0 && scheduler.frame === 0) {
            // Quelques tours de plus : un rendu peut en planifier un autre.
            let stable = true;
            for (let j = 0; j < 5; j++) {
                await Promise.resolve();
                if (scheduler.tasks.size !== 0) {
                    stable = false;
                }
            }
            if (stable) {
                return;
            }
        }
    }
    throw new Error("OWL : rendu non terminé");
}

window.bench = {
    ready: false,
    async op(name) {
        const t0 = performance.now();
        ops[name]();
        await idle();
        const t1 = performance.now();
        void document.body.offsetHeight;
        const t2 = performance.now();
        return { script: t1 - t0, total: t2 - t0, rows: document.querySelectorAll("tr").length, first: document.querySelector("tr")?.textContent ?? "" };
    },
};

declare global {
    interface Window {
        bench: { ready: boolean; op(name: string): Promise<{ script: number; total: number; rows: number; first: string }> };
    }
}

app = new App({ dev: false });
void app
    .createRoot(List)
    .mount(document.getElementById("app")!)
    .then((component: unknown) => {
        list = component as List;
        window.bench.ready = true;
    });
