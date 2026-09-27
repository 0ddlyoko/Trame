// @computed({ eager: true }) : valeur (et données lues) préchargée, même si rien ne l'affiche.
import { describe, expect, test } from "vitest";
import { Component, computed, load, mount, resource, state, xml } from "../src/index";
import { deferred, render, settle } from "./helpers";

interface Partner {
    name: string;
}

describe("@computed({ eager: true }) : préchargement", () => {
    test("les données lues sont chargées même si la valeur n'est affichée que dans un t-if fermé", async () => {
        const fetched: number[] = [];
        class C extends Component {
            static template = xml`<div><p t-if="show">{{ label }}</p></div>`;
            @state accessor show = false;
            @state accessor partnerId = 1;
            @resource accessor partner = load(
                () => this.partnerId,
                async (id): Promise<Partner> => {
                    fetched.push(id);
                    return { name: `partenaire ${id}` };
                },
            );
            @computed({ eager: true }) get label() {
                return this.partner?.name.toUpperCase();
            }
        }
        const { component, html } = await render(C);
        await settle();
        expect(fetched).toEqual([1]);
        expect(html()).toBe("<div></div>");

        // Déjà chargé : la branche s'affiche sans nouvelle requête.
        component.show = true;
        await settle();
        expect(html()).toBe("<div><p>PARTENAIRE 1</p></div>");
        expect(fetched).toEqual([1]);
    });

    test("reste à jour : une dépendance modifiée relance le chargement, même caché", async () => {
        const fetched: number[] = [];
        class C extends Component {
            static template = xml`<div><p t-if="show">{{ label }}</p></div>`;
            @state accessor show = false;
            @state accessor partnerId = 1;
            @resource accessor partner = load(
                () => this.partnerId,
                async (id): Promise<Partner> => {
                    fetched.push(id);
                    return { name: `p${id}` };
                },
            );
            @computed({ eager: true }) get label() {
                return this.partner?.name;
            }
        }
        const { component, html } = await render(C);
        await settle();
        component.partnerId = 2;
        await settle();
        expect(fetched).toEqual([1, 2]);
        component.show = true;
        await settle();
        expect(html()).toBe("<div><p>p2</p></div>");
        expect(fetched).toEqual([1, 2]);
    });

    test("ne retarde pas l'affichage du composant", async () => {
        const slow = deferred<Partner>();
        class C extends Component {
            static template = xml`<div>prêt<p t-if="show">{{ label }}</p></div>`;
            @state accessor show = false;
            @resource accessor partner = load(() => slow.promise);
            @computed({ eager: true }) get label() {
                return this.partner?.name;
            }
        }
        const fixture = document.createElement("div");
        const root = await mount(C, fixture);
        expect(fixture.innerHTML).toBe("<div>prêt</div>");
        root.destroy();
    });

    test("une erreur pendant le préchargement n'atteint ni onError ni l'affichage", async () => {
        const errors: unknown[] = [];
        class C extends Component {
            static template = xml`<div>ok<p t-if="show">{{ broken }}</p></div>`;
            @state accessor show = false;
            @computed({ eager: true }) get broken(): string {
                throw new Error("préchargement");
            }
        }
        const { html } = await render(C, { onError: (e) => errors.push(e) });
        await settle();
        expect(errors).toEqual([]);
        expect(html()).toBe("<div>ok</div>");
    });

    test("arrêté à la destruction du composant", async () => {
        const fetched: number[] = [];
        let component!: { partnerId: number };
        class C extends Component {
            static template = xml`<div/>`;
            @state accessor partnerId = 1;
            @resource accessor partner = load(
                () => this.partnerId,
                async (id) => {
                    fetched.push(id);
                    return id;
                },
            );
            @computed({ eager: true }) get value() {
                return this.partner;
            }
        }
        const r = await render(C);
        component = r.component;
        await settle();
        r.destroy();
        component.partnerId = 2;
        await settle();
        expect(fetched).toEqual([1]);
    });

    test("fonctionne dans une classe quelconque (modèle)", async () => {
        const fetched: string[] = [];
        class Order {
            @resource accessor lines = load(async () => {
                fetched.push("lines");
                return [1, 2, 3];
            });
            @computed({ eager: true }) get count() {
                return this.lines?.length ?? 0;
            }
        }
        const order = new Order();
        await settle();
        expect(fetched).toEqual(["lines"]);
        expect(order.count).toBe(3);
    });

    test("sans eager, un @computed reste paresseux", async () => {
        const fetched: number[] = [];
        class C extends Component {
            static template = xml`<div><p t-if="show">{{ label }}</p></div>`;
            @state accessor show = false;
            @resource accessor partner = load(async () => {
                fetched.push(1);
                return { name: "p" };
            });
            @computed get label() {
                return this.partner?.name;
            }
        }
        await render(C);
        await settle();
        expect(fetched).toEqual([]);
    });
});
