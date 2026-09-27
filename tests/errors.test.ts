// Localisation des erreurs dans les templates.
import { afterEach, describe, expect, test } from "vitest";
import { Component, type ComponentClass, extendTemplate, mount, state, xml } from "../src/index";
import { cleanup, click, render } from "../src/testing";

afterEach(cleanup);

type Located = Error & { trameLocation?: string };

async function captureErrors<C extends Component>(Ctor: ComponentClass<C>, dev = true) {
    const errors: Located[] = [];
    const rendered = await render(Ctor, { dev, onError: (e) => errors.push(e as Located) });
    return { errors, ...rendered };
}

describe("erreurs localisées (mode dev)", () => {
    test("erreur dans une liaison {{ }} : template, ligne et expression", async () => {
        class Price extends Component {
            static template = xml`
                <div>
                    <p>{{ amount.toFixed(2) }}</p>
                </div>`;
            @state accessor amount: number | null = 1;
        }
        const { errors, component } = await captureErrors(Price);
        component.amount = null;
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        expect(errors).toHaveLength(1);
        const error = errors[0];
        expect(error.trameLocation).toBe('template "Price", ligne 3 : {{ amount.toFixed(2) }}');
        // Le message n'est pas modifié ; la pile d'appels (affichée par la console) contient la localisation.
        expect(error.message).not.toContain("template");
        expect(error.stack).toContain('→ template "Price", ligne 3 : {{ amount.toFixed(2) }}');
    });

    test("erreur dans un attribut dynamique", async () => {
        class Link extends Component {
            static template = xml`<a t-att-href="target.url">x</a>`;
            @state accessor target: { url: string } | null = { url: "/" };
        }
        const { errors, component } = await captureErrors(Link);
        component.target = null;
        await new Promise((r) => setTimeout(r, 0));
        expect(errors[0].trameLocation).toBe('template "Link", ligne 1 : t-att-href="target.url"');
    });

    test("erreur dans un gestionnaire d'événement", async () => {
        class Btn extends Component {
            static template = xml`<button t-on-click.prevent="save">x</button>`;
            save() {
                throw new Error("échec");
            }
        }
        const { errors, fixture } = await captureErrors(Btn);
        await click("button", fixture);
        expect(errors[0].message).toBe("échec");
        expect(errors[0].trameLocation).toBe('template "Btn", ligne 1 : t-on-click.prevent="save"');
    });

    test("composant non déclaré : localisé sur la balise", async () => {
        class Page extends Component {
            static template = xml`<div>
                <Missing/>
            </div>`;
        }
        const fixture = document.createElement("div");
        const error = (await mount(Page, fixture, { dev: true }).catch((e) => e)) as Located;
        expect(error.message).toMatch(/Composant <Missing> introuvable/);
        expect(error.trameLocation).toBe('template "Page", ligne 2 : <Missing>');
    });

    test("erreur venant d'une extension de template : l'origine est indiquée", async () => {
        class Card extends Component {
            static template = xml`<div class="card"><h1>Titre</h1></div>`;
            @state accessor data: { x: number } | null = { x: 1 };
        }
        extendTemplate(Card, `<xpath expr="//h1" position="after">\n<p>{{ data.x }}</p></xpath>`);
        const { errors, component } = await captureErrors(Card);
        component.data = null;
        await new Promise((r) => setTimeout(r, 0));
        expect(errors[0].trameLocation).toBe('template "Card" (extension n°1), ligne 2 : {{ data.x }}');
    });

    test("erreur de syntaxe dans une expression : ligne indiquée à la compilation", async () => {
        class Bad extends Component {
            static template = xml`<div>
                <p>{{ 'non fermée }}</p>
            </div>`;
        }
        await expect(mount(Bad, document.createElement("div"))).rejects.toThrow(/template "Bad", ligne 2 : Chaîne non fermée/);
    });

    test("en production (dev: false) : pas de localisation ajoutée", async () => {
        class Price extends Component {
            static template = xml`<p>{{ amount.toFixed(2) }}</p>`;
            @state accessor amount: number | null = 1;
        }
        const { errors, component } = await captureErrors(Price, false);
        component.amount = null;
        await new Promise((r) => setTimeout(r, 0));
        expect(errors).toHaveLength(1);
        expect(errors[0].trameLocation).toBeUndefined();
    });
});
