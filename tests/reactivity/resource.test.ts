import { describe, expect, test, vi } from "vitest";
import { Computed, Effect, nextTick, Signal } from "../../src/reactivity/core";
import { Boundary, Owner } from "../../src/reactivity/owner";
import { error, loading, refresh, Resource } from "../../src/reactivity/resource";

function effect(fn: () => void, owner: Owner | null = null): Effect {
    const e = new Effect(fn, owner);
    e.run();
    return e;
}

/** Promesse contrôlable. */
function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function flushPromises() {
    for (let i = 0; i < 5; i++) {
        await nextTick();
    }
}

describe("Resource", () => {
    test("paresseuse : rien ne part tant qu'on ne lit pas", async () => {
        const fetcher = vi.fn(async () => 42);
        const r = new Resource(fetcher, null);
        await flushPromises();
        expect(fetcher).not.toHaveBeenCalled();
        expect(r.read()).toBeUndefined();
        expect(fetcher).toHaveBeenCalledTimes(1);
        await flushPromises();
        expect(r.read()).toBe(42);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test("eager : charge dès la création", () => {
        const fetcher = vi.fn(async () => 1);
        new Resource(fetcher, null, { eager: true });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test("une lecture en attente ne lève pas d'erreur et l'effet se réexécute à l'arrivée", async () => {
        const d = deferred<{ name: string }>();
        const r = new Resource(() => d.promise, null);
        const log: (string | undefined)[] = [];
        effect(() => void log.push(r.read()?.name));
        expect(log).toEqual([undefined]);
        d.resolve({ name: "SO001" });
        await flushPromises();
        expect(log).toEqual([undefined, "SO001"]);
    });

    test("une erreur d'accès pendant le chargement est ignorée (pas de crash)", async () => {
        const d = deferred<{ name: string }>();
        const r = new Resource(() => d.promise, null);
        const owner = new Owner(null);
        const errors: unknown[] = [];
        owner.errorHandler = (e) => {
            errors.push(e);
            return true;
        };
        const log: string[] = [];
        effect(() => void log.push(r.read()!.name), owner);
        expect(errors).toEqual([]);
        d.resolve({ name: "ok" });
        await flushPromises();
        expect(log).toEqual(["ok"]);
        expect(errors).toEqual([]);
    });

    test("plusieurs ressources lues dans le même effet partent en parallèle", async () => {
        const fa = vi.fn(async () => "a");
        const fb = vi.fn(async () => "b");
        const a = new Resource(fa, null);
        const b = new Resource(fb, null);
        effect(() => void [a.read(), b.read()]);
        expect(fa).toHaveBeenCalledTimes(1);
        expect(fb).toHaveBeenCalledTimes(1);
    });

    test("dépendances : relancée quand une dépendance change, avec annulation de la précédente", async () => {
        const id = new Signal(1);
        const runs: { signal: AbortSignal; d: ReturnType<typeof deferred<string>> }[] = [];
        const r = new Resource(({ signal }) => {
            const current = id.get();
            const d = deferred<string>();
            runs.push({ signal, d });
            return d.promise.then((v) => `${v} ${current}`);
        }, null);
        const log: (string | undefined)[] = [];
        effect(() => void log.push(r.read()));
        runs[0].d.resolve("order");
        await flushPromises();
        id.set(2);
        await flushPromises();
        id.set(3);
        await flushPromises();
        expect(runs).toHaveLength(3);
        expect(runs[1].signal.aborted).toBe(true);
        runs[1].d.resolve("order");
        runs[2].d.resolve("order");
        await flushPromises();
        expect(log[log.length - 1]).toBe("order 3");
        expect(log).not.toContain("order 2");
    });

    test("non observée : une dépendance modifiée ne relance rien avant la prochaine lecture", async () => {
        const id = new Signal(1);
        const fetcher = vi.fn(async () => id.get());
        const r = new Resource(fetcher, null);
        r.read();
        await flushPromises();
        id.set(2);
        await flushPromises();
        expect(fetcher).toHaveBeenCalledTimes(1);
        r.read();
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    test("rechargement : l'ancienne valeur reste visible, loading passe à true", async () => {
        const id = new Signal(1);
        let d = deferred<string>();
        const r = new Resource(() => {
            id.get();
            return d.promise;
        }, null);
        const log: string[] = [];
        effect(() => void log.push(`${r.read()}|${loading(() => r.read())}`));
        d.resolve("v1");
        await flushPromises();
        d = deferred<string>();
        id.set(2);
        await flushPromises();
        expect(log[log.length - 1]).toBe("v1|true");
        d.resolve("v2");
        await flushPromises();
        expect(log[log.length - 1]).toBe("v2|false");
    });

    test("transition : les ressources relancées ensemble sont appliquées ensemble", async () => {
        const id = new Signal(1);
        const pa: ReturnType<typeof deferred<string>>[] = [];
        const pb: ReturnType<typeof deferred<string>>[] = [];
        const a = new Resource(() => {
            id.get();
            const d = deferred<string>();
            pa.push(d);
            return d.promise;
        }, null);
        const b = new Resource(() => {
            id.get();
            const d = deferred<string>();
            pb.push(d);
            return d.promise;
        }, null);
        const log: string[] = [];
        effect(() => void log.push(`${a.read()}-${b.read()}`));
        pa[0].resolve("a1");
        pb[0].resolve("b1");
        await flushPromises();
        expect(log[log.length - 1]).toBe("a1-b1");
        id.set(2);
        await flushPromises();
        pa[1].resolve("a2");
        await flushPromises();
        // a2 est retenue tant que b2 n'est pas arrivée
        expect(log[log.length - 1]).toBe("a1-b1");
        pb[1].resolve("b2");
        await flushPromises();
        expect(log[log.length - 1]).toBe("a2-b2");
        expect(log).not.toContain("a2-b1");
    });

    test("loading() observe sans charger", async () => {
        const d = deferred<number>();
        const fetcher = vi.fn(() => d.promise);
        const r = new Resource(fetcher, null);
        const log: boolean[] = [];
        effect(() => void log.push(loading(() => r.read())));
        expect(fetcher).not.toHaveBeenCalled();
        expect(log).toEqual([false]);
        r.read();
        await nextTick();
        expect(log).toEqual([false, true]);
        d.resolve(1);
        await flushPromises();
        expect(log).toEqual([false, true, false]);
    });

    test("loading() suit une chaîne : vrai si un maillon charge", async () => {
        const inner = deferred<string>();
        const innerRes = new Resource(() => inner.promise, null);
        const outer = new Resource(async () => ({ get partner() { return innerRes.read(); } }), null);
        outer.read();
        await flushPromises();
        innerRes.read();
        expect(loading(() => outer.read()!.partner)).toBe(true);
        inner.resolve("p");
        await flushPromises();
        expect(loading(() => outer.read()!.partner)).toBe(false);
    });

    test("loading() à travers un computed : observe sans charger, sans polluer le cache", async () => {
        const d = deferred<number>();
        const fetcher = vi.fn(() => d.promise);
        const r = new Resource(fetcher, null);
        const total = new Computed(() => (r.read() ?? 0) * 2);
        expect(loading(() => total.get())).toBe(false);
        expect(fetcher).not.toHaveBeenCalled();
        // Une vraie lecture charge (le résultat calculé en observation n'est pas resté en cache).
        expect(total.get()).toBe(0);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(loading(() => total.get())).toBe(true);
        d.resolve(21);
        await flushPromises();
        expect(loading(() => total.get())).toBe(false);
        expect(total.get()).toBe(42);
    });

    test("loading() exige une fonction", () => {
        expect(() => loading(42 as unknown as () => unknown)).toThrow(/attendent une fonction/);
    });

    test("error() et refresh()", async () => {
        let fail = true;
        const r = new Resource(async () => {
            if (fail) {
                throw new Error("réseau");
            }
            return "ok";
        }, null);
        const log: unknown[] = [];
        effect(() => void log.push((error(() => r.read()) as Error | undefined)?.message));
        r.read();
        await flushPromises();
        expect(log[log.length - 1]).toBe("réseau");
        fail = false;
        refresh(() => r.read());
        await flushPromises();
        expect(log[log.length - 1]).toBeUndefined();
        expect(r.read()).toBe("ok");
    });

    test("write() : mise à jour locale sans requête", async () => {
        const fetcher = vi.fn(async () => [1]);
        const r = new Resource(fetcher, null);
        r.read();
        await flushPromises();
        r.write([1, 2]);
        expect(r.read()).toEqual([1, 2]);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test("la destruction du propriétaire annule la requête", async () => {
        const owner = new Owner(null);
        let signal: AbortSignal | null = null;
        const r = new Resource(({ signal: s }) => {
            signal = s;
            return new Promise(() => {});
        }, owner);
        r.read();
        owner.dispose();
        expect(signal!.aborted).toBe(true);
    });

    test("une requête lancée va au bout même si plus personne ne lit", async () => {
        const d = deferred<number>();
        const r = new Resource(() => d.promise, null);
        const e = effect(() => void r.read());
        e.dispose();
        d.resolve(7);
        await flushPromises();
        expect(r.read()).toBe(7);
    });

    test("ressource dépendant d'une autre ressource", async () => {
        const da = deferred<{ id: number }>();
        const a = new Resource(() => da.promise, null);
        const fb = vi.fn(async () => `lines of ${a.read()!.id}`);
        const b = new Resource(fb, null);
        const log: (string | undefined)[] = [];
        effect(() => void log.push(b.read()));
        da.resolve({ id: 5 });
        await flushPromises();
        expect(log[log.length - 1]).toBe("lines of 5");
    });

    test("Boundary : attend toutes les ressources lues pendant la construction", async () => {
        const da = deferred<string>();
        const db = deferred<string>();
        const a = new Resource(() => da.promise, null);
        const b = new Resource(() => db.promise, null);
        const ready = vi.fn();
        const owner = new Owner(null);
        owner.boundary = new Boundary(ready, () => {});
        effect(() => void a.read(), owner);
        effect(() => void b.read(), owner);
        owner.boundary.done();
        da.resolve("a");
        await flushPromises();
        expect(ready).not.toHaveBeenCalled();
        db.resolve("b");
        await flushPromises();
        expect(ready).toHaveBeenCalledTimes(1);
    });

    test("Boundary : sans lecture en attente, prêt immédiatement", () => {
        const ready = vi.fn();
        const boundary = new Boundary(ready, () => {});
        boundary.done();
        expect(ready).toHaveBeenCalledTimes(1);
    });

    test("Boundary : une erreur de premier chargement est transmise", async () => {
        const r = new Resource(async () => {
            throw new Error("KO");
        }, null);
        const onError = vi.fn();
        const ready = vi.fn();
        const owner = new Owner(null);
        // L'erreur est transmise au scope qui a lu la ressource (une ErrorBoundary peut l'intercepter)...
        owner.errorHandler = (e) => {
            onError(e);
            return true;
        };
        owner.boundary = new Boundary(ready, () => {});
        effect(() => void r.read(), owner);
        owner.boundary.done();
        await flushPromises();
        expect(onError).toHaveBeenCalledTimes(1);
        expect((onError.mock.calls[0][0] as Error).message).toBe("KO");
        // ... puis l'attente se termine pour le reste.
        expect(ready).toHaveBeenCalledTimes(1);
    });
});
