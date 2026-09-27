import { describe, expect, test, vi } from "vitest";
import { Computed, Effect, nextTick } from "../../src/reactivity/core";
import { markRaw, reactive, toRaw } from "../../src/reactivity/store";

function effect(fn: () => void): Effect {
    const e = new Effect(fn, null);
    e.run();
    return e;
}

describe("reactive (store profond)", () => {
    test("suit uniquement les clés lues", async () => {
        const state = reactive({ a: 1, b: 2 });
        const fn = vi.fn(() => void state.a);
        effect(fn);
        state.b = 3;
        await nextTick();
        expect(fn).toHaveBeenCalledTimes(1);
        state.a = 5;
        await nextTick();
        expect(fn).toHaveBeenCalledTimes(2);
    });

    test("profondeur : les objets imbriqués sont réactifs", async () => {
        const state = reactive({ order: { partner: { name: "A" } } });
        const log: string[] = [];
        effect(() => void log.push(state.order.partner.name));
        state.order.partner.name = "B";
        await nextTick();
        expect(log).toEqual(["A", "B"]);
    });

    test("ajout et suppression de clés (Object.keys)", async () => {
        const state = reactive<Record<string, number>>({ a: 1 });
        const log: string[][] = [];
        effect(() => void log.push(Object.keys(state)));
        state.b = 2;
        await nextTick();
        delete state.a;
        await nextTick();
        expect(log).toEqual([["a"], ["a", "b"], ["b"]]);
    });

    test("tableaux : push, splice, index, length", async () => {
        const list = reactive([1, 2, 3]);
        const log: number[] = [];
        effect(() => void log.push(list.reduce((s, x) => s + x, 0)));
        list.push(4);
        await nextTick();
        list.splice(0, 1);
        await nextTick();
        list[0] = 10;
        await nextTick();
        list.length = 1;
        await nextTick();
        expect(log).toEqual([6, 10, 9, 17, 10]);
    });

    test("push ne notifie qu'une fois", async () => {
        const list = reactive<number[]>([]);
        const fn = vi.fn(() => void list.length);
        effect(fn);
        list.push(1, 2, 3);
        await nextTick();
        expect(fn).toHaveBeenCalledTimes(2);
    });

    test("includes / indexOf avec des objets", () => {
        const item = { id: 1 };
        const list = reactive([item]);
        expect(list.includes(item)).toBe(true);
        expect(list.includes(list[0])).toBe(true);
        expect(list.indexOf(list[0])).toBe(0);
    });

    test("même proxy pour le même objet, toRaw, markRaw", () => {
        const raw = { a: { b: 1 } };
        const p1 = reactive(raw);
        expect(reactive(raw)).toBe(p1);
        expect(reactive(p1)).toBe(p1);
        expect(toRaw(p1)).toBe(raw);
        expect(p1.a).toBe(p1.a);
        const skipped = markRaw({ x: 1 });
        expect(reactive(skipped)).toBe(skipped);
    });

    test("les instances de classes ne sont pas enveloppées", () => {
        class Foo {
            x = 1;
        }
        const foo = new Foo();
        expect(reactive(foo)).toBe(foo);
        const state = reactive({ foo });
        expect(state.foo).toBe(foo);
    });

    test("Map réactive", async () => {
        const map = reactive(new Map<string, number>());
        const log: (number | undefined)[] = [];
        const sizes: number[] = [];
        effect(() => void log.push(map.get("a")));
        effect(() => void sizes.push(map.size));
        map.set("b", 2);
        await nextTick();
        map.set("a", 1);
        await nextTick();
        map.delete("a");
        await nextTick();
        expect(log).toEqual([undefined, 1, undefined]);
        expect(sizes).toEqual([0, 1, 2, 1]);
    });

    test("Set réactif", async () => {
        const set = reactive(new Set<number>());
        const log: boolean[] = [];
        effect(() => void log.push(set.has(1)));
        set.add(1);
        await nextTick();
        expect(log).toEqual([false, true]);
        expect(Array.from(set)).toEqual([1]);
    });

    test("fonctionne avec les computed", async () => {
        const order = reactive({ lines: [{ qty: 1, price: 10 }] });
        const total = new Computed(() => order.lines.reduce((s, l) => s + l.qty * l.price, 0));
        const log: number[] = [];
        effect(() => void log.push(total.get()));
        order.lines[0].qty = 2;
        await nextTick();
        order.lines.push({ qty: 1, price: 5 });
        await nextTick();
        expect(log).toEqual([10, 20, 25]);
    });
});
