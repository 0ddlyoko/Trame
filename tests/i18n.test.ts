import { afterEach, describe, expect, test } from "vitest";
import { _t, Component, setTranslator, xml } from "../src/index";
import { render } from "./helpers";

const fr: Record<string, string> = { Save: "Enregistrer", Search: "Rechercher", Total: "Total TTC", Hello: "Bonjour" };

describe("traductions", () => {
    afterEach(() => setTranslator(null));

    test("textes statiques et attributs traduisibles", async () => {
        setTranslator((text) => fr[text] ?? text);
        class Form extends Component {
            static template = xml`
                <div>
                    <button title="Save">Save</button>
                    <input placeholder="Search" name="Search"/>
                    <p>Total : {{ amount }}</p>
                </div>`;
            amount = "12 €";
        }
        const { html } = await render(Form);
        expect(html()).toBe('<div><button title="Enregistrer">Enregistrer</button><input placeholder="Rechercher" name="Search"><p>Total : 12 €</p></div>');
    });

    test("t-translation=off et _t dans les expressions", async () => {
        setTranslator((text) => fr[text] ?? text);
        class Page extends Component {
            static template = xml`<div><span t-translation="off">Save</span><b>{{ _t('Hello') }}</b></div>`;
        }
        const { html } = await render(Page);
        expect(html()).toBe("<div><span>Save</span><b>Bonjour</b></div>");
        expect(_t("Save")).toBe("Enregistrer");
    });

    test("les blancs autour et les textes sans lettres ne sont pas envoyés au traducteur", async () => {
        const seen: string[] = [];
        setTranslator((text) => {
            seen.push(text);
            return text.toUpperCase();
        });
        class Page extends Component {
            static template = xml`<p><b> Hello </b><i>12,5 %</i></p>`;
        }
        const { html } = await render(Page);
        expect(html()).toBe("<p><b> HELLO </b><i>12,5 %</i></p>");
        expect(seen).toEqual(["Hello"]);
    });
});
