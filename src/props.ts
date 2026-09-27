/**
 * Déclaration des props d'un composant :
 *
 *   props = props({
 *       orderId: t.number(),
 *       readonly: t.boolean().default(false),
 *       onSaved: t.func<(order: Order) => void>().optional(),
 *   });
 *
 * Une seule déclaration donne : le type TS de `this.props`, la validation en mode dev
 * (types, props manquantes ou inconnues) et les valeurs par défaut.
 *
 * Les props sont en lecture seule, en profondeur : l'enfant ne modifie jamais ce que le parent lui
 * passe, il le prévient via un callback. C'est garanti par le type (DeepReadonly) et par trame-check.
 * À l'exécution, l'enfant reçoit les objets mêmes du parent, en dev comme en prod : seul l'objet
 * `this.props` refuse les écritures.
 */

import { untrack } from "./reactivity/core";
import { getConstruction } from "./runtime/component";

// --- Validateurs ---------------------------------------------------------------------------------

export class Validator<T, Optional extends boolean = false, HasDefault extends boolean = false> {
    declare readonly __type: T;
    declare readonly __optional: Optional;
    declare readonly __default: HasDefault;

    constructor(
        readonly describe: string,
        private readonly test: (value: unknown) => string | null,
        readonly isOptional = false,
        readonly hasDefault = false,
        readonly defaultValue: unknown = undefined,
        readonly nullable = false,
    ) {}

    /** Message d'erreur, ou null si la valeur est valide. */
    check(value: unknown): string | null {
        if (value === undefined && (this.isOptional || this.hasDefault)) {
            return null;
        }
        if (value === null && this.nullable) {
            return null;
        }
        return this.test(value);
    }

    /** Prop facultative. */
    optional(): Validator<T, true, HasDefault> {
        return new Validator(this.describe, this.test, true, this.hasDefault, this.defaultValue, this.nullable);
    }

    /** Valeur par défaut si la prop n'est pas passée (ou vaut undefined). */
    default(value: T): Validator<T, false, true> {
        return new Validator(this.describe, this.test, false, true, value, this.nullable);
    }

    /** Accepte aussi null. */
    orNull(): Validator<T | null, Optional, HasDefault> {
        return new Validator(this.describe, this.test, this.isOptional, this.hasDefault, this.defaultValue, true);
    }
}

type AnyValidator = Validator<unknown, boolean, boolean>;

function simple<T>(name: string, test: (value: unknown) => boolean): Validator<T> {
    return new Validator<T>(name, (v) => (test(v) ? null : `${name} attendu, reçu ${describeValue(v)}`));
}

function describeValue(value: unknown): string {
    if (value === null) {
        return "null";
    }
    if (Array.isArray(value)) {
        return "un tableau";
    }
    if (typeof value === "object") {
        const name = (value as object).constructor?.name;
        return name && name !== "Object" ? `une instance de ${name}` : "un objet";
    }
    return `${typeof value} (${String(value)})`;
}

type Shape = Record<string, AnyValidator>;

// Validateurs partagés : un validateur est immuable (optional(), default()... en créent un nouveau).
// `props = props({...})` étant évalué à chaque construction, on évite ainsi d'en recréer par instance.
const STRING = simple<string>("string", (v) => typeof v === "string");
const NUMBER = simple<number>("number", (v) => typeof v === "number");
const BOOLEAN = simple<boolean>("boolean", (v) => typeof v === "boolean");
const FUNCTION = simple<(...args: unknown[]) => unknown>("function", (v) => typeof v === "function");
const ANY = new Validator<unknown>("any", () => null);
const instanceValidators = new WeakMap<Function, AnyValidator>();

/** Validateurs de types pour props(). */
export const t = {
    string: () => STRING,
    number: () => NUMBER,
    boolean: () => BOOLEAN,
    func: <F extends (...args: never[]) => unknown = (...args: unknown[]) => unknown>() => FUNCTION as unknown as Validator<F>,
    any: <T = unknown>() => ANY as Validator<T>,
    instanceOf: <C extends abstract new (...args: never[]) => unknown>(ctor: C): Validator<InstanceType<C>> => {
        let validator = instanceValidators.get(ctor);
        if (validator === undefined) {
            validator = simple<InstanceType<C>>(ctor.name || "instance", (v) => v instanceof (ctor as unknown as Function)) as AnyValidator;
            instanceValidators.set(ctor, validator);
        }
        return validator as Validator<InstanceType<C>>;
    },
    array: <V extends AnyValidator | undefined = undefined>(item?: V) =>
        (item === undefined ? ARRAY : makeArray(item)) as Validator<V extends AnyValidator ? V["__type"][] : unknown[]>,
    object: <S extends Shape | undefined = undefined>(shape?: S) =>
        (shape === undefined ? OBJECT : makeObject(shape)) as Validator<S extends Shape ? InferShape<S> : Record<string, unknown>>,
    literal: <const L extends readonly (string | number | boolean | null)[]>(...values: L) =>
        new Validator<L[number]>(values.map((v) => JSON.stringify(v)).join(" | "), (v) =>
            values.includes(v as L[number]) ? null : `une des valeurs ${values.map((x) => JSON.stringify(x)).join(", ")} attendue, reçu ${describeValue(v)}`,
        ),
    or: <V extends AnyValidator[]>(...validators: V) =>
        new Validator<V[number]["__type"]>(validators.map((x) => x.describe).join(" | "), (v) =>
            validators.some((x) => x.check(v) === null) ? null : `${validators.map((x) => x.describe).join(" ou ")} attendu, reçu ${describeValue(v)}`,
        ),
};

function makeArray(item: AnyValidator | undefined): AnyValidator {
    return new Validator<unknown[]>("array", (v) => {
        if (!Array.isArray(v)) {
            return `tableau attendu, reçu ${describeValue(v)}`;
        }
        if (item) {
            for (let i = 0; i < v.length; i++) {
                const error = item.check(v[i]);
                if (error) {
                    return `[${i}] : ${error}`;
                }
            }
        }
        return null;
    }) as AnyValidator;
}

function makeObject(shape: Shape | undefined): AnyValidator {
    return new Validator<Record<string, unknown>>("object", (v) => {
        if (v === null || typeof v !== "object" || Array.isArray(v)) {
            return `objet attendu, reçu ${describeValue(v)}`;
        }
        if (shape) {
            for (const key in shape) {
                const error = shape[key].check((v as Record<string, unknown>)[key]);
                if (error) {
                    return `.${key} : ${error}`;
                }
            }
        }
        return null;
    }) as AnyValidator;
}

const ARRAY = makeArray(undefined);
const OBJECT = makeObject(undefined);

// --- Inférence des types -------------------------------------------------------------------------

type RequiredKeys<S extends Shape> = { [K in keyof S]: S[K]["__optional"] extends true ? never : K }[keyof S];
type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K]["__optional"] extends true ? K : never }[keyof S];

type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type InferShape<S extends Shape> = Simplify<
    { [K in RequiredKeys<S>]: S[K]["__type"] } & { [K in OptionalKeys<S>]?: S[K]["__type"] }
>;

/** Lecture seule profonde (les fonctions restent appelables). */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
    ? T
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

/** Marque (type seulement) : conserve le schéma dans le type de `this.props`. */
export declare const PROPS_SCHEMA: unique symbol;

export type PropsOf<S extends Shape> = DeepReadonly<InferShape<S>> & { readonly [PROPS_SCHEMA]?: S };

/**
 * Props à passer au composant, vues du parent : celles qui ont une valeur par défaut ou qui sont
 * facultatives peuvent être omises.
 */
export type PropsInputOf<S extends Shape> = Simplify<
    { [K in keyof S as S[K]["__optional"] extends true ? never : S[K]["__default"] extends true ? never : K]: S[K]["__type"] } & {
        [K in keyof S as S[K]["__optional"] extends true ? K : S[K]["__default"] extends true ? K : never]?: S[K]["__type"];
    }
>;

/** Props attendues par une classe de composant (utilisé par la vérification des templates). */
export type ComponentPropsInput<C> = C extends abstract new (...args: never[]) => { props: infer P }
    ? P extends { readonly [PROPS_SCHEMA]?: infer S }
        ? S extends Shape
            ? PropsInputOf<S>
            : Record<string, unknown>
        : Record<string, unknown>
    : Record<string, never>;

// --- props() -------------------------------------------------------------------------------------

/**
 * Déclare (et valide en mode dev) les props du composant en cours de construction.
 * À utiliser dans un champ : `props = props({ ... })`. Le schéma est lu une fois par classe (celui de
 * la première instance) : il ne doit pas dépendre de l'instance.
 */
export function props<S extends Shape>(schema: S): PropsOf<S> {
    const ctx = getConstruction();
    if (ctx === null) {
        throw new Error("[trame] props() doit être appelé dans un champ de composant : props = props({...})");
    }
    const raw = ctx.props as Record<string, unknown>;
    const dev = ctx.owner.app?.dev ?? false;
    const componentName = ctx.name;

    if (dev) {
        untrack(() => {
            for (const key of Object.keys(raw)) {
                if (!Object.prototype.hasOwnProperty.call(schema, key)) {
                    throw new Error(`[trame] Prop inconnue "${key}" passée à ${componentName}. Props déclarées : ${Object.keys(schema).join(", ") || "(aucune)"}`);
                }
            }
            for (const key in schema) {
                const validator = schema[key];
                const value = raw[key];
                if (value === undefined && !validator.isOptional && !validator.hasDefault && !(key in raw)) {
                    throw new Error(`[trame] Prop obligatoire "${key}" manquante pour ${componentName}`);
                }
                const error = validator.check(value);
                if (error !== null) {
                    throw new Error(`[trame] Prop "${key}" invalide pour ${componentName} : ${error}`);
                }
            }
        });
    }

    return new Proxy(raw, handlerFor(ctx.Ctor, schema)) as unknown as PropsOf<S>;
}

/**
 * Gestionnaire de la vue `this.props`, créé une fois par classe de composant (à partir du schéma de
 * sa première instance) : une instance ne coûte qu'un Proxy, sans closure ni validateur propres.
 * La vue n'expose que les clés du schéma, applique les valeurs par défaut et refuse les écritures.
 */
const handlers = new WeakMap<Function, ProxyHandler<Record<string, unknown>>>();

function handlerFor(Ctor: Function, schema: Shape): ProxyHandler<Record<string, unknown>> {
    let handler = handlers.get(Ctor);
    if (handler !== undefined) {
        return handler;
    }
    const keys = Object.keys(schema);
    const known = new Set<PropertyKey>(keys);
    const defaults = new Map<PropertyKey, unknown>();
    for (const key of keys) {
        if (schema[key].hasDefault) {
            defaults.set(key, schema[key].defaultValue);
        }
    }
    const read = (raw: Record<string, unknown>, key: PropertyKey): unknown => {
        const value = raw[key as string];
        return value === undefined && defaults.has(key) ? defaults.get(key) : value;
    };
    const fail = (key: PropertyKey): never => {
        throw new TypeError(`[trame] Les props sont en lecture seule : impossible de modifier "props.${String(key)}".`);
    };
    handler = {
        get: (raw, key) => (known.has(key) ? read(raw, key) : (Object.prototype as unknown as Record<PropertyKey, unknown>)[key]),
        has: (_, key) => known.has(key) || key in Object.prototype,
        ownKeys: () => keys,
        getOwnPropertyDescriptor: (raw, key) =>
            known.has(key) ? { value: read(raw, key), enumerable: true, configurable: true, writable: false } : undefined,
        set: (_, key) => fail(key),
        defineProperty: (_, key) => fail(key),
        deleteProperty: (_, key) => fail(key),
    };
    handlers.set(Ctor, handler);
    return handler;
}
