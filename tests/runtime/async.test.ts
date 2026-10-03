import { describe, expect, test, vi } from "vitest";
import { Component, computed, effect, load, loading, mount, nextTick, props, refresh, resource, state, t, xml } from "../../src/index";
import { deferred, render, settle } from "../helpers";

interface Order {
    id: number;
    name: string;
    lines: string[];
}

describe("@resource dans les composants", () => {
    test("mount attend que les données lues soient chargées (pas d'affichage à moitié vide)", async () => {
        const d = deferred<Order>();
        class OrderForm extends Component {
            static template = xml`<h1>{{ order.name }}</h1>`;
            @resource accessor order = load(() => d.promise);
        }
        const fixture = document.createElement("div");
        let mounted = false;
        const promise = mount(OrderForm, fixture).then((root) => {
            mounted = true;
            return root;
        });
        await settle();
        expect(mounted).toBe(false);
        expect(fixture.innerHTML).toBe("");
        d.resolve({ id: 1, name: "SO001", lines: [] });
        await promise;
        expect(fixture.innerHTML).toBe("<h1>SO001</h1>");
    });

    test("plusieurs ressources chargées en parallèle, affichage quand tout est prêt", async () => {
        const a = deferred<string>();
        const b = deferred<string>();
        const fa = vi.fn(() => a.promise);
        const fb = vi.fn(() => b.promise);
        class Comp extends Component {
            static template = xml`<p>{{ first }}-{{ second }}</p>`;
            @resource accessor first = load(fa);
            @resource accessor second = load(fb);
        }
        const fixture = document.createElement("div");
        const promise = mount(Comp, fixture);
        expect(fa).toHaveBeenCalledTimes(1);
        expect(fb).toHaveBeenCalledTimes(1);
        a.resolve("A");
        await settle();
        expect(fixture.innerHTML).toBe("");
        b.resolve("B");
        await promise;
        expect(fixture.innerHTML).toBe("<p>A-B</p>");
    });

    test("une donnée non lue n'est pas chargée ; elle l'est à l'ouverture de son onglet, qui attend", async () => {
        const history = deferred<string[]>();
        const fetchHistory = vi.fn(() => history.promise);
        class Tabs extends Component {
            static template = xml`
                <div>
                    <p class="main">principal</p>
                    <ul t-if="tab === 'history'"><li t-foreach="history" t-as="h" t-key="h">{{ h }}</li></ul>
                </div>`;
            @state accessor tab = "main";
            @resource accessor history = load(fetchHistory);
        }
        const { component, fixture } = await render(Tabs);
        expect(fetchHistory).not.toHaveBeenCalled();
        component.tab = "history";
        await settle();
        expect(fetchHistory).toHaveBeenCalledTimes(1);
        // Le bloc attend ses données : rien d'affiché pour l'instant, le reste de la page reste visible.
        expect(fixture.querySelector("ul")).toBeNull();
        expect(fixture.querySelector(".main")).not.toBeNull();
        history.resolve(["créée", "validée"]);
        await settle();
        expect(fixture.querySelector("ul")!.innerHTML).toBe("<li>créée</li><li>validée</li>");
    });

    test("t-if : l'ancienne branche reste affichée pendant le chargement de la nouvelle", async () => {
        const details = deferred<string>();
        class Comp extends Component {
            static template = xml`<div><p t-if="!showDetails">résumé</p><p t-else="">{{ details }}</p></div>`;
            @state accessor showDetails = false;
            @resource accessor details = load(() => details.promise);
        }
        const { component, html } = await render(Comp);
        component.showDetails = true;
        await settle();
        expect(html()).toBe("<div><p>résumé</p></div>");
        details.resolve("détails");
        await settle();
        expect(html()).toBe("<div><p>détails</p></div>");
    });

    test("changement de vue : l'ancienne, encore affichée, n'est plus mise à jour", async () => {
        const details = deferred<string>();
        const computedRuns = vi.fn();
        const effectRuns = vi.fn();
        class OrderView extends Component {
            static template = xml`<p>{{ title }}</p>`;
            props = props({ order: t.any<{ name: string } | null>() });
            @computed get title(): string {
                computedRuns();
                return this.props.order!.name;
            }
            @effect track(): void {
                effectRuns(this.props.order!.name);
            }
        }
        class DetailsView extends Component {
            static template = xml`<p>{{ details }}</p>`;
            @resource accessor details = load(() => details.promise);
        }
        class Host extends Component {
            static template = xml`<div><OrderView t-if="view === 'order'" order="order"/><DetailsView t-else=""/></div>`;
            static components = { OrderView, DetailsView };
            @state accessor view = "order";
            @state accessor order: { name: string } | null = { name: "SO001" };
        }
        const { component, html } = await render(Host);
        computedRuns.mockClear();
        effectRuns.mockClear();
        component.view = "details";
        component.order = null;
        await settle();
        expect(html()).toBe("<div><p>SO001</p></div>");
        expect(computedRuns).not.toHaveBeenCalled();
        expect(effectRuns).not.toHaveBeenCalled();
        details.resolve("détails");
        await settle();
        expect(html()).toBe("<div><p>détails</p></div>");
    });

    test("changement de vue annulé avant la fin du chargement : l'ancienne vue rattrape les changements", async () => {
        const details = deferred<string>();
        class OrderView extends Component {
            static template = xml`<p>{{ props.name }}</p>`;
            props = props({ name: t.string() });
        }
        class DetailsView extends Component {
            static template = xml`<p>{{ details }}</p>`;
            @resource accessor details = load(() => details.promise);
        }
        class Host extends Component {
            static template = xml`<div><OrderView t-if="view === 'order'" name="name"/><DetailsView t-else=""/></div>`;
            static components = { OrderView, DetailsView };
            @state accessor view = "order";
            @state accessor name = "SO001";
        }
        const { component, html } = await render(Host);
        component.view = "details";
        component.name = "SO002";
        await settle();
        expect(html()).toBe("<div><p>SO001</p></div>");
        component.view = "order";
        await settle();
        expect(html()).toBe("<div><p>SO002</p></div>");
        component.name = "SO003";
        await settle();
        expect(html()).toBe("<div><p>SO003</p></div>");
    });

    test("rechargement : l'ancien contenu reste affiché, loading(x) dans le template", async () => {
        const runs: ReturnType<typeof deferred<Order>>[] = [];
        class OrderForm extends Component {
            static template = xml`<div><h1>{{ order.name }}</h1><small t-if="loading(order)">…</small></div>`;
            props = props({ orderId: t.number() });
            @resource accessor order = load(() => {
                this.props.orderId;
                const d = deferred<Order>();
                runs.push(d);
                return d.promise;
            });
        }
        class Host extends Component {
            static template = xml`<OrderForm orderId="id"/>`;
            static components = { OrderForm };
            @state accessor id = 1;
        }
        const fixture = document.createElement("div");
        const promise = mount(Host, fixture);
        runs[0].resolve({ id: 1, name: "SO001", lines: [] });
        const root = await promise;
        expect(fixture.innerHTML).toBe("<div><h1>SO001</h1></div>");
        root.component.id = 2;
        await settle();
        expect(fixture.innerHTML).toBe("<div><h1>SO001</h1><small>…</small></div>");
        runs[1].resolve({ id: 2, name: "SO002", lines: [] });
        await settle();
        expect(fixture.innerHTML).toBe("<div><h1>SO002</h1></div>");
    });

    test("loading() dans un template ne déclenche pas le chargement", async () => {
        const fetcher = vi.fn(async () => "x");
        class Comp extends Component {
            static template = xml`<p>{{ loading(data) ? 'charge' : 'rien' }}{{ loading(this.data) ? '!' : '' }}</p>`;
            @resource accessor data = load(fetcher);
        }
        const { html } = await render(Comp);
        expect(html()).toBe("<p>rien</p>");
        expect(fetcher).not.toHaveBeenCalled();
    });

    test("t-if=!loading(x) sur une liste : pas de boucle, la liste apparaît une fois chargée", async () => {
        const d = deferred<string[]>();
        class Comp extends Component {
            static template = xml`
                <div>
                    <p t-if="loading(items)">chargement</p>
                    <ul t-if="!loading(items)"><li t-foreach="items" t-as="i" t-key="i">{{ i }}</li></ul>
                </div>`;
            @resource accessor items = load(() => d.promise);
        }
        const fixture = document.createElement("div");
        const promise = mount(Comp, fixture);
        await settle();
        d.resolve(["a", "b"]);
        await promise;
        await settle();
        expect(fixture.innerHTML).toBe("<div><ul><li>a</li><li>b</li></ul></div>");
    });

    test("transition : deux ressources relancées ensemble basculent ensemble", async () => {
        const orderRuns: ReturnType<typeof deferred<string>>[] = [];
        const historyRuns: ReturnType<typeof deferred<string>>[] = [];
        class Comp extends Component {
            static template = xml`<p>{{ order }} / {{ history }}</p>`;
            @state accessor id = 1;
            @resource accessor order = load(() => {
                this.id;
                const d = deferred<string>();
                orderRuns.push(d);
                return d.promise;
            });
            @resource accessor history = load(() => {
                this.id;
                const d = deferred<string>();
                historyRuns.push(d);
                return d.promise;
            });
        }
        const fixture = document.createElement("div");
        const promise = mount(Comp, fixture);
        orderRuns[0].resolve("cmd 1");
        historyRuns[0].resolve("hist 1");
        const root = await promise;
        root.component.id = 2;
        await settle();
        orderRuns[1].resolve("cmd 2");
        await settle();
        expect(fixture.innerHTML).toBe("<p>cmd 1 / hist 1</p>");
        historyRuns[1].resolve("hist 2");
        await settle();
        expect(fixture.innerHTML).toBe("<p>cmd 2 / hist 2</p>");
    });

    test("nouvelles lignes d'une liste déjà affichée : chacune apparaît quand ses données sont prêtes", async () => {
        const details = new Map<number, ReturnType<typeof deferred<string>>>();
        class Line {
            constructor(readonly id: number) {}
            @resource accessor detail = load(() => {
                const d = deferred<string>();
                details.set(this.id, d);
                return d.promise;
            });
        }
        class Comp extends Component {
            static template = xml`<ul><li t-foreach="lines" t-as="l" t-key="l.id">{{ l.detail }}</li></ul>`;
            @state accessor lines: Line[] = [];
        }
        const { component, html } = await render(Comp);
        component.lines = [new Line(1), new Line(2)];
        await settle();
        expect(html()).toBe("<ul></ul>");
        details.get(2)!.resolve("deux");
        await settle();
        expect(html()).toBe("<ul><li>deux</li></ul>");
        details.get(1)!.resolve("un");
        await settle();
        expect(html()).toBe("<ul><li>un</li><li>deux</li></ul>");
    });

    test("refresh() et écriture locale (mise à jour optimiste)", async () => {
        let n = 0;
        class Comp extends Component {
            static template = xml`<p>{{ count }}</p>`;
            @resource accessor count = load(async () => ++n);
            reload() {
                refresh(() => this.count);
            }
        }
        const { component, html } = await render(Comp);
        expect(html()).toBe("<p>1</p>");
        component.reload();
        await settle();
        expect(html()).toBe("<p>2</p>");
        component.count = 42;
        await nextTick();
        expect(html()).toBe("<p>42</p>");
        expect(loading(() => component.count)).toBe(false);
    });

    test("erreur de premier chargement : mount est rejeté", async () => {
        class Comp extends Component {
            static template = xml`<p>{{ data }}</p>`;
            @resource accessor data = load(async () => {
                throw new Error("serveur indisponible");
            });
        }
        await expect(mount(Comp, document.createElement("div"))).rejects.toThrow("serveur indisponible");
    });

    test("l'AbortSignal est déclenché si le composant est détruit pendant le chargement", async () => {
        let signal: AbortSignal | null = null;
        class Child extends Component {
            static template = xml`<p>{{ data }}</p>`;
            @resource accessor data = load(({ signal: s }) => {
                signal = s;
                return new Promise<string>(() => {});
            });
        }
        class Host extends Component {
            static template = xml`<div><Child t-if="show"/></div>`;
            static components = { Child };
            @state accessor show = false;
        }
        const { component } = await render(Host);
        component.show = true;
        await settle();
        expect(signal).not.toBeNull();
        component.show = false;
        await settle();
        expect(signal!.aborted).toBe(true);
    });
});

describe("<Suspense>", () => {
    test("affiche le fallback, puis le contenu ; ne bloque pas le reste", async () => {
        const stats = deferred<number>();
        class Stats extends Component {
            static template = xml`<b>{{ total }}</b>`;
            @resource accessor total = load(() => stats.promise);
        }
        class Page extends Component {
            static template = xml`
                <div>
                    <h1>Titre</h1>
                    <Suspense>
                        <t t-set-slot="fallback"><i>chargement</i></t>
                        <Stats/>
                    </Suspense>
                </div>`;
            static components = { Stats };
        }
        const { html } = await render(Page);
        expect(html()).toBe("<div><h1>Titre</h1><i>chargement</i></div>");
        stats.resolve(12);
        await settle();
        expect(html()).toBe("<div><h1>Titre</h1><b>12</b></div>");
    });

    /** Une vue dont les lignes dépendent de colonnes chargées à part (la source attend une ressource). */
    function viewWithSourcedRows(arch: Promise<string>, rows: Promise<string[]>) {
        return class Rows extends Component {
            static template = xml`<div><h2>Vue</h2><Suspense><t t-set-slot="fallback"><i>attente</i></t><p>{{ records.join("-") }}</p></Suspense></div>`;
            @resource accessor arch = load(() => arch);
            @computed get columns(): string[] {
                return this.arch === undefined ? [] : this.arch.split(",");
            }
            @resource accessor records = load(
                () => this.columns,
                (columns) => rows.then((values) => values.map((value) => `${value}:${columns.length}`)),
            );
        };
    }

    test("une ressource dont la source attend : le fallback s'affiche au changement de vue (t-key)", async () => {
        const arch = deferred<string>();
        const rows = deferred<string[]>();
        class Before extends Component {
            static template = xml`<p>avant</p>`;
        }
        const After = viewWithSourcedRows(arch.promise, rows.promise);
        class Page extends Component {
            static template = xml`<section><t t-component="view" t-key="kind"/></section>`;
            @state accessor kind = "before";
            get view() {
                return this.kind === "before" ? Before : After;
            }
        }
        const { html, component } = await render(Page);
        component.kind = "after";
        await settle();
        expect(html()).toBe("<section><div><h2>Vue</h2><i>attente</i></div></section>");
        arch.resolve("a,b");
        await settle();
        expect(html()).toBe("<section><div><h2>Vue</h2><i>attente</i></div></section>");
        rows.resolve(["x", "y"]);
        await settle();
        expect(html()).toBe("<section><div><h2>Vue</h2><p>x:2-y:2</p></div></section>");
    });

    test("une ressource dont la source attend : le fallback s'affiche quand un t-if s'ouvre", async () => {
        const arch = deferred<string>();
        const rows = deferred<string[]>();
        const Rows = viewWithSourcedRows(arch.promise, rows.promise);
        class Page extends Component {
            static template = xml`<section><t t-if="shown"><Rows/></t></section>`;
            static components = { Rows };
            @state accessor shown = false;
        }
        const { html, component } = await render(Page);
        component.shown = true;
        await settle();
        expect(html()).toBe("<section><div><h2>Vue</h2><i>attente</i></div></section>");
        arch.resolve("a");
        rows.resolve(["x"]);
        await settle();
        expect(html()).toBe("<section><div><h2>Vue</h2><p>x:1</p></div></section>");
    });
});

describe("<ErrorBoundary>", () => {
    test("erreur à la construction : affiche le fallback, reset réessaie", async () => {
        let fail = true;
        class Fragile extends Component {
            static template = xml`<p>ok</p>`;
            constructor() {
                super();
                if (fail) {
                    throw new Error("cassé");
                }
            }
        }
        class Page extends Component {
            static template = xml`
                <div>
                    <ErrorBoundary>
                        <t t-set-slot="fallback" t-slot-scope="e"><span>{{ e.error.message }}</span><button t-on-click="e.reset">réessayer</button></t>
                        <Fragile/>
                    </ErrorBoundary>
                </div>`;
            static components = { Fragile };
        }
        const { html, fixture } = await render(Page);
        expect(html()).toBe("<div><span>cassé</span><button>réessayer</button></div>");
        fail = false;
        fixture.querySelector("button")!.click();
        await settle();
        expect(html()).toBe("<div><p>ok</p></div>");
    });

    test("erreur dans un gestionnaire d'événement : le contenu reste affiché (erreur d'action, voir <ErrorHandler>)", async () => {
        const errors: unknown[] = [];
        class Fragile extends Component {
            static template = xml`<button t-on-click="boom">x</button>`;
            boom() {
                throw new Error("clic");
            }
        }
        class Page extends Component {
            static template = xml`<ErrorBoundary><t t-set-slot="fallback" t-slot-scope="e">{{ e.error.message }}</t><Fragile/></ErrorBoundary>`;
            static components = { Fragile };
        }
        const { html, fixture } = await render(Page, { onError: (e) => errors.push(e) });
        fixture.querySelector("button")!.click();
        await settle();
        expect(html()).toBe("<button>x</button>");
        expect(String(errors[0])).toMatch(/clic/);
    });

    test("erreur de chargement d'une ressource", async () => {
        class Fragile extends Component {
            static template = xml`<p>{{ data }}</p>`;
            @resource accessor data = load(async () => {
                throw new Error("404");
            });
        }
        class Page extends Component {
            static template = xml`<div><ErrorBoundary><t t-set-slot="fallback" t-slot-scope="e">KO {{ e.error.message }}</t><Suspense><Fragile/></Suspense></ErrorBoundary></div>`;
            static components = { Fragile };
        }
        const { html } = await render(Page);
        await settle();
        expect(html()).toBe("<div>KO 404</div>");
    });
});

describe("<Portal>", () => {
    test("insère le contenu dans la cible, le retire à la destruction", async () => {
        const target = document.createElement("div");
        target.id = "portal-target";
        document.body.appendChild(target);
        class Modal extends Component {
            static template = xml`<div><p>page</p><Portal target="'#portal-target'"><span>{{ text }}</span></Portal></div>`;
            @state accessor text = "modale";
        }
        const { html, root, component } = await render(Modal);
        expect(html()).toBe("<div><p>page</p></div>");
        expect(target.innerHTML).toBe("<span>modale</span>");
        component.text = "maj";
        await nextTick();
        expect(target.innerHTML).toBe("<span>maj</span>");
        root.destroy();
        expect(target.innerHTML).toBe("");
        target.remove();
    });
});
