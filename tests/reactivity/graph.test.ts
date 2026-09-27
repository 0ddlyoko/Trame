// Structure du graphe réactif : dépendances en liste chaînée, réutilisées d'une exécution à l'autre.
import { afterEach, describe, expect, test } from "vitest";
import { batch, Computed, Effect, nextTick, Signal } from "../../src/reactivity/core";

function effect(fn: () => void): Effect {
    const e = new Effect(fn, null);
    e.run();
    return e;
}

/** Compte les Map et Set construits pendant `fn` (le moteur réactif ne doit plus en créer). */
function countCollections(fn: () => void): number {
    const OriginalMap = globalThis.Map;
    const OriginalSet = globalThis.Set;
    let count = 0;
    globalThis.Map = class extends OriginalMap<unknown, unknown> {
        constructor(entries?: Iterable<readonly [unknown, unknown]> | null) {
            super(entries);
            count++;
        }
    } as MapConstructor;
    globalThis.Set = class extends OriginalSet<unknown> {
        constructor(values?: Iterable<unknown> | null) {
            super(values);
            count++;
        }
    } as SetConstructor;
    try {
        fn();
    } finally {
        globalThis.Map = OriginalMap;
        globalThis.Set = OriginalSet;
    }
    return count;
}

const disposables: Effect[] = [];
afterEach(() => {
    for (const e of disposables.splice(0)) e.dispose();
});

describe("graphe réactif : pas de Map ni de Set", () => {
    test("observer des signaux ne crée ni Map ni Set", () => {
        const signals = Array.from({ length: 50 }, (_, i) => new Signal(i));
        const created = countCollections(() => {
            for (const s of signals) {
                disposables.push(effect(() => void s.get()));
            }
        });
        expect(created).toBe(0);
    });

    test("réexécuter un calcul avec les mêmes dépendances n'alloue aucune Map ni aucun Set", () => {
        const a = new Signal(0);
        const b = new Signal(0);
        const c = new Computed(() => a.get() + b.get());
        let runs = 0;
        disposables.push(
            effect(() => {
                runs++;
                void c.get();
                void a.get();
            }),
        );
        const created = countCollections(() => {
            for (let i = 1; i <= 100; i++) {
                batch(() => a.set(i));
            }
        });
        expect(runs).toBe(101);
        expect(created).toBe(0);
    });
});

describe("graphe réactif : dépendances dynamiques", () => {
    test("changement de branche : l'ancienne source est abandonnée, la nouvelle suivie", async () => {
        const cond = new Signal(true);
        const a = new Signal("a");
        const b = new Signal("b");
        const log: string[] = [];
        disposables.push(effect(() => void log.push(cond.get() ? a.get() : b.get())));
        expect(a.observed).toBe(true);
        expect(b.observed).toBe(false);
        cond.set(false);
        await nextTick();
        expect(a.observed).toBe(false);
        expect(b.observed).toBe(true);
        a.set("a2");
        await nextTick();
        expect(log).toEqual(["a", "b"]);
        b.set("b2");
        await nextTick();
        expect(log).toEqual(["a", "b", "b2"]);
    });

    test("ordre des lectures inversé : dépendances conservées", async () => {
        const signals = Array.from({ length: 1000 }, (_, i) => new Signal(i));
        const reversed = new Signal(false);
        let sum = 0;
        disposables.push(
            effect(() => {
                const order = reversed.get() ? [...signals].reverse() : signals;
                sum = 0;
                for (const s of order) sum += s.get();
            }),
        );
        reversed.set(true);
        await nextTick();
        expect(signals.every((s) => s.observerCount === 1)).toBe(true);
        signals[500].set(10500);
        await nextTick();
        expect(sum).toBe((999 * 1000) / 2 + 10000);
    });

    test("une source lue plusieurs fois n'est suivie qu'une fois", async () => {
        const s = new Signal(1);
        let runs = 0;
        disposables.push(
            effect(() => {
                runs++;
                void (s.get() + s.get() + s.get());
            }),
        );
        expect(s.observerCount).toBe(1);
        s.set(2);
        await nextTick();
        expect(runs).toBe(2);
    });

    test("calcul imbriqué qui lit la même source que son lecteur", async () => {
        const s = new Signal(1);
        const inner = new Computed(() => s.get() * 10);
        const log: number[] = [];
        disposables.push(effect(() => void log.push(s.get() + inner.get() + s.get())));
        expect(s.observerCount).toBe(2); // l'effet et le computed
        s.set(2);
        await nextTick();
        expect(log).toEqual([12, 24]);
    });

    test("computed froid → observé → froid : abonnements suivis correctement", async () => {
        const s = new Signal(1);
        const c = new Computed(() => s.get() + 1);
        expect(c.get()).toBe(2);
        expect(s.observed).toBe(false); // froid : pas abonné
        const e = effect(() => void c.get());
        expect(s.observed).toBe(true);
        expect(c.observed).toBe(true);
        e.dispose();
        expect(c.observed).toBe(false);
        expect(s.observed).toBe(false);
        s.set(5);
        expect(c.get()).toBe(6); // revalidé à la lecture
    });

    test("un effet disposé pendant le flush par un autre effet de la même source ne s'exécute plus", async () => {
        const s = new Signal(0);
        const log: string[] = [];
        let second!: Effect;
        disposables.push(
            effect(() => {
                if (s.get() > 0) second.dispose();
                log.push("premier");
            }),
        );
        second = effect(() => {
            void s.get();
            log.push("second");
        });
        s.set(1);
        await nextTick();
        expect(log).toEqual(["premier", "second", "premier"]);
        expect(s.observerCount).toBe(1);
    });
});
