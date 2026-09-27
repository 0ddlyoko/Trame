// Vérification des templates par TypeScript (trame-check).
import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { findTemplates, main } from "../src/cli/check";
import { generateCheck } from "../src/compiler/typecheck";

const FIXTURE = "tests/fixtures/typecheck/components.ts";

/** Ligne (1-based) du fichier fixture contenant `text`. */
function lineOf(text: string): number {
    const lines = readFileSync(FIXTURE, "utf8").split(/\r?\n/);
    const index = lines.findIndex((l) => l.includes(text));
    expect(index).toBeGreaterThan(-1);
    return index + 1;
}

describe("génération du code de vérification", () => {
    test("expressions, boucle, condition, événements, props d'un enfant", () => {
        const { lines, templateLines } = generateCheck(
            `<div>\n<p t-if="order">{{ order.name }}</p>\n<Row t-foreach="lines" t-as="l" t-key="l.id" line="l"/>\n<input t-on-input="(ev) => name = ev.target.value"/>\n</div>`,
            "Form",
        );
        const code = lines.join("\n");
        expect(code).toContain("const $c = undefined as unknown as Form;");
        expect(code).toContain("if ($c.order) {");
        expect(code).toContain("__use($c.order.name);");
        expect(code).toMatch(/for \(const __it\d+ of __iter\(\$c\.lines\)\)/);
        expect(code).toMatch(/__props\(Form\.components\.Row, \{ line: \(__it\d+\) \}\);/);
        expect(code).toContain('__on<__Ev<"input", __El<"input">>>((ev) => $c.name = ev.target.value);');
        // Chaque ligne générée est reliée à la ligne du template.
        expect(templateLines[lines.findIndex((l) => l.includes("$c.order.name"))]).toBe(2);
        expect(templateLines[lines.findIndex((l) => l.includes("__props("))]).toBe(3);
    });

    test("t-set, slot avec portée, t-key hors boucle", () => {
        const { lines } = generateCheck(
            `<div><t t-set="n" t-value="items.length"/><p t-key="n">{{ n.toFixed(0) }}</p><List t-slot-scope="s"><b>{{ s.value }}</b></List></div>`,
            "Page",
        );
        const code = lines.join("\n");
        expect(code).toMatch(/const __v\d+ = \(\$c\.items\.length\);/);
        expect(code).toMatch(/__use\(__v\d+\.toFixed\(0\)\);/);
        expect(code).toMatch(/const __sc\d+: any = undefined;/);
    });
});

describe("recherche des templates dans le code", () => {
    test("classe, ligne, échappements, template avec ${} ignoré", () => {
        const code = [
            "class A extends Component {",
            "    static template = xml`<p>{{ \\`x\\` }}</p>`;",
            "}",
            "class B extends Component {",
            "    static template = xml`<p>${'dyn'}</p>`;",
            "}",
        ].join("\n");
        const { templates, skipped } = findTemplates(code);
        expect(templates).toHaveLength(1);
        expect(templates[0].className).toBe("A");
        expect(templates[0].line).toBe(2);
        expect(templates[0].source).toBe("<p>{{ `x` }}</p>");
        expect(skipped[0]).toMatch(/^B/);
    });
});

describe("trame-check (bout en bout avec tsc)", () => {
    test("signale chaque erreur de template sur la bonne ligne, rien pour un template correct", () => {
        const errors: string[] = [];
        const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => void errors.push(args.join(" ")));
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        let code: number;
        try {
            code = main(["-p", "tests/fixtures/typecheck/tsconfig.json"]);
        } finally {
            errorSpy.mockRestore();
            logSpy.mockRestore();
        }
        expect(code).toBe(1);
        const expected: [string, RegExp][] = [
            ["{{ nme }}", /Property 'nme' does not exist on type 'Bad'/],
            ["{{ line.prodcut }}", /Property 'prodcut' does not exist on type 'Line'/],
            ['<Row line="name"', /Type 'string' is not assignable to type 'Line'/],
            ['<Row line="lines[0]"/>', /Property 'onRemove' is missing/],
            ['extra="1"', /'extra' does not exist/],
            ["<Missing/>", /Property 'Missing' does not exist/],
            ['<div t-on-click="(ev) => ev.target.value"/>', /Property 'value' does not exist on type 'EventTarget & HTMLDivElement'/],
        ];
        for (const [marker, message] of expected) {
            const line = lineOf(marker);
            const found = errors.find((e) => e.startsWith(`${FIXTURE}:${line} `));
            expect(found, `erreur attendue ligne ${line} (${marker})`).toBeDefined();
            expect(found).toMatch(message);
        }
        expect(errors).toHaveLength(expected.length);
        expect(errors.some((e) => e.includes('template "Good"'))).toBe(false);
    }, 60000);
});
