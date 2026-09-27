/**
 * Store profond : un objet ou tableau « simple » est enveloppé dans un Proxy qui crée,
 * à la demande, un signal par clé. Seules les clés réellement lues sont suivies.
 *
 * Les instances de classes ne sont pas enveloppées : elles gèrent leur réactivité
 * elles-mêmes via les décorateurs (@state...). Map et Set sont pris en charge.
 */

import { groupWrites, Signal } from "./core";

const RAW = Symbol("trame.raw");
const SKIP = Symbol("trame.skip");
/** Clé spéciale : change quand l'ensemble des clés (ou la taille) change. */
const KEYS = Symbol("trame.keys");
/** Map/Set : change quand une clé OU une valeur change (itérations sur les valeurs). */
const ITERATE = Symbol("trame.iterate");

type Target = Record<PropertyKey, unknown>;

const proxies = new WeakMap<object, object>();
const signalsByTarget = new WeakMap<object, Map<PropertyKey, Signal<undefined>>>();

function signalFor(target: object, key: PropertyKey): Signal<undefined> {
    let signals = signalsByTarget.get(target);
    if (signals === undefined) {
        signals = new Map();
        signalsByTarget.set(target, signals);
    }
    let sig = signals.get(key);
    if (sig === undefined) {
        sig = new Signal<undefined>(undefined, false);
        signals.set(key, sig);
    }
    return sig;
}

function track(target: object, key: PropertyKey): void {
    signalFor(target, key).get();
}

function trigger(target: object, key: PropertyKey): void {
    const sig = signalsByTarget.get(target)?.get(key);
    sig?.trigger();
}

/** Marque un objet pour qu'il ne soit jamais rendu réactif. */
export function markRaw<T extends object>(obj: T): T {
    Object.defineProperty(obj, SKIP, { value: true, enumerable: false });
    return obj;
}

/** Renvoie l'objet d'origine derrière un proxy réactif. */
export function toRaw<T>(value: T): T {
    if (value !== null && typeof value === "object") {
        const raw = (value as { [RAW]?: T })[RAW];
        if (raw !== undefined) {
            return raw;
        }
    }
    return value;
}

export function isReactive(value: unknown): boolean {
    return value !== null && typeof value === "object" && (value as { [RAW]?: unknown })[RAW] !== undefined;
}

function canWrap(value: object): boolean {
    if ((value as { [SKIP]?: boolean })[SKIP]) {
        return false;
    }
    if (Array.isArray(value)) {
        return true;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null || value instanceof Map || value instanceof Set;
}

/** Rend un objet/tableau/Map/Set réactif en profondeur. Les autres valeurs sont renvoyées telles quelles. */
export function reactive<T>(value: T): T {
    if (value === null || typeof value !== "object") {
        return value;
    }
    if ((value as { [RAW]?: unknown })[RAW] !== undefined) {
        return value;
    }
    const existing = proxies.get(value);
    if (existing !== undefined) {
        return existing as T;
    }
    if (!canWrap(value)) {
        return value;
    }
    let proxy: object;
    if (value instanceof Map) {
        proxy = new Proxy(value, collectionHandler);
    } else if (value instanceof Set) {
        proxy = new Proxy(value, collectionHandler);
    } else {
        proxy = new Proxy(value as object, Array.isArray(value) ? arrayHandler : objectHandler);
    }
    proxies.set(value, proxy);
    return proxy as T;
}

const hasOwn = Object.prototype.hasOwnProperty;

const objectHandler: ProxyHandler<Target> = {
    get(target, key, receiver) {
        if (key === RAW) {
            return target;
        }
        const value = Reflect.get(target, key, receiver);
        if (typeof key === "symbol") {
            return value;
        }
        track(target, key);
        return reactive(value);
    },
    set(target, key, value, receiver) {
        const had = hasOwn.call(target, key);
        const old = target[key as string];
        const raw = toRaw(value);
        const ok = Reflect.set(target, key, raw, receiver);
        if (!had) {
            groupWrites(() => {
                trigger(target, KEYS);
                trigger(target, key);
            });
        } else if (!Object.is(old, raw)) {
            trigger(target, key);
        }
        return ok;
    },
    deleteProperty(target, key) {
        const had = hasOwn.call(target, key);
        const ok = Reflect.deleteProperty(target, key);
        if (had) {
            groupWrites(() => {
                trigger(target, KEYS);
                trigger(target, key);
            });
        }
        return ok;
    },
    has(target, key) {
        if (typeof key !== "symbol") {
            track(target, key);
        }
        return Reflect.has(target, key);
    },
    ownKeys(target) {
        track(target, KEYS);
        return Reflect.ownKeys(target);
    },
};

/** Méthodes de tableau qui modifient : exécutées en batch pour ne notifier qu'une fois. */
const arrayMutators = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"]);
const arrayMutatorCache = new WeakMap<object, Map<string, Function>>();

const arrayHandler: ProxyHandler<unknown[]> = {
    get(target, key, receiver) {
        if (key === RAW) {
            return target;
        }
        if (typeof key === "string" && arrayMutators.has(key)) {
            let cache = arrayMutatorCache.get(target);
            if (cache === undefined) {
                cache = new Map();
                arrayMutatorCache.set(target, cache);
            }
            let fn = cache.get(key);
            if (fn === undefined) {
                const method = (Array.prototype as unknown as Record<string, Function>)[key];
                fn = function (this: unknown, ...args: unknown[]) {
                    return groupWrites(() => method.apply(this, args));
                };
                cache.set(key, fn);
            }
            return fn;
        }
        if (key === "includes" || key === "indexOf" || key === "lastIndexOf") {
            // Les éléments stockés sont bruts : on compare aussi avec la version brute de l'argument.
            const method = (Array.prototype as unknown as Record<string, Function>)[key];
            return function (this: unknown[], ...args: unknown[]) {
                const result = method.apply(this, args);
                if (result === false || result === -1) {
                    args[0] = toRaw(args[0]);
                    return method.apply(target, args);
                }
                return result;
            };
        }
        const value = Reflect.get(target, key, receiver);
        if (typeof key === "symbol") {
            if (key === Symbol.iterator) {
                track(target, KEYS);
            }
            return value;
        }
        if (key === "length") {
            track(target, KEYS);
            return value;
        }
        if (typeof value === "function") {
            // Méthodes de lecture (map, filter, indexOf...) : elles liront length et les index via le proxy.
            return value;
        }
        track(target, key);
        return reactive(value);
    },
    set(target, key, value, receiver) {
        const oldLength = target.length;
        const had = hasOwn.call(target, key);
        const old = (target as unknown as Target)[key as string];
        const raw = toRaw(value);
        const ok = Reflect.set(target, key, raw, receiver);
        groupWrites(() => {
            if (key === "length") {
                // Troncature : les index au-delà de la nouvelle longueur disparaissent.
                for (let i = raw as number; i < oldLength; i++) {
                    trigger(target, String(i));
                }
                if (oldLength !== target.length) {
                    trigger(target, KEYS);
                }
                return;
            }
            if (!had || !Object.is(old, raw)) {
                trigger(target, key);
            }
            if (target.length !== oldLength || !had) {
                trigger(target, KEYS);
            }
        });
        return ok;
    },
    deleteProperty(target, key) {
        const had = hasOwn.call(target, key);
        const ok = Reflect.deleteProperty(target, key);
        if (had) {
            groupWrites(() => {
                trigger(target, key);
                trigger(target, KEYS);
            });
        }
        return ok;
    },
    has(target, key) {
        if (typeof key !== "symbol") {
            track(target, key);
        }
        return Reflect.has(target, key);
    },
    ownKeys(target) {
        track(target, KEYS);
        return Reflect.ownKeys(target);
    },
};

// --- Map / Set -----------------------------------------------------------------------------------

type Collection = Map<unknown, unknown> | Set<unknown>;

const collectionMethodCache = new WeakMap<object, Map<PropertyKey, Function>>();

const collectionHandler: ProxyHandler<Collection> = {
    get(target, key) {
        if (key === RAW) {
            return target;
        }
        if (key === "size") {
            track(target, KEYS);
            return target.size;
        }
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") {
            return value;
        }
        let cache = collectionMethodCache.get(target);
        if (cache === undefined) {
            cache = new Map();
            collectionMethodCache.set(target, cache);
        }
        let fn = cache.get(key);
        if (fn === undefined) {
            fn = wrapCollectionMethod(target, key, value as Function);
            cache.set(key, fn);
        }
        return fn;
    },
};

function wrapCollectionMethod(target: Collection, key: PropertyKey, method: Function): Function {
    const isMap = target instanceof Map;
    switch (key) {
        case "get":
            return (k: unknown) => {
                track(target, keyOf(k));
                return reactive((target as Map<unknown, unknown>).get(toRaw(k)));
            };
        case "has":
            return (k: unknown) => {
                track(target, keyOf(k));
                return target.has(toRaw(k));
            };
        case "set":
            return (k: unknown, v: unknown) => {
                const map = target as Map<unknown, unknown>;
                const rk = toRaw(k);
                const had = map.has(rk);
                const old = map.get(rk);
                const raw = toRaw(v);
                map.set(rk, raw);
                groupWrites(() => {
                    if (!had) {
                        trigger(target, KEYS);
                    }
                    if (!had || !Object.is(old, raw)) {
                        trigger(target, keyOf(rk));
                        trigger(target, ITERATE);
                    }
                });
                return proxies.get(target);
            };
        case "add":
            return (v: unknown) => {
                const set = target as Set<unknown>;
                const raw = toRaw(v);
                if (!set.has(raw)) {
                    set.add(raw);
                    groupWrites(() => {
                        trigger(target, KEYS);
                        trigger(target, ITERATE);
                        trigger(target, keyOf(raw));
                    });
                }
                return proxies.get(target);
            };
        case "delete":
            return (k: unknown) => {
                const rk = toRaw(k);
                const ok = target.delete(rk);
                if (ok) {
                    groupWrites(() => {
                        trigger(target, KEYS);
                        trigger(target, ITERATE);
                        trigger(target, keyOf(rk));
                    });
                }
                return ok;
            };
        case "clear":
            return () => {
                const keys = Array.from(target.keys());
                target.clear();
                groupWrites(() => {
                    trigger(target, KEYS);
                    trigger(target, ITERATE);
                    for (const k of keys) {
                        trigger(target, keyOf(k));
                    }
                });
            };
        case "forEach":
            return (callback: (value: unknown, key: unknown, collection: unknown) => void, thisArg?: unknown) => {
                track(target, ITERATE);
                const proxy = proxies.get(target);
                (target as Map<unknown, unknown>).forEach((value, k) => {
                    callback.call(thisArg, reactive(value), isMap ? k : reactive(k), proxy);
                });
            };
        default:
            // Itérations (keys, values, entries, Symbol.iterator).
            return function (this: unknown, ...args: unknown[]) {
                // keys() d'une Map ne dépend que de l'ensemble des clés ; le reste dépend aussi des valeurs.
                track(target, isMap && key === "keys" ? KEYS : ITERATE);
                const result = method.apply(target, args);
                if (result && typeof result === "object" && typeof result.next === "function") {
                    const mode = isMap && key === "keys" ? "raw" : key === "entries" || (isMap && key === Symbol.iterator) ? "entries" : "values";
                    return wrapIterator(result as Iterator<unknown>, mode);
                }
                return result;
            };
    }
}

function wrapIterator(it: Iterator<unknown>, mode: "raw" | "values" | "entries"): IterableIterator<unknown> {
    return {
        next() {
            const r = it.next();
            if (r.done || mode === "raw") {
                return r;
            }
            const v = r.value;
            if (mode === "entries") {
                const [k, value] = v as [unknown, unknown];
                return { done: false, value: [k, reactive(value)] };
            }
            return { done: false, value: reactive(v) };
        },
        [Symbol.iterator]() {
            return this;
        },
    };
}

/** Les clés objet des Map/Set sont suivies via une clé dérivée. */
const objectKeys = new WeakMap<object, symbol>();
function keyOf(k: unknown): PropertyKey {
    if (k !== null && (typeof k === "object" || typeof k === "function")) {
        let sym = objectKeys.get(k as object);
        if (sym === undefined) {
            sym = Symbol();
            objectKeys.set(k as object, sym);
        }
        return sym;
    }
    if (typeof k === "symbol" || typeof k === "string") {
        return k;
    }
    return "\u0000" + typeof k + ":" + String(k);
}
