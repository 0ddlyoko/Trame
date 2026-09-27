// Optimisations : le comportement doit rester identique, avec moins d'objets créés.
import { describe, expect, test } from "vitest";
import { Component, effect, inject, nextTick, patch, props, provide, state, t, xml } from "../src/index";
import { Effect } from "../src/reactivity/core";
import { Owner } from "../src/reactivity/owner";
import { ownerOf } from "../src/runtime/component";
import { render } from "./helpers";

describe("props : schéma partagé par classe", () => {
    test("les validateurs sans paramètre et instanceOf(C) sont partagés", () => {
        class Line {}
        expect(t.string()).toBe(t.string());
        expect(t.number()).toBe(t.number());
        expect(t.boolean()).toBe(t.boolean());
        expect(t.func()).toBe(t.func());
        expect(t.any()).toBe(t.any());
        expect(t.array()).toBe(t.array());
        expect(t.object()).toBe(t.object());
        expect(t.instanceOf(Line)).toBe(t.instanceOf(Line));
        // Les variantes restent des validateurs distincts, sans modifier l'original.
        expect(t.string().optional()).not.toBe(t.string());
        expect(t.string().check(undefined)).not.toBeNull();
    });

    test("this.props garde le même comportement : clés, décomposition, JSON, in, défauts, lecture seule", async () => {
        let view!: Record<string, unknown>;
        class Child extends Component {
            static template = xml`<i>{{ props.label }}-{{ props.size }}</i>`;
            props = props({ label: t.string(), size: t.number().default(3), extra: t.string().optional() });
            constructor() {
                super();
                view = this.props as unknown as Record<string, unknown>;
            }
        }
        class Parent extends Component {
            static template = xml`<Child label="label"/>`;
            static components = { Child };
            @state accessor label = "a";
        }
        const { component, html } = await render(Parent);
        expect(html()).toBe("<i>a-3</i>");
        expect(Object.keys(view)).toEqual(["label", "size", "extra"]);
        expect({ ...view }).toEqual({ label: "a", size: 3, extra: undefined });
        expect(JSON.parse(JSON.stringify(view))).toEqual({ label: "a", size: 3 });
        expect("label" in view).toBe(true);
        expect("inconnue" in view).toBe(false);
        expect(view.inconnue).toBeUndefined();
        expect(typeof view.hasOwnProperty).toBe("function");
        expect(() => {
            view.label = "b";
        }).toThrow(/lecture seule/);
        expect(() => {
            delete view.label;
        }).toThrow(/lecture seule/);
        component.label = "b";
        await nextTick();
        expect(html()).toBe("<i>b-3</i>");
        expect(view.label).toBe("b");
    });

    test("chaque instance lit ses propres props (vue partagée par classe, pas les valeurs)", async () => {
        class Child extends Component {
            static template = xml`<i>{{ props.n }}</i>`;
            props = props({ n: t.number() });
        }
        class Parent extends Component {
            static template = xml`<p><Child n="1"/><Child n="2"/><Child t-foreach="[3, 4]" t-as="k" t-key="k" n="k"/></p>`;
            static components = { Child };
        }
        const { html } = await render(Parent);
        expect(html()).toBe("<p><i>1</i><i>2</i><i>3</i><i>4</i></p>");
    });

    test("deux classes différentes gardent chacune leur schéma", async () => {
        class A extends Component {
            static template = xml`<i>{{ props.x }}</i>`;
            props = props({ x: t.number().default(1) });
        }
        class B extends Component {
            static template = xml`<b>{{ props.x }}</b>`;
            props = props({ x: t.string().default("b") });
        }
        class Parent extends Component {
            static template = xml`<p><A/><B/></p>`;
            static components = { A, B };
        }
        const { html } = await render(Parent);
        expect(html()).toBe("<p><i>1</i><b>b</b></p>");
    });
});

describe("t-foreach : lignes ajoutées après le montage", () => {
    async function mutationsWhile(target: Node, fn: () => Promise<void>) {
        const records: MutationRecord[] = [];
        const observer = new MutationObserver((list) => records.push(...list));
        observer.observe(target, { childList: true, subtree: true });
        await fn();
        records.push(...observer.takeRecords());
        observer.disconnect();
        const added = records.flatMap((r) => Array.from(r.addedNodes));
        const removed = records.flatMap((r) => Array.from(r.removedNodes));
        return { added, removed };
    }

    test("sans donnée en attente : insérées directement, sans nœud provisoire", async () => {
        class C extends Component {
            static template = xml`<ul><li t-foreach="items" t-as="it" t-key="it">{{ it }}</li></ul>`;
            @state accessor items = [1];
        }
        const { component, fixture, html } = await render(C);
        const { added, removed } = await mutationsWhile(fixture, async () => {
            component.items = [1, 2, 3, 4];
            await nextTick();
        });
        expect(html()).toBe("<ul><li>1</li><li>2</li><li>3</li><li>4</li></ul>");
        expect(removed).toEqual([]);
        expect(added.map((n) => n.nodeName)).toEqual(["LI", "LI", "LI"]);
    });

    test("l'index reste à jour après un réordonnancement", async () => {
        class C extends Component {
            static template = xml`<ul><li t-foreach="items" t-as="it" t-key="it">{{ it }}:{{ it_index }}</li></ul>`;
            @state accessor items = ["a", "b", "c"];
        }
        const { component, html } = await render(C);
        component.items = ["c", "a", "b", "d"];
        await nextTick();
        expect(html()).toBe("<ul><li>c:0</li><li>a:1</li><li>b:2</li><li>d:3</li></ul>");
    });
});

describe("t-foreach : signal d'index seulement si x_index est lu", () => {
    test("le code généré ne demande l'index que s'il est utilisé", () => {
        const without = xml`<ul><li t-foreach="items" t-as="it" t-key="it">{{ it }}</li></ul>`.getCode();
        const withIndex = xml`<ul><li t-foreach="items" t-as="it" t-key="it">{{ it_index }}</li></ul>`.getCode();
        // Dernier argument de $h.each (après la localisation L<n>) : 1 si l'index est lu.
        expect(without).toMatch(/, L\d+, 0\);/);
        expect(withIndex).toMatch(/, L\d+, 1\);/);
    });
});

describe("@state : signal créé à la première lecture suivie", () => {
    class Record {
        @state accessor name = "a";
        @state accessor qty = 1;
        @state accessor tags: string[] = ["x"];
        plain = 1;
    }

    test("aucun stockage caché sur l'instance (plus de Map par objet)", () => {
        const record = new Record();
        void record.name;
        record.qty = 2;
        expect(Object.getOwnPropertySymbols(record)).toEqual([]);
    });

    test("lectures et écritures hors suivi, puis abonnement : les mises à jour arrivent", async () => {
        const record = new Record();
        record.name = "b"; // écriture avant tout observateur
        expect(record.name).toBe("b");
        class C extends Component {
            static template = xml`<p>{{ record.name }} {{ record.qty }} {{ record.tags.length }}</p>`;
            record = record;
        }
        const { html } = await render(C);
        expect(html()).toBe("<p>b 1 1</p>");
        record.name = "c";
        record.qty = 5;
        record.tags.push("y"); // tableau réactif en profondeur
        await nextTick();
        expect(html()).toBe("<p>c 5 2</p>");
        record.qty = 5; // même valeur : rien à faire
        await nextTick();
        expect(html()).toBe("<p>c 5 2</p>");
    });

    test("un tableau affecté après coup reste réactif en profondeur", async () => {
        const record = new Record();
        record.tags = ["a"];
        class C extends Component {
            static template = xml`<p>{{ record.tags.join(",") }}</p>`;
            record = record;
        }
        const { html } = await render(C);
        record.tags.push("b");
        await nextTick();
        expect(html()).toBe("<p>a,b</p>");
    });

    test("JSON.stringify inclut les champs @state (hérités et ajoutés par patch compris)", () => {
        class Special extends Record {
            @state accessor level = 3;
        }
        const unpatch = patch(
            Special,
            class extends Special {
                @state accessor extra = true;
            },
        );
        try {
            const special = new Special();
            special.name = "z";
            void (special as Special & { extra: boolean }).extra;
            expect(JSON.parse(JSON.stringify(special))).toEqual({ plain: 1, name: "z", qty: 1, tags: ["x"], level: 3, extra: true });
        } finally {
            unpatch();
        }
    });
});

describe("Owner et Effect allégés", () => {
    test("un Effect ne porte pas les champs réservés à l'exécution ni la localisation hors mode dev", () => {
        const e = new Effect(() => {}, null);
        const keys = Object.keys(e);
        for (const field of ["trackedHead", "trackedTail", "tracking", "collectingPending", "loc", "id", "queued", "tracked", "live", "disposed"]) {
            expect(keys).not.toContain(field);
        }
        // Les états restent lisibles.
        expect(e.live).toBe(true);
        expect(e.disposed).toBe(false);
        e.dispose();
        expect(e.disposed).toBe(true);
    });

    test("un Owner ne porte les champs rares (services, erreurs, AbortController...) que s'il en a besoin", () => {
        const owner = new Owner(null);
        const keys = Object.keys(owner);
        for (const field of ["providers", "inherited", "errorHandler", "controller", "mountCallbacks"]) {
            expect(keys).not.toContain(field);
        }
        owner.provide("k", 1);
        owner.errorHandler = () => true;
        expect(owner.lookup("k")).toBe(1);
        expect(owner.errorHandler).not.toBeNull();
    });
});

describe("composant seul dans son bloc : pas de scope intermédiaire", () => {
    test("un composant seul dans une ligne utilise le scope de la ligne", async () => {
        let list!: Component;
        const rows: Component[] = [];
        class Row extends Component {
            static template = xml`<li>{{ props.n }}</li>`;
            props = props({ n: t.number() });
            constructor() {
                super();
                rows.push(this);
            }
        }
        class List extends Component {
            static template = xml`<ul><Row t-foreach="[1, 2]" t-as="n" t-key="n" n="n"/></ul>`;
            static components = { Row };
            constructor() {
                super();
                list = this;
            }
        }
        await render(List);
        // ligne → composant : un seul niveau sous le scope de la liste
        expect(ownerOf(rows[0]).parent).toBe(ownerOf(list));
    });

    test("isolation : un @provide d'un composant de ligne ne fuit pas vers les autres lignes", async () => {
        class Store {
            constructor(readonly n: number) {}
        }
        class Leaf extends Component {
            static template = xml`<i>{{ store.n }}</i>`;
            @inject(Store) store!: Store;
        }
        class Row extends Component {
            static template = xml`<li><Leaf/></li>`;
            static components = { Leaf };
            props = props({ n: t.number() });
            @provide store = new Store(this.props.n);
        }
        class List extends Component {
            static template = xml`<ul><Row t-foreach="[1, 2, 3]" t-as="n" t-key="n" n="n"/></ul>`;
            static components = { Row };
        }
        const { html } = await render(List);
        expect(html()).toBe("<ul><li><i>1</i></li><li><i>2</i></li><li><i>3</i></li></ul>");
    });

    test("nettoyage : supprimer la ligne ou fermer la branche détruit le composant", async () => {
        const log: string[] = [];
        class Child extends Component {
            static template = xml`<b>{{ props.n }}</b>`;
            props = props({ n: t.number() });
            @effect watch() {
                const n = this.props.n;
                return () => log.push(`fin ${n}`);
            }
        }
        class Parent extends Component {
            static template = xml`<div><Child t-foreach="items" t-as="n" t-key="n" n="n"/><t t-if="show"><Child n="99"/></t></div>`;
            static components = { Child };
            @state accessor items = [1, 2];
            @state accessor show = true;
        }
        const { component, html } = await render(Parent);
        await nextTick();
        component.items = [2];
        component.show = false;
        await nextTick();
        expect(log.sort()).toEqual(["fin 1", "fin 99"]);
        expect(html()).toBe("<div><b>2</b></div>");
    });

    test("une erreur dans un composant seul dans sa ligne atteint l'<ErrorBoundary>", async () => {
        class Boom extends Component {
            static template = xml`<i/>`;
            constructor() {
                super();
                throw new Error("boum");
            }
        }
        class Parent extends Component {
            static template = xml`<div><ErrorBoundary><t t-set-slot="fallback">KO</t><Boom t-foreach="[1]" t-as="n" t-key="n"/></ErrorBoundary></div>`;
            static components = { Boom };
        }
        const { html } = await render(Parent);
        expect(html()).toBe("<div>KO</div>");
    });

    test("un composant racine du template garde son propre scope (portée des @provide)", async () => {
        class Svc {}
        let parent!: Component;
        let child!: Component;
        class Child extends Component {
            static template = xml`<i/>`;
            @provide svc = new Svc();
            constructor() {
                super();
                child = this;
            }
        }
        class Parent extends Component {
            static template = xml`<Child/>`;
            static components = { Child };
            @provide svc = new Svc();
            constructor() {
                super();
                parent = this;
            }
        }
        await render(Parent); // pas d'erreur « fourni deux fois au même niveau »
        expect(ownerOf(child)).not.toBe(ownerOf(parent));
    });
});
