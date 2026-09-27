/**
 * patch() : extension d'une classe (ou d'un objet) existante, en place, façon Odoo.
 *
 *   patch(OrderLine, class extends OrderLine {
 *       @state accessor ecoTax = 0;                       // nouveau champ réactif
 *       @computed get total() { return super.total + this.ecoTax; }   // surcharge avec super
 *   });
 *
 *   patch(OrderForm, { save() { console.log("avant"); return super.save(); } });
 *
 * - Les méthodes, getters et setters sont installés sur le prototype de la classe cible :
 *   toutes les instances (existantes et futures), et les sous-classes, en profitent.
 * - `super` appelle l'implémentation précédente (patchs empilables).
 * - Les champs déclarés dans une classe de patch (y compris @state, @resource, @provide...) sont
 *   initialisés sur chaque instance : dès la construction pour les composants, et au premier accès
 *   à un membre du patch pour les autres objets.
 * - patch() renvoie une fonction qui annule le patch (à utiliser dans l'ordre inverse d'application).
 */

type AnyClass = abstract new (...args: never[]) => object;

interface ClassPatch {
    target: Function;
    patchClass: Function;
}

/** Patchs de classes (avec champs) par classe cible, dans l'ordre d'application. */
const classPatches = new Map<Function, ClassPatch[]>();
/** Patchs déjà initialisés pour chaque instance. */
const initialized = new WeakMap<object, Set<ClassPatch>>();
/** Incrémentée à chaque ajout ou retrait d'un patch de classe. */
let patchVersion = 0;
/** Version des patchs pour laquelle chaque instance est à jour : évite tout parcours aux appels suivants. */
const upToDate = new WeakMap<object, number>();

let stampTarget: object | null = null;
/** Classe de base temporaire : son constructeur renvoie l'instance existante, sur laquelle les champs du patch sont posés. */
class Stamp {
    constructor() {
        return stampTarget!;
    }
}

function runPatchFields(instance: object, patch: ClassPatch): void {
    const saved = Object.getPrototypeOf(patch.patchClass);
    const prevTarget = stampTarget;
    Object.setPrototypeOf(patch.patchClass, Stamp);
    stampTarget = instance;
    try {
        Reflect.construct(patch.patchClass, []);
    } finally {
        stampTarget = prevTarget;
        Object.setPrototypeOf(patch.patchClass, saved);
    }
}

/** Initialise sur `instance` les champs de tous les patchs qui la concernent (idempotent). */
export function initPatches(instance: object): void {
    if (classPatches.size === 0 || upToDate.get(instance) === patchVersion) {
        return;
    }
    const obj = instance;
    // Première rencontre (ou nouveau patch depuis) : classes de la chaîne de prototypes, de la plus générale à la plus spécifique.
    const chain: Function[] = [];
    for (let proto = Object.getPrototypeOf(obj); proto !== null && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
        if (Object.prototype.hasOwnProperty.call(proto, "constructor")) {
            chain.unshift(proto.constructor);
        }
    }
    let done = initialized.get(obj);
    for (const cls of chain) {
        const patches = classPatches.get(cls);
        if (patches === undefined) {
            continue;
        }
        for (const p of patches) {
            if (done?.has(p)) {
                continue;
            }
            if (done === undefined) {
                done = new Set();
                initialized.set(obj, done);
            }
            done.add(p);
            runPatchFields(obj, p);
        }
    }
    upToDate.set(obj, patchVersion);
}

function findDescriptor(proto: object | null, key: PropertyKey): PropertyDescriptor | undefined {
    for (let p = proto; p !== null; p = Object.getPrototypeOf(p)) {
        const descriptor = Object.getOwnPropertyDescriptor(p, key);
        if (descriptor !== undefined) {
            return descriptor;
        }
    }
    return undefined;
}

/** Enveloppe un membre pour initialiser les champs du patch au premier accès. */
function withLazyInit(descriptor: PropertyDescriptor): PropertyDescriptor {
    const wrap = (fn: Function) => {
        const wrapper = function (this: object, ...args: unknown[]) {
            if (this !== null && typeof this === "object") {
                initPatches(this);
            }
            return fn.apply(this, args);
        };
        // Marques posées par les décorateurs (ex. getter @state, pour la sérialisation JSON).
        for (const symbol of Object.getOwnPropertySymbols(fn)) {
            (wrapper as unknown as Record<symbol, unknown>)[symbol] = (fn as unknown as Record<symbol, unknown>)[symbol];
        }
        return wrapper;
    };
    const result: PropertyDescriptor = { ...descriptor };
    if (typeof descriptor.value === "function") {
        result.value = wrap(descriptor.value);
    }
    if (descriptor.get) {
        result.get = wrap(descriptor.get) as () => unknown;
    }
    if (descriptor.set) {
        result.set = wrap(descriptor.set) as (v: unknown) => void;
    }
    return result;
}

const STATIC_SKIP = new Set<PropertyKey>(["length", "name", "prototype", "caller", "arguments"]);

function isClass(value: unknown): value is Function {
    return typeof value === "function" && value.prototype !== undefined && /^class[\s{]/.test(Function.prototype.toString.call(value));
}

/**
 * Étend `target` (classe ou objet) avec `extension` (classe `extends target` ou objet littéral).
 * Renvoie une fonction d'annulation.
 */
export function patch<T extends AnyClass | object>(target: T, extension: object): () => void {
    const targetIsClass = typeof target === "function";
    const proto: object = targetIsClass ? (target as Function).prototype : target;
    const extensionIsClass = isClass(extension);
    const home: object = extensionIsClass ? (extension as Function).prototype : extension;

    const members = Object.getOwnPropertyDescriptors(home) as Record<PropertyKey, PropertyDescriptor>;
    if (extensionIsClass) {
        Reflect.deleteProperty(members, "constructor");
    }
    const keys = Reflect.ownKeys(members);

    // Objet intermédiaire : il porte les implémentations précédentes, cible de `super`.
    const holder = Object.create(proto);
    const previous = new Map<PropertyKey, PropertyDescriptor | undefined>();
    for (const key of keys) {
        const own = Object.getOwnPropertyDescriptor(proto, key);
        previous.set(key, own);
        const original = own ?? findDescriptor(Object.getPrototypeOf(proto), key);
        Object.defineProperty(holder, key, original ?? { value: undefined, configurable: true, writable: true });
    }
    Object.setPrototypeOf(home, holder);

    let record: ClassPatch | null = null;
    if (extensionIsClass && targetIsClass) {
        record = { target: target as Function, patchClass: extension as Function };
        const list = classPatches.get(target as Function) ?? [];
        list.push(record);
        classPatches.set(target as Function, list);
        patchVersion++;
    }

    for (const key of keys) {
        let descriptor = members[key];
        if (record !== null) {
            descriptor = withLazyInit(descriptor);
        }
        Object.defineProperty(proto, key, { ...descriptor, enumerable: targetIsClass ? false : descriptor.enumerable, configurable: true });
    }

    // Membres statiques d'une classe de patch (ex. static components = {...})
    const previousStatics = new Map<PropertyKey, PropertyDescriptor | undefined>();
    if (extensionIsClass && targetIsClass) {
        for (const key of Reflect.ownKeys(extension)) {
            if (STATIC_SKIP.has(key) || key === (Symbol as { metadata?: symbol }).metadata) {
                continue;
            }
            previousStatics.set(key, Object.getOwnPropertyDescriptor(target, key));
            Object.defineProperty(target, key, { ...Object.getOwnPropertyDescriptor(extension, key)!, configurable: true });
        }
    }

    return () => {
        for (const [key, descriptor] of previous) {
            if (descriptor === undefined) {
                Reflect.deleteProperty(proto, key);
            } else {
                Object.defineProperty(proto, key, descriptor);
            }
        }
        for (const [key, descriptor] of previousStatics) {
            if (descriptor === undefined) {
                Reflect.deleteProperty(target, key);
            } else {
                Object.defineProperty(target, key, descriptor);
            }
        }
        if (record !== null) {
            const list = classPatches.get(record.target);
            if (list) {
                const index = list.indexOf(record);
                if (index !== -1) {
                    list.splice(index, 1);
                }
                if (list.length === 0) {
                    classPatches.delete(record.target);
                }
            }
            patchVersion++;
        }
    };
}
