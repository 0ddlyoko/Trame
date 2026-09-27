// Précompilation des templates (côté serveur) et fichiers de templates.
import { afterEach, describe, expect, test } from "vitest";
import { compileTemplate, compileTemplateFiles } from "../src/compiler/index";
import { Component, props, registerCompiled, registerTemplate, registerTemplates, state, t, xml } from "../src/index";
import { templateCompiler } from "../src/runtime/compiler_setup";
import { setTemplateCompiler } from "../src/runtime/template";
import { cleanup, click, render } from "../src/testing";

afterEach(() => {
    setTemplateCompiler(templateCompiler);
    cleanup();
});

/** Exécute le module généré par compileTemplateFiles, comme le ferait le navigateur. */
function loadModule(code: string): void {
    const body = code.replace(/^import \{ registerCompiled \} from "[^"]+";/, "");
    new Function("registerCompiled", body)(registerCompiled);
}

let n = 0;
const uid = (base: string) => `${base}_${++n}`;

describe("compileTemplateFiles (précompilation côté serveur)", () => {
    test("définitions, extension d'un autre module, héritage primaire, t-call", async () => {
        const card = uid("web.Card");
        const form = uid("sale.OrderForm");
        const special = uid("sale.SpecialForm");
        const badge = uid("web.Badge");
        const files = [
            {
                path: "web/static/templates.xml",
                content: `<templates>
    <t t-name="${card}"><div class="card"><h1>{{ title }}</h1></div></t>
    <t t-name="${badge}"><span class="badge">{{ label }}</span></t>
</templates>`,
            },
            {
                path: "sale/static/order.xml",
                content: `<templates>
    <t t-name="${form}">
        <div class="o-order"><h1>{{ name }}</h1><t t-call="${badge}" label="'Nouveau'"/></div>
    </t>
    <t t-inherit="${card}">
        <xpath expr="//h1" position="after"><p class="from-sale">vente</p></xpath>
    </t>
    <t t-name="${special}" t-inherit="${form}">
        <xpath expr="//h1" position="replace"><h2>{{ name }}</h2></xpath>
    </t>
</templates>`,
            },
        ];
        const code = compileTemplateFiles(files);
        expect(code.startsWith('import { registerCompiled } from "trame";')).toBe(true);
        // Le template appelé par t-call est aussi compilé en mode « call ».
        expect(code).toMatch(new RegExp(`registerCompiled\\("${badge}", \\{ component: [\\s\\S]*?, call: `));
        expect(code).not.toContain("new Function");

        // Le navigateur n'a plus besoin du compilateur.
        setTemplateCompiler(null);
        loadModule(code);

        class Card extends Component {
            static template = card;
            title = "Titre";
        }
        class Form extends Component {
            static template = form;
            name = "SO001";
        }
        class Special extends Component {
            static template = special;
            name = "SO002";
        }
        expect((await render(Card)).html()).toBe('<div class="card"><h1>Titre</h1><p class="from-sale">vente</p></div>');
        expect((await render(Form)).html()).toBe('<div class="o-order"><h1>SO001</h1><span class="badge">Nouveau</span></div>');
        expect((await render(Special)).html()).toBe('<div class="o-order"><h2>SO002</h2><span class="badge">Nouveau</span></div>');
    });

    test("un template précompilé reste réactif et interactif", async () => {
        const name = uid("counter");
        loadModule(compileTemplateFiles([{ path: "c.xml", content: `<templates><t t-name="${name}"><button t-on-click="() => count++">{{ count }}</button></t></templates>` }]));
        setTemplateCompiler(null);
        class Counter extends Component {
            static template = name;
            @state accessor count = 0;
        }
        const { fixture, html } = await render(Counter);
        await click("button", fixture);
        expect(html()).toBe("<button>1</button>");
    });

    test("erreurs : fichier et ligne indiqués", () => {
        expect(() => compileTemplateFiles([{ path: "sale/order.xml", content: `<templates>\n<t t-name="x">\n<div><p></div>\n</t>\n</templates>` }])).toThrow(
            /ligne 3/,
        );
        expect(() => compileTemplateFiles([{ path: "a.xml", content: `<templates><div/></templates>` }])).toThrow(/a\.xml, ligne 1 : <div> inattendu/);
        expect(() =>
            compileTemplateFiles([
                { path: "a.xml", content: `<templates><t t-name="dup"><p/></t></templates>` },
                { path: "b.xml", content: `<templates><t t-name="dup"><p/></t></templates>` },
            ]),
        ).toThrow(/b\.xml, ligne 1 : le template "dup" est déjà défini \(a\.xml\)/);
        expect(() => compileTemplateFiles([{ path: "a.xml", content: `<templates><t t-inherit="absent"><xpath expr="//p"/></t><t t-name="z"><p/></t></templates>` }])).toThrow(
            /a\.xml : t-inherit="absent" vise un template qui n'est défini dans aucun fichier/,
        );
    });

    test("la localisation des erreurs d'exécution indique le fichier et sa ligne", async () => {
        const name = uid("loc");
        loadModule(compileTemplateFiles([{ path: "sale/static/loc.xml", content: `<templates>\n<t t-name="${name}">\n<p>{{ value.toFixed(2) }}</p>\n</t>\n</templates>` }]));
        class Loc extends Component {
            static template = name;
            @state accessor value: number | null = 1;
        }
        const errors: (Error & { trameLocation?: string })[] = [];
        const { component } = await render(Loc, { onError: (e) => errors.push(e as Error) });
        component.value = null;
        await new Promise((r) => setTimeout(r, 0));
        expect(errors[0].trameLocation).toBe(`template "${name}" (sale/static/loc.xml), ligne 3 : {{ value.toFixed(2) }}`);
    });

    test("compileTemplate : un seul template, avec extensions", () => {
        const factory = compileTemplate(`<div><h1>a</h1></div>`, { name: "one", extensions: [`<xpath expr="//h1" position="after"><h2>b</h2></xpath>`] });
        expect(factory.startsWith("(function ($h) {")).toBe(true);
        expect(factory).toContain('["h2",0,["b"],0]');
    });
});

describe("registerTemplates (fichiers de templates compilés dans le navigateur)", () => {
    test("définition, puis extension depuis un autre fichier", async () => {
        const name = uid("page");
        registerTemplates(`<templates><t t-name="${name}"><section><h1>{{ title }}</h1></section></t></templates>`, "web/page.xml");
        class Page extends Component {
            static template = name;
            title = "Accueil";
        }
        expect((await render(Page)).html()).toBe("<section><h1>Accueil</h1></section>");
        registerTemplates(`<templates><t t-inherit="${name}"><xpath expr="//h1" position="after"><p>ajout</p></xpath></t></templates>`, "sale/page.xml");
        cleanup();
        expect((await render(Page)).html()).toBe("<section><h1>Accueil</h1><p>ajout</p></section>");
    });

    test("extension d'un template enregistré autrement (registerTemplate)", async () => {
        const name = uid("legacy");
        registerTemplate(name, `<ul><li>a</li></ul>`);
        registerTemplates(`<templates><t t-inherit="${name}"><xpath expr="//ul" position="inside"><li>b</li></xpath></t></templates>`, "ext.xml");
        class Legacy extends Component {
            static template = name;
        }
        expect((await render(Legacy)).html()).toBe("<ul><li>a</li><li>b</li></ul>");
    });

    test("t-inherit vers un template inconnu : erreur explicite", () => {
        expect(() => registerTemplates(`<templates><t t-inherit="nope"><xpath expr="//p"/></t></templates>`, "bad.xml")).toThrow(/bad\.xml : t-inherit="nope" vise un template inconnu/);
    });
});

describe("sans compilateur (trame.runtime.js)", () => {
    test("un template non précompilé lève une erreur claire", async () => {
        setTemplateCompiler(null);
        class Inline extends Component {
            static template = xml`<p>x</p>`;
        }
        await expect(render(Inline)).rejects.toThrow(/le compilateur de templates n'est pas inclus \(trame\.runtime\.js\)/);
        expect(() => registerTemplates("<templates/>", "x.xml")).toThrow(/compilateur de templates n'est pas inclus/);
    });

    test("props et composants enfants fonctionnent avec des templates précompilés", async () => {
        const row = uid("row");
        const list = uid("list");
        loadModule(
            compileTemplateFiles([
                {
                    path: "l.xml",
                    content: `<templates>
    <t t-name="${row}"><li>{{ props.label }}</li></t>
    <t t-name="${list}"><ul><Row t-foreach="items" t-as="i" t-key="i" label="i"/></ul></t>
</templates>`,
                },
            ]),
        );
        setTemplateCompiler(null);
        class Row extends Component {
            static template = row;
            props = props({ label: t.string() });
        }
        class List extends Component {
            static template = list;
            static components = { Row };
            items = ["a", "b"];
        }
        expect((await render(List)).html()).toBe("<ul><li>a</li><li>b</li></ul>");
    });
});
