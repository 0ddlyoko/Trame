// Page de mesure : 1 000 lignes (composant Row), 5 champs affichés, 2 boutons conditionnels.
// ?wide=1 : enregistrements à 30 champs @state, dont 5 affichés.
import { Component, mount, nextTick, props, state, t, xml } from "../../src/index";

let nextId = 1;

class Line {
    readonly id = nextId++;
    @state accessor product = `Produit ${this.id}`;
    @state accessor uom = "u";
    @state accessor qty = 2 + (this.id % 4) * 2; // pair : qty / 2 reste entier
    @state accessor price = 10 + (this.id % 90);
    @state accessor status = "draft";
}

/** Enregistrement « large » : 30 champs @state, dont 5 affichés (?wide=1). */
class WideLine extends Line {
    @state accessor f0 = 0;
    @state accessor f1 = 1;
    @state accessor f2 = 2;
    @state accessor f3 = 3;
    @state accessor f4 = 4;
    @state accessor f5 = 5;
    @state accessor f6 = 6;
    @state accessor f7 = 7;
    @state accessor f8 = 8;
    @state accessor f9 = 9;
    @state accessor f10 = 10;
    @state accessor f11 = 11;
    @state accessor f12 = 12;
    @state accessor f13 = 13;
    @state accessor f14 = 14;
    @state accessor f15 = 15;
    @state accessor f16 = 16;
    @state accessor f17 = 17;
    @state accessor f18 = 18;
    @state accessor f19 = 19;
    @state accessor f20 = 20;
    @state accessor f21 = 21;
    @state accessor f22 = 22;
    @state accessor f23 = 23;
    @state accessor f24 = 24;
}

const wide = new URLSearchParams(location.search).get("wide") === "1";

class Row extends Component {
    static template = xml`
        <tr>
            <td>{{ props.line.id }}</td>
            <td>{{ props.label }}</td>
            <td>{{ props.line.qty }}</td>
            <td>{{ props.line.price.toFixed(2) }}</td>
            <td>{{ props.total.toFixed(2) }}</td>
            <td>
                <button t-if="props.canEdit" t-on-click="props.onRemove">Supprimer</button>
                <button t-if="props.total > 300">Remise</button>
            </td>
        </tr>`;
    props = props({
        line: t.instanceOf(Line),
        label: t.string(),
        total: t.number(),
        canEdit: t.boolean(),
        onRemove: t.func<() => void>(),
    });
}

class List extends Component {
    static components = { Row };
    static template = xml`
        <table><tbody>
            <Row t-foreach="lines" t-as="line" t-key="line.id"
                 line="line"
                 label="line.product + ' (' + line.uom + ')'"
                 total="line.price * line.qty"
                 canEdit="!readonly &amp;&amp; line.status === 'draft'"
                 onRemove="() => remove(line)"/>
        </tbody></table>`;
    @state accessor lines: Line[] = [];
    @state accessor readonly = false;
    remove(line: Line) {
        this.lines = this.lines.filter((l) => l !== line);
    }
}

let list!: List;
let doubled = false;

const ops: Record<string, () => void> = {
    create() {
        list.lines = Array.from({ length: 1000 }, () => (wide ? new WideLine() : new Line()));
    },
    /** 1 ligne sur 10 : prix + 1 (le total change). */
    updatePrice() {
        const lines = list.lines;
        for (let i = 0; i < lines.length; i += 10) {
            lines[i].price += 1;
        }
    },
    /** 1 ligne sur 10 : libellé modifié. */
    updateLabel() {
        const lines = list.lines;
        for (let i = 0; i < lines.length; i += 10) {
            lines[i].product += "!";
        }
    },
    /** 1 ligne sur 10 : prix x2 et quantité / 2 (le total ne change pas). */
    sameTotal() {
        const lines = list.lines;
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
    /** Lecture seule basculée : le bouton « Supprimer » disparaît / réapparaît sur les 1 000 lignes. */
    toggleReadonly() {
        list.readonly = !list.readonly;
    },
    clear() {
        list.lines = [];
    },
};

declare global {
    interface Window {
        bench: { ready: boolean; op(name: string): Promise<{ script: number; total: number; rows: number; first: string }> };
    }
}

window.bench = {
    ready: false,
    async op(name) {
        const t0 = performance.now();
        ops[name]();
        await nextTick();
        const t1 = performance.now();
        void document.body.offsetHeight; // force le style et la mise en page
        const t2 = performance.now();
        return { script: t1 - t0, total: t2 - t0, rows: document.querySelectorAll("tr").length, first: document.querySelector("tr")?.textContent ?? "" };
    },
};

void mount(List, document.getElementById("app")!).then((root) => {
    list = root.component;
    window.bench.ready = true;
});
