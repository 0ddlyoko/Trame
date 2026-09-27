// Projet de test pour trame-check : Good est correct, Bad contient une erreur par ligne marquée.
import { Component, props, state, t, xml } from "trame";

export class Line {
    constructor(
        readonly id: number,
        public product: string,
        public price: number,
    ) {}
}

export class Row extends Component {
    static template = xml`<tr><td>{{ props.line.product }}</td></tr>`;
    props = props({
        line: t.instanceOf(Line),
        readonly: t.boolean().default(false),
        onRemove: t.func<() => void>(),
    });
}

export class Good extends Component {
    static components = { Row };
    static template = xml`
        <div>
            <table>
                <Row t-foreach="lines" t-as="line" t-key="line.id" line="line" onRemove="() => remove(line)"/>
            </table>
            <input t-att-value="name" t-on-input="(ev) => name = ev.target.value"/>
            <p t-if="selected">{{ selected.product.toUpperCase() }}</p>
            <t t-set="count" t-value="lines.length"/>
            <span>{{ count.toFixed(0) }} {{ loading(this.lines) }}</span>
            <button t-on-click="clear">vider</button>
        </div>`;
    @state accessor name = "";
    @state accessor lines: Line[] = [];
    @state accessor selected: Line | null = null;
    remove(line: Line) {
        this.lines = this.lines.filter((l) => l !== line);
    }
    clear() {
        this.lines = [];
    }
}

export class Bad extends Component {
    static components = { Row };
    static template = xml`
        <div>
            <p>{{ nme }}</p>
            <p t-foreach="lines" t-as="line" t-key="line.id">{{ line.prodcut }}</p>
            <Row line="name" onRemove="() => 1"/>
            <Row line="lines[0]"/>
            <Row line="lines[0]" onRemove="() => 1" extra="1"/>
            <Missing/>
            <div t-on-click="(ev) => ev.target.value"/>
        </div>`;
    @state accessor name = "";
    @state accessor lines: Line[] = [];
}
