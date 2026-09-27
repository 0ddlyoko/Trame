import { describe, expect, test, vi } from "vitest";
import { batch, Computed, Effect, nextTick, Signal, untrack } from "../../src/reactivity/core";
import { Owner } from "../../src/reactivity/owner";

function effect(fn: () => void | (() => void), owner: Owner | null = null): Effect {
    const e = new Effect(fn, owner);
    e.run();
    return e;
}

describe("Signal", () => {
    test("get / set / peek", () => {
        const s = new Signal(1);
        expect(s.get()).toBe(1);
        s.set(2);
        expect(s.peek()).toBe(2);
    });

    test("un effet se réexécute quand le signal change (en microtask)", async () => {
        const s = new Signal(1);
        const log: number[] = [];
        effect(() => void log.push(s.get()));
        expect(log).toEqual([1]);
        s.set(2);
        expect(log).toEqual([1]);
        await nextTick();
        expect(log).toEqual([1, 2]);
    });

    test("une valeur identique ne notifie pas", async () => {
        const s = new Signal(1);
        const fn = vi.fn(() => void s.get());
        effect(fn);
        s.set(1);
        await nextTick();
        expect(fn).toHaveBeenCalledTimes(1);
    });

    test("plusieurs écritures = une seule exécution", async () => {
        const a = new Signal(1);
        const b = new Signal(2);
        const fn = vi.fn(() => void (a.get() + b.get()));
        effect(fn);
        a.set(10);
        b.set(20);
        a.set(11);
        await nextTick();
        expect(fn).toHaveBeenCalledTimes(2);
    });

    test("batch exécute les effets de façon synchrone à la fin", () => {
        const a = new Signal(1);
        const log: number[] = [];
        effect(() => void log.push(a.get()));
        batch(() => {
            a.set(2);
            a.set(3);
            expect(log).toEqual([1]);
        });
        expect(log).toEqual([1, 3]);
    });

    test("untrack ne crée pas de dépendance", async () => {
        const a = new Signal(1);
        const b = new Signal(1);
        const fn = vi.fn(() => void (a.get() + untrack(() => b.get())));
        effect(fn);
        b.set(2);
        await nextTick();
        expect(fn).toHaveBeenCalledTimes(1);
        a.set(2);
        await nextTick();
        expect(fn).toHaveBeenCalledTimes(2);
    });
});

describe("Computed", () => {
    test("paresseux : pas calculé tant qu'on ne le lit pas", () => {
        const s = new Signal(1);
        const fn = vi.fn(() => s.get() * 2);
        const c = new Computed(fn);
        expect(fn).not.toHaveBeenCalled();
        expect(c.get()).toBe(2);
        expect(c.get()).toBe(2);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    test("froid (non observé) : revalidé à la lecture", () => {
        const s = new Signal(1);
        const fn = vi.fn(() => s.get() * 2);
        const c = new Computed(fn);
        expect(c.get()).toBe(2);
        s.set(5);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(c.get()).toBe(10);
        expect(fn).toHaveBeenCalledTimes(2);
        expect(s.observed).toBe(false);
    });

    test("observé par un effet : mis à jour et abonné", async () => {
        const s = new Signal(1);
        const c = new Computed(() => s.get() * 2);
        const log: number[] = [];
        effect(() => void log.push(c.get()));
        expect(s.observed).toBe(true);
        s.set(2);
        await nextTick();
        expect(log).toEqual([2, 4]);
    });

    test("pas de glitch : un effet ne voit jamais d'état incohérent (diamant)", async () => {
        const a = new Signal(1);
        const b = new Computed(() => a.get() + 1);
        const c = new Computed(() => a.get() * 2);
        const log: string[] = [];
        effect(() => void log.push(`${b.get()}-${c.get()}`));
        a.set(2);
        await nextTick();
        expect(log).toEqual(["2-2", "3-4"]);
    });

    test("coupure : si un computed ne change pas, ses observateurs ne se réexécutent pas", async () => {
        const a = new Signal(1);
        const parity = new Computed(() => a.get() % 2);
        const fn = vi.fn(() => void parity.get());
        effect(fn);
        a.set(3);
        await nextTick();
        expect(fn).toHaveBeenCalledTimes(1);
        a.set(4);
        await nextTick();
        expect(fn).toHaveBeenCalledTimes(2);
    });

    test("dépendances dynamiques : seule la branche exécutée est suivie", async () => {
        const cond = new Signal(true);
        const a = new Signal("a");
        const b = new Signal("b");
        const fn = vi.fn(() => (cond.get() ? a.get() : b.get()));
        const c = new Computed(fn);
        effect(() => void c.get());
        expect(b.observed).toBe(false);
        b.set("B");
        await nextTick();
        expect(fn).toHaveBeenCalledTimes(1);
        cond.set(false);
        await nextTick();
        expect(c.peek()).toBe("B");
        expect(a.observed).toBe(false);
        expect(b.observed).toBe(true);
    });

    test("se désabonne quand plus personne ne l'observe", async () => {
        const s = new Signal(1);
        const c = new Computed(() => s.get());
        const e = effect(() => void c.get());
        expect(s.observed).toBe(true);
        e.dispose();
        expect(s.observed).toBe(false);
    });

    test("une erreur est mise en cache et relancée à la lecture", () => {
        const s = new Signal(0);
        const c = new Computed(() => {
            if (s.get() === 0) {
                throw new Error("zéro");
            }
            return s.get();
        });
        expect(() => c.get()).toThrow("zéro");
        s.set(2);
        expect(c.get()).toBe(2);
    });

    test("equals personnalisé", async () => {
        const s = new Signal({ id: 1, name: "a" });
        const c = new Computed(() => ({ id: s.get().id }), { equals: (x, y) => x.id === y.id });
        const fn = vi.fn(() => void c.get());
        effect(fn);
        s.set({ id: 1, name: "b" });
        await nextTick();
        expect(fn).toHaveBeenCalledTimes(1);
    });
});

describe("Effect", () => {
    test("nettoyage renvoyé par l'effet", async () => {
        const s = new Signal(1);
        const log: string[] = [];
        const e = effect(() => {
            const v = s.get();
            log.push(`run ${v}`);
            return () => log.push(`clean ${v}`);
        });
        s.set(2);
        await nextTick();
        e.dispose();
        expect(log).toEqual(["run 1", "clean 1", "run 2", "clean 2"]);
    });

    test("les parents s'exécutent avant les enfants", async () => {
        const s = new Signal(1);
        const parent = new Owner(null);
        const child = new Owner(new Owner(parent));
        const log: string[] = [];
        effect(() => void log.push(`child ${s.get()}`), child);
        effect(() => void log.push(`parent ${s.get()}`), parent);
        log.length = 0;
        s.set(2);
        await nextTick();
        expect(log).toEqual(["parent 2", "child 2"]);
    });

    test("un effet disposé par un parent pendant le flush ne s'exécute plus", async () => {
        const show = new Signal(true);
        const value = new Signal<{ name: string } | null>({ name: "a" });
        const root = new Owner(null);
        const log: string[] = [];
        let childOwner: Owner | null = null;
        effect(() => {
            childOwner?.dispose();
            childOwner = null;
            if (show.get()) {
                childOwner = new Owner(root);
                effect(() => void log.push(value.get()!.name), childOwner);
            }
        }, root);
        batch(() => {
            show.set(false);
            value.set(null);
        });
        expect(log).toEqual(["a"]);
    });

    test("une erreur est transmise au gestionnaire du scope", async () => {
        const s = new Signal(0);
        const owner = new Owner(null);
        const errors: unknown[] = [];
        owner.errorHandler = (e) => {
            errors.push(e);
            return true;
        };
        effect(() => {
            if (s.get() > 0) {
                throw new Error("boom");
            }
        }, owner);
        s.set(1);
        await nextTick();
        expect(errors).toHaveLength(1);
    });

    test("détection de boucle infinie", async () => {
        const s = new Signal(0);
        const errors: unknown[] = [];
        const spy = vi.spyOn(console, "error").mockImplementation((e) => void errors.push(e));
        effect(() => s.set(s.get() + 1));
        s.set(-1);
        await nextTick();
        spy.mockRestore();
        expect(String(errors[0])).toMatch(/Boucle réactive infinie/);
    });
});

describe("Owner", () => {
    test("dispose libère effets, enfants et nettoyages, et déclenche l'AbortSignal", async () => {
        const s = new Signal(1);
        const owner = new Owner(null);
        const child = new Owner(owner);
        const log: string[] = [];
        effect(() => void log.push(`e ${s.get()}`), child);
        owner.onCleanup(() => log.push("cleanup"));
        const signal = owner.abortSignal;
        owner.dispose();
        expect(signal.aborted).toBe(true);
        s.set(2);
        await nextTick();
        expect(log).toEqual(["e 1", "cleanup"]);
        expect(s.observed).toBe(false);
    });

    test("lookup remonte les providers", () => {
        const root = new Owner(null);
        root.provide("a", 1);
        const child = new Owner(new Owner(root));
        child.provide("b", 2);
        expect(child.lookup("a")).toBe(1);
        expect(child.lookup("b")).toBe(2);
        expect(root.lookup("b")).toBeUndefined();
    });

    test("activate : enfants avant parents, sauf contenus détachés", () => {
        const root = new Owner(null);
        const a = new Owner(root);
        const b = new Owner(root);
        b.detached = true;
        const log: string[] = [];
        root.onMount(() => log.push("root"));
        a.onMount(() => log.push("a"));
        b.onMount(() => log.push("b"));
        root.activate();
        expect(log).toEqual(["a", "root"]);
        b.detached = false;
        b.activate();
        expect(log).toEqual(["a", "root", "b"]);
    });
});
