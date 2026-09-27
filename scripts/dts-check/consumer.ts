// Projet consommateur minimal : compilé contre dist/trame.d.ts à chaque build (scripts/build.mjs).
// Il vérifie que le fichier de types unique est valide et que l'API publique garde de vrais types.
import {
    Component,
    computed,
    effect,
    ErrorBoundary,
    ErrorHandler,
    extendTemplate,
    inject,
    load,
    loading,
    mount,
    patch,
    props,
    provide,
    Registry,
    resource,
    state,
    t,
    untrack,
    VERSION,
    xml,
    type PropsOf,
} from "trame";
import { deferred, render, settle } from "trame/testing";
import { registerCompiled } from "trame/runtime";
import { compileTemplateFiles } from "trame/compiler";

class Rpc {
    call(route: string): Promise<unknown> {
        return fetch(route).then((r) => r.json());
    }
}

class Line {
    @state accessor price = 0;
    @state accessor qty = 1;
    @computed get total(): number {
        return this.price * this.qty;
    }
    @computed({ eager: true }) get label(): string {
        return `${this.qty} × ${this.price}`;
    }
}

class Row extends Component {
    static template = xml`<tr><td>{{ props.line.total }}</td></tr>`;
    props = props({ line: t.instanceOf(Line), onRemove: t.func<() => void>().optional(), size: t.number().default(1) });
    @inject(Rpc) rpc!: Rpc;
    @state accessor open = false;
    @resource accessor detail = load(
        () => this.props.line.price,
        async (price, { signal }) => ({ price, aborted: signal.aborted }),
    );
    @effect log() {
        return untrack(() => console.log(this.props.size, this.detail?.price));
    }
}

class Page extends Component {
    static template = xml`<ErrorHandler onError="(e) => report(e)"><ErrorBoundary><Row line="line"/></ErrorBoundary></ErrorHandler>`;
    static components = { Row, ErrorBoundary, ErrorHandler };
    @provide rpc = new Rpc();
    line = new Line();
    report(error: unknown) {
        console.error(error);
    }
    get busy(): boolean {
        return loading(() => this.line.total);
    }
}

export async function smoke(el: HTMLElement): Promise<void> {
    const root = await mount(Page, el, { dev: true, provide: [Rpc], onError: (e) => console.error(e) });
    const total: number = root.component.line.total;
    const shape: PropsOf<{ size: ReturnType<typeof t.number> }> = { size: 2 };
    const size: number = shape.size;
    patch(Line, { reset() {} });
    extendTemplate(Page, `<xpath expr="//Row" position="after"><p/></xpath>`);
    new Registry<typeof Row>("fields").add("row", Row);
    const d = deferred<number>();
    d.resolve(total + size);
    const rendered = await render(Page);
    await settle();
    rendered.destroy();
    registerCompiled("x", {});
    const js: string = compileTemplateFiles([{ path: "a.xml", content: "<templates/>" }]);
    const version: string = VERSION;
    void js;
    void version;

    // Les types restent précis (pas de any) :
    // @ts-expect-error total est un nombre
    root.component.line.total.toUpperCase();
    // @ts-expect-error les props sont en lecture seule
    (null as unknown as Row).props.size = 2;
}
