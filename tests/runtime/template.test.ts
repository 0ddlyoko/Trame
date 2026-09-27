import { describe, expect, test, vi } from "vitest";
import { Component, computed, markup, nextTick, state, xml } from "../../src/index";
import { render } from "../helpers";

describe("templates : rendu de base", () => {
    test("texte statique et interpolation", async () => {
        class Hello extends Component {
            static template = xml`<div class="hello">Bonjour {{ name }} !</div>`;
            @state accessor name = "Alice";
        }
        const { html, component } = await render(Hello);
        expect(html()).toBe('<div class="hello">Bonjour Alice !</div>');
        component.name = "Bob";
        await nextTick();
        expect(html()).toBe('<div class="hello">Bonjour Bob !</div>');
    });

    test("seul le nœud concerné est mis à jour (pas de re-rendu)", async () => {
        class Card extends Component {
            static template = xml`<div><h1>{{ title }}</h1><span>{{ count }}</span></div>`;
            @state accessor title = "T";
            @state accessor count = 0;
        }
        const { fixture, component } = await render(Card);
        const h1 = fixture.querySelector("h1")!;
        const h1Text = h1.firstChild;
        const span = fixture.querySelector("span")!;
        component.count = 5;
        await nextTick();
        expect(span.textContent).toBe("5");
        expect(fixture.querySelector("h1")).toBe(h1);
        expect(h1.firstChild).toBe(h1Text);
    });

    test("plusieurs racines", async () => {
        class Multi extends Component {
            static template = xml`<span>a</span><span>{{ b }}</span>`;
            b = "b";
        }
        const { html } = await render(Multi);
        expect(html()).toBe("<span>a</span><span>b</span>");
    });

    test("blancs d'indentation supprimés", async () => {
        class Indented extends Component {
            static template = xml`
                <ul>
                    <li>un</li>
                    <li>deux</li>
                </ul>
            `;
        }
        const { html } = await render(Indented);
        expect(html()).toBe("<ul><li>un</li><li>deux</li></ul>");
    });

    test("null / undefined / false affichent une chaîne vide", async () => {
        class Empty extends Component {
            static template = xml`<p>[{{ a }}][{{ b }}][{{ c }}][{{ d }}]</p>`;
            a = null;
            b = undefined;
            c = false;
            d = 0;
        }
        const { html } = await render(Empty);
        expect(html()).toBe("<p>[][][][0]</p>");
    });

    test("échappement HTML par défaut, markup() pour du HTML brut avec t-out", async () => {
        class Out extends Component {
            static template = xml`<div><p>{{ html }}</p><p t-out="safe"/></div>`;
            html = "<b>x</b>";
            safe = markup("<b>ok</b>");
        }
        const { html } = await render(Out);
        expect(html()).toBe("<div><p>&lt;b&gt;x&lt;/b&gt;</p><p><b>ok</b></p></div>");
    });

    test("this. est accepté mais pas nécessaire", async () => {
        class Both extends Component {
            static template = xml`<p>{{ this.a }}-{{ a }}</p>`;
            a = 1;
        }
        const { html } = await render(Both);
        expect(html()).toBe("<p>1-1</p>");
    });

    test("computed dans le template", async () => {
        class Price extends Component {
            static template = xml`<p>{{ total.toFixed(2) }}</p>`;
            @state accessor qty = 2;
            @state accessor price = 10;
            @computed get total() {
                return this.qty * this.price;
            }
        }
        const { html, component } = await render(Price);
        expect(html()).toBe("<p>20.00</p>");
        component.qty = 3;
        await nextTick();
        expect(html()).toBe("<p>30.00</p>");
    });

    test("expressions : globals, ternaires, littéraux objets, template literals", async () => {
        class Exprs extends Component {
            static template = xml`<p>{{ Math.max(a, 3) }}|{{ a > 1 ? 'grand' : 'petit' }}|{{ JSON.stringify({ a, b: a + 1 }) }}|{{ \`v=\${a}\` }}</p>`;
            @state accessor a = 2;
        }
        const { html } = await render(Exprs);
        expect(html()).toBe('<p>3|grand|{"a":2,"b":3}|v=2</p>');
    });
});

describe("attributs", () => {
    test("t-att-x, interpolation d'attribut, suppression si null/false", async () => {
        class Link extends Component {
            static template = xml`<a t-att-href="url" title="Aller à {{ name }}" t-att-hidden="hidden">x</a>`;
            @state accessor url: string | null = "/a";
            @state accessor name = "A";
            @state accessor hidden = false;
        }
        const { fixture, component } = await render(Link);
        const a = fixture.querySelector("a")!;
        expect(a.getAttribute("href")).toBe("/a");
        expect(a.getAttribute("title")).toBe("Aller à A");
        expect(a.hasAttribute("hidden")).toBe(false);
        component.url = null;
        component.hidden = true;
        await nextTick();
        expect(a.hasAttribute("href")).toBe(false);
        expect(a.getAttribute("hidden")).toBe("");
    });

    test("classes : statiques conservées, objet / chaîne / tableau", async () => {
        class Cls extends Component {
            static template = xml`<div class="base" t-att-class="{ red: red, big: !red }"/>`;
            @state accessor red = true;
        }
        const { fixture, component } = await render(Cls);
        const div = fixture.firstElementChild!;
        expect(div.className).toBe("base red");
        component.red = false;
        await nextTick();
        expect(div.className).toBe("base big");
    });

    test("style objet et chaîne", async () => {
        class Styled extends Component {
            static template = xml`<div style="color: red" t-att-style="{ fontSize: size + 'px' }"/>`;
            @state accessor size = 12;
        }
        const { fixture, component } = await render(Styled);
        const div = fixture.firstElementChild as HTMLElement;
        expect(div.style.color).toBe("red");
        expect(div.style.fontSize).toBe("12px");
        component.size = 20;
        await nextTick();
        expect(div.style.fontSize).toBe("20px");
    });

    test("value : propriété, et pas d'écrasement d'une saisie équivalente", async () => {
        class Field extends Component {
            static template = xml`<input type="text" t-att-value="price"/>`;
            @state accessor price: number | null = 1;
        }
        const { fixture, component } = await render(Field);
        const input = fixture.querySelector("input")!;
        expect(input.value).toBe("1");
        input.value = "1.";
        component.price = 1;
        await nextTick();
        expect(input.value).toBe("1.");
        component.price = 2;
        await nextTick();
        expect(input.value).toBe("2");
        component.price = null;
        await nextTick();
        expect(input.value).toBe("");
    });

    test("checked", async () => {
        class Check extends Component {
            static template = xml`<input type="checkbox" t-att-checked="done"/>`;
            @state accessor done = true;
        }
        const { fixture, component } = await render(Check);
        const input = fixture.querySelector("input")!;
        expect(input.checked).toBe(true);
        component.done = false;
        await nextTick();
        expect(input.checked).toBe(false);
    });

    test("t-att : attributs en bloc", async () => {
        class Spread extends Component {
            static template = xml`<div t-att="attrs"/>`;
            @state accessor attrs: Record<string, string> = { "data-a": "1", title: "t" };
        }
        const { fixture, component } = await render(Spread);
        const div = fixture.firstElementChild!;
        expect(div.getAttribute("data-a")).toBe("1");
        component.attrs = { title: "u" };
        await nextTick();
        expect(div.hasAttribute("data-a")).toBe(false);
        expect(div.getAttribute("title")).toBe("u");
    });

    test("SVG", async () => {
        class Icon extends Component {
            static template = xml`<svg viewBox="0 0 10 10"><circle t-att-r="r" cx="5" cy="5"/></svg>`;
            r = 4;
        }
        const { fixture } = await render(Icon);
        const circle = fixture.querySelector("circle")!;
        expect(circle.namespaceURI).toBe("http://www.w3.org/2000/svg");
        expect(circle.getAttribute("r")).toBe("4");
    });

    test("<tr> dans un <table> sans <tbody> (pas de correction du parseur HTML)", async () => {
        class Table extends Component {
            static template = xml`<table><tr><td>{{ a }}</td></tr></table>`;
            a = "x";
        }
        const { fixture } = await render(Table);
        expect(fixture.querySelector("td")!.textContent).toBe("x");
    });
});

describe("événements", () => {
    test("méthode, fonction fléchée, expression", async () => {
        class Counter extends Component {
            static template = xml`
                <div>
                    <button class="a" t-on-click="increment">+</button>
                    <button class="b" t-on-click="() => add(10)">+10</button>
                    <button class="c" t-on-click="count = 0">0</button>
                    <span>{{ count }}</span>
                </div>`;
            @state accessor count = 0;
            increment() {
                this.count++;
            }
            add(n: number) {
                this.count += n;
            }
        }
        const { fixture } = await render(Counter);
        const span = fixture.querySelector("span")!;
        (fixture.querySelector(".a") as HTMLElement).click();
        expect(span.textContent).toBe("1");
        (fixture.querySelector(".b") as HTMLElement).click();
        expect(span.textContent).toBe("11");
        (fixture.querySelector(".c") as HTMLElement).click();
        expect(span.textContent).toBe("0");
    });

    test("l'événement est passé au gestionnaire", async () => {
        class Input extends Component {
            static template = xml`<input t-on-input="(ev) => value = ev.target.value"/><p>{{ value }}</p>`;
            @state accessor value = "";
        }
        const { fixture } = await render(Input);
        const input = fixture.querySelector("input")!;
        input.value = "abc";
        input.dispatchEvent(new Event("input"));
        expect(fixture.querySelector("p")!.textContent).toBe("abc");
    });

    test("modificateurs prevent et stop", async () => {
        const outer = vi.fn();
        class Form extends Component {
            static template = xml`<div t-on-click="outer"><a href="#" t-on-click.prevent.stop="inner">x</a></div>`;
            inner = vi.fn();
            outer = outer;
        }
        const { fixture, component } = await render(Form);
        const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
        fixture.querySelector("a")!.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(true);
        expect(component.inner).toHaveBeenCalledTimes(1);
        expect(outer).not.toHaveBeenCalled();
    });
});

describe("événements : fonction d'écoute partagée", () => {
    test("une seule fonction d'écoute pour tous les éléments d'une liste", async () => {
        const listeners = new Set<unknown>();
        const original = Element.prototype.addEventListener;
        Element.prototype.addEventListener = function (this: Element, type: string, fn: unknown, opts?: unknown) {
            if (type === "click") {
                listeners.add(fn);
            }
            return original.call(this, type, fn as EventListener, opts as AddEventListenerOptions);
        } as typeof original;
        try {
            class List extends Component {
                static template = xml`<ul><li t-foreach="items" t-as="i" t-key="i"><button t-on-click="() => pick(i)">{{ i }}</button></li></ul><p>{{ picked }}</p>`;
                @state accessor items = [1, 2, 3, 4, 5];
                @state accessor picked = 0;
                pick(i: number) {
                    this.picked = i;
                }
            }
            const { fixture } = await render(List);
            expect(listeners.size).toBe(1);
            (fixture.querySelectorAll("button")[3] as HTMLElement).click();
            expect(fixture.querySelector("p")!.textContent).toBe("4");
        } finally {
            Element.prototype.addEventListener = original;
        }
    });

    test("même événement avec des modificateurs différents sur un élément, et .once", async () => {
        class Both extends Component {
            static template = xml`<button t-on-click="() => a++" t-on-click.once="() => b++">x</button><p>{{ a }}/{{ b }}</p>`;
            @state accessor a = 0;
            @state accessor b = 0;
        }
        const { fixture } = await render(Both);
        const button = fixture.querySelector("button")!;
        button.click();
        button.click();
        expect(fixture.querySelector("p")!.textContent).toBe("2/1");
    });
});

describe("t-ref", () => {
    test("affecte l'élément à un membre", async () => {
        class WithRef extends Component {
            static template = xml`<canvas t-ref="canvas"/>`;
            @state accessor canvas: HTMLCanvasElement | null = null;
        }
        const { component, fixture } = await render(WithRef);
        expect(component.canvas).toBe(fixture.querySelector("canvas"));
    });
});
