// Non-régression : points soulevés par la revue de code (un bloc describe par point).
import { describe, expect, test, vi } from "vitest";
import { Component, effect, extendTemplate, inheritTemplate, inject, load, mount, props, provide, resource, state, t, xml } from "../src/index";
import { nextTick, patch } from "../src/index";
import { render, settle } from "./helpers";

describe("gestionnaires d'événements : erreurs asynchrones", () => {
    const forms = [
        ["méthode", `t-on-click="save"`],
        ["appel avec argument", `t-on-click="save(1)"`],
        ["fonction fléchée", `t-on-click="(ev) => save(ev)"`],
        ["fonction fléchée à bloc", `t-on-click="(ev) => { return save(ev); }"`],
        ["instruction suivie d'un appel", `t-on-click="count = count + 1, save(count)"`],
    ] as const;

    for (const [label, attr] of forms) {
        test(`${label} : le rejet de la promesse atteint l'<ErrorHandler>`, async () => {
            class Child extends Component {
                static template = xml`<button ${attr}>x</button>`;
                @state accessor count = 0;
                async save(_arg?: unknown) {
                    throw new Error("échec de l'enregistrement");
                }
            }
            const received: string[] = [];
            class Parent extends Component {
                static template = xml`<div><ErrorHandler onError="(e) => received.push(e.message)"><Child/></ErrorHandler></div>`;
                static components = { Child };
                received = received;
            }
            const { fixture } = await render(Parent);
            (fixture.querySelector("button") as HTMLButtonElement).click();
            await settle();
            expect(received).toEqual(["échec de l'enregistrement"]);
            expect(fixture.querySelector("button")).not.toBeNull();
        });
    }
});

describe("props : même objet en dev et en prod (pas de Proxy de lecture seule)", () => {
    for (const dev of [true, false]) {
        const mode = dev ? "dev" : "prod";

        test(`${mode} : l'enfant reçoit l'objet même du parent (identité conservée)`, async () => {
            class Line {
                price = 1;
            }
            let received: unknown;
            class Child extends Component {
                static template = xml`<span>{{ props.line.price }}</span>`;
                props = props({ line: t.instanceOf(Line), lines: t.array() });
                constructor() {
                    super();
                    received = this.props.line;
                }
            }
            class Parent extends Component {
                static template = xml`<Child line="lines[0]" lines="lines"/>`;
                static components = { Child };
                lines = [new Line()];
            }
            const { component } = await render(Parent, { dev });
            expect(received).toBe(component.lines[0]);
        });

        test(`${mode} : une Map et un Set passés en props sont utilisables`, async () => {
            class Child extends Component {
                static template = xml`<span>{{ props.m.get("a") }}-{{ props.s.has(2) }}-{{ props.m.size }}</span>`;
                props = props({ m: t.instanceOf(Map), s: t.instanceOf(Set) });
            }
            class Parent extends Component {
                static template = xml`<Child m="m" s="s"/>`;
                static components = { Child };
                m = new Map([["a", 1]]);
                s = new Set([2]);
            }
            const { html } = await render(Parent, { dev });
            expect(html()).toBe("<span>1-true-1</span>");
        });

        test(`${mode} : une méthode qui lit un champ #privé fonctionne`, async () => {
            class Money {
                #cents = 1234;
                label() {
                    return (this.#cents / 100).toFixed(2);
                }
            }
            class Child extends Component {
                static template = xml`<span>{{ props.amount.label() }}</span>`;
                props = props({ amount: t.instanceOf(Money) });
            }
            class Parent extends Component {
                static template = xml`<Child amount="amount"/>`;
                static components = { Child };
                amount = new Money();
            }
            const { html } = await render(Parent, { dev });
            expect(html()).toBe("<span>12.34</span>");
        });
    }
});

describe("expressions : vrai parseur (portées JavaScript)", () => {
    test("variables et fonctions déclarées dans un gestionnaire", async () => {
        class C extends Component {
            static template = xml`<div>
                <button t-on-click="() => { const step = 2; let total = 0; for (const n of [1, 2]) { total += n * step; } count = total; }">+</button>
                <span>{{ count }}</span>
                <ul><li t-foreach="items.filter(function (it) { return it.ok; })" t-as="it" t-key="it.id">{{ it.id }}</li></ul>
            </div>`;
            @state accessor count = 0;
            items = [
                { id: 1, ok: true },
                { id: 2, ok: false },
            ];
        }
        const { fixture } = await render(C);
        (fixture.querySelector("button") as HTMLButtonElement).click();
        expect(fixture.querySelector("span")!.textContent).toBe("6");
        expect(fixture.querySelector("ul")!.innerHTML).toBe("<li>1</li>");
    });

    test("une erreur de syntaxe indique le template et l'expression", async () => {
        class C extends Component {
            static template = xml`<div>{{ a + }}</div>`;
        }
        await expect(render(C)).rejects.toThrow(/template "C".*a \+/s);
    });
});

describe("héritage de templates : une extension de la base atteint les dérivés déjà compilés", () => {
    test("inheritTemplate, sur deux niveaux", async () => {
        class Base extends Component {
            static template = xml`<div><h1>base</h1></div>`;
        }
        class Derived extends Component {
            static template = inheritTemplate(Base, `<xpath expr="//h1" position="after"><p>dérivé</p></xpath>`);
        }
        class Derived2 extends Component {
            static template = inheritTemplate(Derived, `<xpath expr="//p" position="after"><span>2</span></xpath>`);
        }
        expect((await render(Derived)).html()).toBe("<div><h1>base</h1><p>dérivé</p></div>");
        expect((await render(Derived2)).html()).toBe("<div><h1>base</h1><p>dérivé</p><span>2</span></div>");

        extendTemplate(Base, `<xpath expr="//h1" position="before"><i>ext</i></xpath>`);
        expect((await render(Base)).html()).toBe("<div><i>ext</i><h1>base</h1></div>");
        expect((await render(Derived)).html()).toBe("<div><i>ext</i><h1>base</h1><p>dérivé</p></div>");
        expect((await render(Derived2)).html()).toBe("<div><i>ext</i><h1>base</h1><p>dérivé</p><span>2</span></div>");
    });
});

describe("objets créés après la construction : rattachés au bon scope", () => {
    /** Modèle avec une requête qui ne se termine jamais et un effet : on observe leur nettoyage. */
    function makeModel(log: string[]) {
        let n = 0;
        return class Model {
            readonly id = ++n;
            @state accessor tick = 0;
            @resource accessor data = load(({ signal }) => {
                signal.addEventListener("abort", () => log.push(`abort ${this.id}`));
                return new Promise<number>(() => {});
            });
            @effect watch() {
                void this.tick;
                log.push(`effet ${this.id}`);
                return () => log.push(`nettoyage ${this.id}`);
            }
        };
    }

    test("créé dans un gestionnaire d'événement : nettoyé à la destruction du composant", async () => {
        const log: string[] = [];
        const Model = makeModel(log);
        class C extends Component {
            static template = xml`<button t-on-click="make">+</button>`;
            model: InstanceType<typeof Model> | null = null;
            make() {
                this.model = new Model();
                void this.model.data;
            }
        }
        const r = await render(C);
        (r.fixture.querySelector("button") as HTMLButtonElement).click();
        await settle();
        expect(log).toEqual(["effet 1"]);
        r.destroy();
        expect(log).toEqual(["effet 1", "nettoyage 1", "abort 1"]);
        // L'effet du modèle ne tourne plus après la destruction.
        r.component.model!.tick++;
        await settle();
        expect(log).toEqual(["effet 1", "nettoyage 1", "abort 1"]);
    });

    test("créé dans un @effect : nettoyé à chaque nouvelle exécution de l'effet et à la destruction", async () => {
        const log: string[] = [];
        const Model = makeModel(log);
        class C extends Component {
            static template = xml`<p>{{ n }}</p>`;
            @state accessor n = 0;
            @effect create() {
                void this.n;
                const model = new Model();
                void model.data;
            }
        }
        const r = await render(C);
        await settle();
        expect(log).toEqual(["effet 1"]);
        r.component.n++;
        await settle();
        expect(log).toEqual(["effet 1", "nettoyage 1", "abort 1", "effet 2"]);
        r.destroy();
        expect(log).toEqual(["effet 1", "nettoyage 1", "abort 1", "effet 2", "nettoyage 2", "abort 2"]);
    });
});

describe("t-foreach sans t-key : valeurs en double acceptées", () => {
    test("primitives en double, puis réordonnées", async () => {
        class C extends Component {
            static template = xml`<p><span t-foreach="tags" t-as="tag">{{ tag }}{{ tag_index }}</span></p>`;
            @state accessor tags = ["a", "a", "b"];
        }
        const { component, html } = await render(C);
        expect(html()).toBe("<p><span>a0</span><span>a1</span><span>b2</span></p>");
        component.tags = ["b", "a", "a", "a"];
        await nextTick();
        expect(html()).toBe("<p><span>b0</span><span>a1</span><span>a2</span><span>a3</span></p>");
        component.tags = ["a"];
        await nextTick();
        expect(html()).toBe("<p><span>a0</span></p>");
    });

    test("un même objet présent deux fois : les lignes existantes sont conservées", async () => {
        const x = { v: "x" };
        const y = { v: "y" };
        class C extends Component {
            static template = xml`<p><span t-foreach="items" t-as="it">{{ it.v }}</span></p>`;
            @state accessor items = [x, x, y];
        }
        const { component, fixture, html } = await render(C);
        const spans = Array.from(fixture.querySelectorAll("span"));
        component.items = [y, x, x];
        await nextTick();
        expect(html()).toBe("<p><span>y</span><span>x</span><span>x</span></p>");
        const after = Array.from(fixture.querySelectorAll("span"));
        expect(after[0]).toBe(spans[2]);
        expect(after.slice(1)).toEqual(spans.slice(0, 2));
    });
});

describe("macros loading / error / refresh et membres du composant", () => {
    test("une méthode du composant portant le nom d'une macro l'emporte", async () => {
        const calls: unknown[] = [];
        class C extends Component {
            static template = xml`<button t-on-click="refresh(42)">x</button>`;
            refresh(id: number) {
                calls.push(id);
            }
        }
        const { fixture } = await render(C);
        (fixture.querySelector("button") as HTMLButtonElement).click();
        expect(calls).toEqual([42]);
    });

    test("un champ (non fonction) portant le nom d'une macro laisse la macro fonctionner", async () => {
        let resolve!: (v: string) => void;
        class C extends Component {
            static template = xml`<div><p>{{ loading(data) ? "chargement" : "prêt" }}</p><i>{{ loading }}</i></div>`;
            @state accessor loading = "champ";
            @resource accessor data = load(() => new Promise<string>((r) => (resolve = r)), { eager: true });
        }
        const { html } = await render(C);
        expect(html()).toBe("<div><p>chargement</p><i>champ</i></div>");
        resolve("ok");
        await settle();
        expect(html()).toBe("<div><p>prêt</p><i>champ</i></div>");
    });
});

describe("patch() : pas de coût par appel une fois l'instance initialisée", () => {
    test("un membre patché ne reparcourt pas la chaîne de prototypes à chaque appel", () => {
        class Line {
            price = 2;
            total() {
                return this.price;
            }
        }
        const unpatch = patch(
            Line,
            class extends Line {
                @state accessor tax = 1;
                override total() {
                    return super.total() + this.tax;
                }
            },
        );
        try {
            const line = new Line();
            expect(line.total()).toBe(3); // initialise les champs du patch
            const spy = vi.spyOn(Object, "getPrototypeOf");
            let sum = 0;
            for (let i = 0; i < 1000; i++) {
                sum += line.total();
            }
            const calls = spy.mock.calls.length;
            spy.mockRestore();
            expect(sum).toBe(3000);
            expect(calls).toBe(0);
        } finally {
            unpatch();
        }
    });

    test("un patch appliqué après l'initialisation d'une instance est tout de même initialisé", () => {
        class Item {
            name = "a";
            label() {
                return this.name;
            }
        }
        const unpatch1 = patch(
            Item,
            class extends Item {
                @state accessor suffix = "!";
                override label() {
                    return super.label() + this.suffix;
                }
            },
        );
        const item = new Item();
        expect(item.label()).toBe("a!");
        const unpatch2 = patch(
            Item,
            class extends Item {
                @state accessor prefix = "> ";
                override label() {
                    return this.prefix + super.label();
                }
            },
        );
        try {
            expect(item.label()).toBe("> a!");
        } finally {
            unpatch2();
            unpatch1();
        }
    });
});

describe("services : règles de fourniture", () => {
    class Service {
        name() {
            return "service";
        }
    }
    class Rpc extends Service {
        override name() {
            return "rpc";
        }
    }
    class Orm extends Service {
        override name() {
            return "orm";
        }
    }

    function consumer<T>(key: abstract new (...args: never[]) => T, read: (svc: T) => string) {
        return class Consumer extends Component {
            static template = xml`<i>{{ value }}</i>`;
            @inject(key) svc!: T;
            get value() {
                return read(this.svc);
            }
        };
    }

    test("le même service fourni deux fois au même niveau : erreur", async () => {
        const Consumer = consumer(Rpc, (s) => s.name());
        await expect(mount(Consumer, document.createElement("div"), { provide: [Rpc, Rpc] })).rejects.toThrow(/Rpc.*fourni deux fois/);
        await expect(mount(Consumer, document.createElement("div"), { provide: [Rpc, new Rpc()] })).rejects.toThrow(/Rpc.*fourni deux fois/);
        class Twice extends Component {
            static template = xml`<i/>`;
            @provide a = new Rpc();
            @provide b = new Rpc();
        }
        await expect(mount(Twice, document.createElement("div"))).rejects.toThrow(/Rpc.*fourni deux fois/);
    });

    test("un enfant qui fournit à nouveau un service le redéfinit pour ses descendants", async () => {
        class Special extends Rpc {
            override name() {
                return "special";
            }
        }
        const Consumer = consumer(Rpc, (s) => s.name());
        class Middle extends Component {
            static template = xml`<Consumer/>`;
            static components = { Consumer };
            @provide(Rpc) rpc = new Special();
        }
        class Root extends Component {
            static template = xml`<div><Consumer/><Middle/></div>`;
            static components = { Consumer, Middle };
        }
        const { html } = await render(Root, { provide: [Rpc] });
        expect(html()).toBe("<div><i>rpc</i><i>special</i></div>");
    });

    test("deux services différents d'une même classe parente : injecter la parente est ambigu", async () => {
        const ByBase = consumer(Service, (s) => s.name());
        const ByRpc = consumer(Rpc, (s) => s.name());
        const ByOrm = consumer(Orm, (s) => s.name());
        await expect(mount(ByBase, document.createElement("div"), { provide: [Rpc, new Orm()] })).rejects.toThrow(
            /inject\(Service\).*ambigu.*Rpc.*Orm/,
        );
        class Both extends Component {
            static template = xml`<div><ByRpc/><ByOrm/></div>`;
            static components = { ByRpc, ByOrm };
        }
        const { html } = await render(Both, { provide: [Rpc, new Orm()] });
        expect(html()).toBe("<div><i>rpc</i><i>orm</i></div>");
    });

    test("la classe exacte l'emporte sur une classe parente fournie au même niveau", async () => {
        class Special extends Rpc {
            override name() {
                return "special";
            }
        }
        const ByRpc = consumer(Rpc, (s) => s.name());
        const { html } = await render(ByRpc, { provide: [new Special(), Rpc] });
        expect(html()).toBe("<i>rpc</i>");
    });

    test("un service patché garde son comportement patché une fois injecté", async () => {
        class Greeter {
            hello() {
                return "bonjour";
            }
        }
        const unpatch = patch(Greeter, {
            hello() {
                return super.hello() + " !";
            },
        });
        try {
            const Consumer = consumer(Greeter, (g) => g.hello());
            const { html } = await render(Consumer, { provide: [Greeter] });
            expect(html()).toBe("<i>bonjour !</i>");
        } finally {
            unpatch();
        }
    });

    test("dépendance circulaire entre services : erreur claire", async () => {
        class Base {}
        class A {
            @inject(Base) base!: Base;
        }
        class B extends Base {
            @inject(A) a!: A;
        }
        const Consumer = consumer(A, () => "a");
        await expect(mount(Consumer, document.createElement("div"), { provide: [A, B] })).rejects.toThrow(/circulaire.*A → B → A/);
    });
});

describe("load(source, fetcher) : dépendances explicites", () => {
    test("seule la source est suivie ; sa valeur est passée au fetcher", async () => {
        const calls: string[] = [];
        class C extends Component {
            static template = xml`<p>{{ data }}</p>`;
            @state accessor id = 1;
            @state accessor filter = "a";
            @resource accessor data = load(
                () => this.id,
                async (id) => {
                    // Lu dans le fetcher (avant et après un await) : pas une dépendance.
                    const f = this.filter;
                    await Promise.resolve();
                    calls.push(`${id}/${f}/${this.filter}`);
                    return `r${id}`;
                },
            );
        }
        const { component, html } = await render(C);
        expect(html()).toBe("<p>r1</p>");
        component.filter = "b";
        await settle();
        expect(calls).toEqual(["1/a/a"]);
        component.id = 2;
        await settle();
        expect(html()).toBe("<p>r2</p>");
        expect(calls).toEqual(["1/a/a", "2/b/b"]);
    });

    test("la valeur utilisée après un await est celle de la source (pas de requête oubliée)", async () => {
        const seen: number[] = [];
        class C extends Component {
            static template = xml`<p>{{ data }}</p>`;
            @state accessor page = 1;
            @resource accessor data = load(
                () => this.page,
                async (page) => {
                    await Promise.resolve();
                    seen.push(page);
                    return page * 10;
                },
            );
        }
        const { component, html } = await render(C);
        component.page = 3;
        await settle();
        expect(html()).toBe("<p>30</p>");
        expect(seen).toEqual([1, 3]);
    });

    test("une source qui lit une donnée pas encore chargée attend avant d'appeler le fetcher", async () => {
        const fetched: number[] = [];
        let resolveOrder!: (v: { partnerId: number }) => void;
        class C extends Component {
            static template = xml`<p>{{ partner }}</p>`;
            @resource accessor order = load(() => new Promise<{ partnerId: number }>((r) => (resolveOrder = r)));
            @resource accessor partner = load(
                () => this.order.partnerId,
                (id) => {
                    fetched.push(id);
                    return `partenaire ${id}`;
                },
            );
        }
        const fixture = document.createElement("div");
        const mounted = mount(C, fixture);
        await settle();
        expect(fetched).toEqual([]);
        resolveOrder({ partnerId: 7 });
        const root = await mounted;
        expect(fixture.innerHTML).toBe("<p>partenaire 7</p>");
        expect(fetched).toEqual([7]);
        root.destroy();
    });

    test("le signal d'annulation est transmis au fetcher", async () => {
        const aborted: number[] = [];
        class C extends Component {
            static template = xml`<p>{{ data }}</p>`;
            @state accessor id = 1;
            @resource accessor data = load(
                () => this.id,
                (id, { signal }) =>
                    new Promise<string>((resolve) => {
                        signal.addEventListener("abort", () => aborted.push(id));
                        if (id === 1) {
                            resolve("un");
                        }
                    }),
            );
        }
        const { component, destroy } = await render(C);
        component.id = 2;
        await settle();
        component.id = 3;
        await settle();
        destroy();
        expect(aborted).toEqual([2, 3]);
    });
});

describe("autres corrections", () => {
    test("une prop inconnue nommée comme une propriété d'Object (toString, constructor) est signalée", async () => {
        class Child extends Component {
            static template = xml`<i/>`;
            props = props({ value: t.number() });
        }
        class Parent extends Component {
            static template = xml`<Child value="1" toString="2"/>`;
            static components = { Child };
        }
        await expect(render(Parent)).rejects.toThrow(/Prop inconnue "toString"/);
    });

    test(".delegate fonctionne dans un Shadow DOM", async () => {
        const clicks: string[] = [];
        class C extends Component {
            static template = xml`<div><button class="b" t-on-click.delegate="() => hit('bouton')">x</button></div>`;
            hit(what: string) {
                clicks.push(what);
            }
        }
        const host = document.createElement("div");
        document.body.appendChild(host);
        const shadowRoot = host.attachShadow({ mode: "open" });
        const container = document.createElement("div");
        shadowRoot.appendChild(container);
        const root = await mount(C, container);
        try {
            (container.querySelector(".b") as HTMLButtonElement).click();
            expect(clicks).toEqual(["bouton"]);
        } finally {
            root.destroy();
            host.remove();
        }
    });

    test("t-foreach sur une chaîne : un caractère par ligne", async () => {
        class C extends Component {
            static template = xml`<p><b t-foreach="word" t-as="ch">{{ ch }}</b></p>`;
            word = "aba";
        }
        const { html } = await render(C);
        expect(html()).toBe("<p><b>a</b><b>b</b><b>a</b></p>");
    });
});
