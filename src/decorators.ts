/**
 * Décorateurs : l'unique façon de déclarer de la réactivité dans Trame.
 *
 *   @state accessor qty = 1;                        état réactif (objets/tableaux : réactifs en profondeur)
 *   @computed get total() { ... }                   valeur dérivée, paresseuse et mise en cache
 *   @resource accessor order = load(({ signal }) => fetchOrder(this.props.id, signal));
 *                                                   donnée asynchrone, chargée à la première lecture
 *   @effect draw() { ...; return () => cleanup }    effet de bord (après le montage pour un composant)
 *   @provide editor = new OrderEditor(this);        fournit un service au sous-arbre
 *   @inject(Rpc) rpc!: Rpc;                         récupère un service fourni par un ancêtre ou l'app
 *
 * Ils fonctionnent dans les composants, les plugins et n'importe quelle classe.
 * Ce sont des décorateurs standard (TypeScript 5+, sans experimentalDecorators).
 */

import { initPatches } from "./patch";
import { Computed, Effect, PRIORITY_USER, scheduleMicrotask, Signal, untrack } from "./reactivity/core";
import { AmbiguousService, getOwner, Owner, runWithOwner } from "./reactivity/owner";
import { type Fetcher, Resource, type ResourceOptions, type SourcedFetcher } from "./reactivity/resource";
import { reactive } from "./reactivity/store";

const STATE = Symbol("trame.state");
const RESOURCES = Symbol("trame.resources");

function storage<V>(obj: object, key: symbol): Map<PropertyKey, V> {
    let map = (obj as Record<symbol, Map<PropertyKey, V> | undefined>)[key];
    if (map === undefined) {
        map = new Map();
        Object.defineProperty(obj, key, { value: map, enumerable: false, configurable: true });
    }
    return map;
}

// --- @state --------------------------------------------------------------------------------------

/** Sérialisation JSON : champs propres + champs @state (qui sont des accessors, donc invisibles sinon). */
function stateToJSON(this: object): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(this)) {
        out[key] = (this as Record<string, unknown>)[key];
    }
    const states = (this as Record<symbol, Map<PropertyKey, Signal<unknown>> | undefined>)[STATE];
    if (states !== undefined) {
        for (const key of states.keys()) {
            if (typeof key === "string") {
                out[key] = (this as Record<string, unknown>)[key];
            }
        }
    }
    return out;
}

function ensureToJSON(instance: object): void {
    const proto = Object.getPrototypeOf(instance);
    if (proto !== null && !("toJSON" in proto)) {
        Object.defineProperty(proto, "toJSON", { value: stateToJSON, enumerable: false, configurable: true, writable: true });
    }
}

/** État réactif : `@state accessor qty = 1;` */
export function state<This extends object, V>(
    _target: ClassAccessorDecoratorTarget<This, V>,
    context: ClassAccessorDecoratorContext<This, V>,
): ClassAccessorDecoratorResult<This, V> {
    const key = context.name;
    const signalOf = (instance: This): Signal<V> => {
        const states = storage<Signal<V>>(instance, STATE);
        let sig = states.get(key);
        if (sig === undefined) {
            sig = new Signal<V>(undefined as V);
            states.set(key, sig);
        }
        return sig;
    };
    return {
        init(value: V): V {
            if (value instanceof Loader) {
                throw new Error(`[trame] "${String(key)}" : load(...) doit être utilisé avec @resource, pas @state`);
            }
            const sig = new Signal<V>(reactive(value));
            storage<Signal<V>>(this, STATE).set(key, sig);
            ensureToJSON(this);
            return value;
        },
        get(this: This): V {
            return signalOf(this).get();
        },
        set(this: This, value: V): void {
            signalOf(this).set(reactive(value));
        },
    };
}

// --- @computed -----------------------------------------------------------------------------------

/** Valeur dérivée, paresseuse et mise en cache : `@computed get total() { ... }` */
export function computed<This extends object, V>(
    getter: (this: This) => V,
    context: ClassGetterDecoratorContext<This, V>,
): (this: This) => V {
    const cacheKey = Symbol(`trame.computed.${String(context.name)}`);
    return function (this: This): V {
        let c = (this as Record<symbol, Computed<V> | undefined>)[cacheKey];
        if (c === undefined) {
            const self = this;
            c = new Computed(() => getter.call(self));
            Object.defineProperty(this, cacheKey, { value: c, enumerable: false });
        }
        return c.get();
    };
}

// --- @resource -----------------------------------------------------------------------------------

class Loader<T> {
    constructor(
        readonly fetcher: Fetcher<T> | SourcedFetcher<never, T>,
        readonly options: ResourceOptions,
        readonly source: (() => unknown) | null,
    ) {}
}

/**
 * Déclare le chargeur d'une @resource. Le type renvoyé est celui de la donnée.
 *
 * Avec une source explicite, seules les valeurs lues par la source sont suivies, et le fetcher reçoit
 * sa valeur (rien de ce qu'il lit n'est suivi, même après un `await`) :
 *   @resource accessor order = load(() => this.props.orderId, (id, { signal }) => fetchOrder(id, signal));
 *
 * Sans source, ce que le fetcher lit avant son premier `await` est suivi :
 *   @resource accessor order = load(({ signal }) => fetchOrder(this.props.orderId, signal));
 *
 * Si une dépendance change, la donnée est rechargée.
 */
export function load<T>(fetcher: Fetcher<T>, options?: ResourceOptions): T;
export function load<S, T>(source: () => S, fetcher: SourcedFetcher<S, T>, options?: ResourceOptions): T;
export function load(first: unknown, second?: unknown, third?: unknown): unknown {
    if (typeof second === "function") {
        return new Loader(second as SourcedFetcher<unknown, unknown>, (third as ResourceOptions | undefined) ?? {}, first as () => unknown);
    }
    return new Loader(first as Fetcher<unknown>, (second as ResourceOptions | undefined) ?? {}, null);
}

/** Donnée asynchrone, chargée à la première lecture. */
export function resource<This extends object, V>(
    _target: ClassAccessorDecoratorTarget<This, V>,
    context: ClassAccessorDecoratorContext<This, V>,
): ClassAccessorDecoratorResult<This, V> {
    const key = context.name;
    const get = (instance: This): Resource<V> | undefined => storage<Resource<V>>(instance, RESOURCES).get(key);
    return {
        init(value: V): V {
            if (!(value instanceof Loader)) {
                throw new Error(`[trame] @resource "${String(key)}" : initialisez-la avec load(...)`);
            }
            const loader = value as unknown as Loader<V>;
            const res =
                loader.source === null
                    ? new Resource(loader.fetcher as Fetcher<V>, getOwner(), loader.options)
                    : new Resource(loader.fetcher as SourcedFetcher<never, V>, getOwner(), loader.options, loader.source);
            storage<Resource<V>>(this, RESOURCES).set(key, res);
            return undefined as V;
        },
        get(this: This): V {
            return get(this)?.read() as V;
        },
        set(this: This, value: V): void {
            const res = get(this);
            if (res === undefined) {
                throw new Error(`[trame] @resource "${String(key)}" non initialisée`);
            }
            res.write(value);
        },
    };
}

// --- @effect -------------------------------------------------------------------------------------

/**
 * Effet de bord : la méthode s'exécute (après le montage pour un composant), puis à chaque
 * changement des valeurs qu'elle lit. Elle peut renvoyer une fonction de nettoyage.
 *
 * Chaque exécution a son propre scope : les objets qu'elle crée (avec des @resource ou des @effect)
 * sont nettoyés avant l'exécution suivante et à la destruction du propriétaire.
 */
export function effect<This extends object>(
    _method: (this: This) => void | (() => void),
    context: ClassMethodDecoratorContext<This, (this: This) => void | (() => void)>,
): void {
    const name = context.name;
    context.addInitializer(function (this: This) {
        const owner = getOwner();
        const self = this as Record<PropertyKey, () => void | (() => void)>;
        const start = () => {
            if (owner?.disposed) {
                return;
            }
            let runOwner: Owner | null = null;
            new Effect(
                () => {
                    runOwner?.dispose();
                    if (owner === null) {
                        return self[name].call(self);
                    }
                    const scope = new Owner(owner);
                    runOwner = scope;
                    const cleanup = runWithOwner(scope, () => self[name].call(self));
                    // Les effets des objets créés démarrent tout de suite (le propriétaire est affiché).
                    if (owner.live) {
                        scope.activate();
                    }
                    return cleanup;
                },
                owner,
                PRIORITY_USER,
            ).run();
        };
        if (owner !== null && !owner.live) {
            owner.onMount(start);
        } else {
            // Propriétaire déjà affiché (ou absent) : on attend la fin de la construction de l'objet,
            // sinon l'effet verrait des champs pas encore initialisés.
            scheduleMicrotask(start);
        }
    });
}

// --- @provide / @inject --------------------------------------------------------------------------

type Key<T = unknown> = abstract new (...args: never[]) => T;

/** Service fourni par une classe, instancié à la première demande. */
class LazyService {
    constructor(
        readonly Ctor: new () => unknown,
        readonly owner: Owner,
    ) {}
}

/** Classes parentes d'une classe (hors Object). */
function parentsOf(cls: Function): Function[] {
    const parents: Function[] = [];
    for (let parent = Object.getPrototypeOf(cls); parent && parent !== Function.prototype; parent = Object.getPrototypeOf(parent)) {
        parents.push(parent);
    }
    return parents;
}

/** Nom lisible d'une clé ou d'un service (messages d'erreur). */
function describeService(value: unknown): string {
    if (value instanceof LazyService) {
        return value.Ctor.name || "(classe anonyme)";
    }
    if (typeof value === "function") {
        return value.name || "(classe anonyme)";
    }
    if (value !== null && typeof value === "object") {
        return `une instance de ${(value as object).constructor?.name || "Object"}`;
    }
    return String(value);
}

/**
 * Enregistre un service sur un scope (utilisé par @provide et par mount({ provide })).
 * Il est fourni sous sa classe exacte (ou sous `key`), et aussi sous ses classes parentes : on peut
 * injecter une classe parente, tant qu'un seul service du scope en hérite.
 */
export function provideOn(owner: Owner, value: unknown, key?: Key): void {
    if (key !== undefined) {
        owner.provide(key, value, describeService);
        return;
    }
    if (typeof value === "function") {
        // Classe : instanciée à la première demande.
        const lazy = new LazyService(value as new () => unknown, owner);
        owner.provide(value, lazy, describeService);
        for (const parent of parentsOf(value)) {
            owner.provideInherited(parent, lazy);
        }
        return;
    }
    if (value === null || typeof value !== "object") {
        throw new Error("[trame] @provide : la valeur fournie doit être un objet (ou précisez une clé : @provide(Cle))");
    }
    const cls = (value as object).constructor;
    owner.provide(cls, value, describeService);
    for (const parent of parentsOf(cls)) {
        owner.provideInherited(parent, value);
    }
}

/** Services en cours d'instanciation (détection des dépendances circulaires). */
const instantiating: LazyService[] = [];

/** Récupère un service fourni par le scope courant, un ancêtre ou l'application. */
export function lookupService<T>(key: Key<T>): T {
    const owner = getOwner();
    if (owner === null) {
        throw new Error(`[trame] @inject(${key.name}) : utilisable seulement pendant la construction d'un composant, d'un plugin ou d'un objet créé par eux`);
    }
    let value = owner.lookup(key);
    if (value instanceof AmbiguousService) {
        throw new Error(
            `[trame] @inject(${key.name}) ambigu : plusieurs services en héritent au même niveau (${value.candidates.map(describeService).join(", ")}). ` +
                "Injectez la classe exacte, ou fournissez le service voulu sous cette clé : @provide(Cle).",
        );
    }
    if (value instanceof LazyService) {
        const lazy = value;
        if (instantiating.includes(lazy)) {
            const cycle = [...instantiating.slice(instantiating.indexOf(lazy)), lazy].map(describeService).join(" → ");
            throw new Error(`[trame] Dépendance circulaire entre services : ${cycle}`);
        }
        instantiating.push(lazy);
        let instance: object;
        try {
            instance = runWithOwner(lazy.owner, () =>
                untrack(() => {
                    const created = new lazy.Ctor() as object;
                    initPatches(created);
                    return created;
                }),
            );
        } finally {
            instantiating.pop();
        }
        // On remplace l'entrée paresseuse par l'instance, pour toutes les clés concernées.
        lazy.owner.replaceProvided(lazy, instance);
        value = instance;
    }
    if (value === undefined) {
        throw new Error(`[trame] Aucun service ${key.name} fourni. Ajoutez-le à mount(..., { provide: [${key.name}] }) ou via @provide.`);
    }
    return value as T;
}

/**
 * Fournit la valeur du champ à tout le sous-arbre :
 *   @provide editor = new OrderEditor(this);      (clé : la classe de la valeur et ses parentes)
 *   @provide(Editor) editor = new OrderEditor(this);
 */
export function provide<This, V>(target: undefined, context: ClassFieldDecoratorContext<This, V>): (value: V) => V;
export function provide<T>(key: Key<T>): <This, V extends T>(target: undefined, context: ClassFieldDecoratorContext<This, V>) => (value: V) => V;
export function provide(arg: unknown, context?: ClassFieldDecoratorContext): unknown {
    const make = (key: Key | undefined) =>
        function (value: unknown): unknown {
            const owner = getOwner();
            if (owner === null) {
                throw new Error("[trame] @provide : utilisable seulement dans un composant ou un plugin");
            }
            provideOn(owner, value, key);
            return value;
        };
    if (context !== undefined) {
        return make(undefined);
    }
    const key = arg as Key;
    return () => make(key);
}

/** Récupère un service : `@inject(Rpc) rpc!: Rpc;` */
export function inject<T>(key: Key<T>) {
    return function <This>(_target: undefined, _context: ClassFieldDecoratorContext<This, T>): (value: T) => T {
        return () => lookupService(key);
    };
}
