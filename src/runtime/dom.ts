/**
 * Opérations DOM utilisées par le code généré des templates.
 */

import { TRANSLATABLE_ATTRIBUTES, translateTemplateText } from "../i18n";
import { annotateError, batch } from "../reactivity/core";
import { getOwner, type Owner, runWithOwner } from "../reactivity/owner";
import { Markup, renderEffect } from "./regions";

const SVG_NS = "http://www.w3.org/2000/svg";
const MATH_NS = "http://www.w3.org/1998/Math/MathML";
const XLINK_NS = "http://www.w3.org/1999/xlink";

type Spec = string | { r: string } | [string, [string, string][] | 0, Spec[] | 0, number, 1?];

function buildNode(spec: Spec, parentNs: number): Node {
    if (typeof spec === "string") {
        return document.createTextNode(translateTemplateText(spec));
    }
    if (!Array.isArray(spec)) {
        return document.createTextNode(spec.r);
    }
    const [tag, attrs, children, nsCode, noTranslate] = spec;
    const ns = nsCode || parentNs;
    const el = ns === 1 ? document.createElementNS(SVG_NS, tag) : ns === 2 ? document.createElementNS(MATH_NS, tag) : document.createElement(tag);
    if (attrs) {
        for (const [name, value] of attrs) {
            const text = !noTranslate && TRANSLATABLE_ATTRIBUTES.has(name) ? translateTemplateText(value) : value;
            if (name.startsWith("xlink:")) {
                el.setAttributeNS(XLINK_NS, name, text);
            } else {
                el.setAttribute(name, text);
            }
        }
    }
    if (children) {
        // Les enfants d'un <foreignObject> repassent en HTML.
        const childNs = tag === "foreignObject" ? 0 : ns;
        for (const child of children) {
            el.appendChild(buildNode(child, childNs));
        }
    }
    return el;
}

/**
 * Partie statique d'un bloc : construite une seule fois (à la première utilisation), puis clonée.
 * Construire via createElement (et non innerHTML) évite les corrections du parseur HTML
 * (ex. <tr> hors de <tbody>) qui fausseraient la navigation vers les nœuds dynamiques.
 */
export function tpl(specs: Spec[], fragment: number): () => Node {
    let template: Node | null = null;
    return () => {
        if (template === null) {
            if (fragment) {
                const frag = document.createDocumentFragment();
                for (const spec of specs) {
                    frag.appendChild(buildNode(spec, 0));
                }
                template = frag;
            } else {
                template = buildNode(specs[0], 0);
            }
        }
        return template.cloneNode(true);
    };
}

/** Conversion d'une valeur en texte affiché. */
export function toText(value: unknown): string {
    if (value === null || value === undefined || value === false) {
        return "";
    }
    return value instanceof Markup ? value.html : String(value);
}

export function bindText(node: Text, fn: () => string, loc?: string): void {
    renderEffect(() => {
        const value = fn();
        if (node.data !== value) {
            node.data = value;
        }
    }, loc);
}

export function bindAttr(el: Element, name: string, fn: () => unknown, loc?: string): void {
    let prev: unknown = undefined;
    let first = true;
    renderEffect(() => {
        const value = fn();
        if (!first && value === prev) {
            return;
        }
        first = false;
        prev = value;
        setAttribute(el, name, value);
    }, loc);
}

function setAttribute(el: Element, name: string, value: unknown): void {
    if (value === null || value === undefined || value === false) {
        if (name.startsWith("xlink:")) {
            el.removeAttributeNS(XLINK_NS, name.slice(6));
        } else {
            el.removeAttribute(name);
        }
        return;
    }
    const text = value === true ? "" : String(value);
    if (name.startsWith("xlink:")) {
        el.setAttributeNS(XLINK_NS, name, text);
    } else {
        el.setAttribute(name, text);
    }
}

/** Attributs dynamiques en bloc (t-att="{...}"). */
export function bindAttrs(el: Element, fn: () => unknown, loc?: string): void {
    let prev: Record<string, unknown> = {};
    renderEffect(() => {
        const value = (fn() ?? {}) as Record<string, unknown>;
        for (const name in prev) {
            if (!(name in value)) {
                el.removeAttribute(name);
            }
        }
        for (const name in value) {
            if (value[name] !== prev[name]) {
                setAttribute(el, name, value[name]);
            }
        }
        prev = { ...value };
    }, loc);
}

/**
 * Propriétés de formulaire (value, checked...) : on écrit la propriété, pas l'attribut
 * (l'attribut n'est que la valeur initiale une fois que l'utilisateur a tapé).
 */
export function bindProp(el: Element, name: string, fn: () => unknown, loc?: string): void {
    const target = el as unknown as Record<string, unknown>;
    renderEffect(() => {
        const value = fn();
        if (name === "value") {
            const input = el as HTMLInputElement;
            if (!sameInputValue(input.value, value)) {
                input.value = value === null || value === undefined ? "" : String(value);
            }
        } else {
            const bool = !!value;
            if (target[name] !== bool) {
                target[name] = bool;
            }
        }
    }, loc);
}

/**
 * La valeur affichée correspond-elle déjà à la valeur voulue ?
 * Évite d'écraser une saisie en cours : « 1. » ou « 01 » correspondent au nombre 1.
 */
function sameInputValue(current: string, wanted: unknown): boolean {
    if (wanted === null || wanted === undefined) {
        return current === "";
    }
    if (typeof wanted === "number") {
        return current !== "" && Number(current) === wanted;
    }
    return current === String(wanted);
}

function classNames(value: unknown, out: Set<string>): void {
    if (!value) {
        return;
    }
    if (typeof value === "string") {
        for (const name of value.split(/\s+/)) {
            if (name) {
                out.add(name);
            }
        }
    } else if (Array.isArray(value)) {
        for (const v of value) {
            classNames(v, out);
        }
    } else if (typeof value === "object") {
        for (const key in value as Record<string, unknown>) {
            if ((value as Record<string, unknown>)[key]) {
                classNames(key, out);
            }
        }
    }
}

/** Classes dynamiques : chaîne, tableau ou objet { classe: condition }. Les classes statiques sont conservées. */
export function bindClass(el: Element, fn: () => unknown, loc?: string): void {
    const statics = new Set(Array.from(el.classList));
    let prev = new Set<string>();
    renderEffect(() => {
        const next = new Set<string>();
        classNames(fn(), next);
        for (const name of prev) {
            if (!next.has(name) && !statics.has(name)) {
                el.classList.remove(name);
            }
        }
        for (const name of next) {
            if (!prev.has(name)) {
                el.classList.add(name);
            }
        }
        prev = next;
    }, loc);
}

function toKebab(name: string): string {
    return name.startsWith("--") ? name : name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}

/** Style dynamique : chaîne CSS ou objet { propriété: valeur }. */
export function bindStyle(el: HTMLElement | SVGElement, fn: () => unknown, loc?: string): void {
    const staticStyle = el.getAttribute("style") ?? "";
    let prev: Record<string, string> = {};
    renderEffect(() => {
        const value = fn();
        if (value === null || value === undefined || typeof value === "string") {
            const css = (value as string | null | undefined) ?? "";
            el.style.cssText = staticStyle && css ? `${staticStyle};${css}` : staticStyle || css;
            prev = {};
            return;
        }
        const next: Record<string, string> = {};
        for (const key in value as Record<string, unknown>) {
            const v = (value as Record<string, unknown>)[key];
            if (v !== null && v !== undefined && v !== false) {
                next[toKebab(key)] = String(v);
            }
        }
        for (const key in prev) {
            if (!(key in next)) {
                el.style.removeProperty(key);
            }
        }
        for (const key in next) {
            if (next[key] !== prev[key]) {
                el.style.setProperty(key, next[key]);
            }
        }
        prev = next;
    }, loc);
}

/**
 * Événement. Modificateurs : prevent, stop, self, capture, once, passive.
 * Le gestionnaire s'exécute en batch (le DOM est à jour dès qu'il se termine) et ses erreurs,
 * y compris celles d'une promesse renvoyée, remontent au gestionnaire d'erreurs du composant.
 */
export function bindEvent(el: Element, type: string, handler: (ev: Event) => unknown, modifiers: string, loc?: string): void {
    const kind = eventKind(type, modifiers);
    (el as unknown as Record<symbol, EventRecord>)[kind.key] = { handler, owner: getOwner(), loc };
    if (!kind.delegated) {
        el.addEventListener(type, kind.listener, kind.options);
    }
}

/**
 * Événements qui ne remontent pas l'arbre DOM : `.delegate` n'a pas de sens pour eux, un écouteur
 * est alors posé sur l'élément (comportement normal).
 */
const NON_BUBBLING = new Set([
    "focus",
    "blur",
    "mouseenter",
    "mouseleave",
    "pointerenter",
    "pointerleave",
    "load",
    "unload",
    "error",
    "abort",
    "scroll",
    "scrollend",
    "resize",
    "toggle",
    "invalid",
    "play",
    "pause",
    "ended",
    "volumechange",
    "timeupdate",
    "loadedmetadata",
    "canplay",
]);

/** Gestionnaire posé sur un élément (rangé dans une propriété de l'élément). */
interface EventRecord {
    handler: (ev: Event) => unknown;
    owner: Owner | null;
    loc: string | undefined;
}

/** Une combinaison « type d'événement + modificateurs » : une seule fonction d'écoute, partagée. */
interface EventKind {
    key: symbol;
    listener: (this: Element, ev: Event) => void;
    options: AddEventListenerOptions | undefined;
    /** `.delegate` : un seul écouteur sur le document, aucun sur les éléments. */
    delegated: boolean;
}

const eventKinds = new Map<string, EventKind>();

/**
 * Fonction d'écoute partagée par tous les éléments ayant le même type d'événement et les mêmes
 * modificateurs : au lieu d'une closure par élément, chaque élément ne porte qu'une fiche
 * { gestionnaire, scope, localisation }. Moins de mémoire sur les grandes listes.
 */
function eventKind(type: string, modifiers: string): EventKind {
    const id = `${type}|${modifiers}`;
    let kind = eventKinds.get(id);
    if (kind !== undefined) {
        return kind;
    }
    const mods = modifiers ? modifiers.split(",") : [];
    if (mods.includes("delegate")) {
        if (NON_BUBBLING.has(type) || typeof document === "undefined") {
            // Événement qui ne remonte pas : écouteur sur l'élément, comme sans .delegate.
            kind = eventKind(type, mods.filter((m) => m !== "delegate").join(","));
        } else {
            kind = delegatedKind(type, id, mods);
        }
        eventKinds.set(id, kind);
        return kind;
    }
    const prevent = mods.includes("prevent");
    const stop = mods.includes("stop");
    const self = mods.includes("self");
    const key = Symbol(`trame.on.${id}`);
    const listener = function (this: Element, ev: Event): void {
        const record = (this as unknown as Record<symbol, EventRecord | undefined>)[key];
        if (record === undefined || (self && ev.target !== this)) {
            return;
        }
        if (prevent) {
            ev.preventDefault();
        }
        if (stop) {
            ev.stopPropagation();
        }
        runHandler(record, ev);
    };
    const options =
        mods.includes("capture") || mods.includes("once") || mods.includes("passive")
            ? { capture: mods.includes("capture"), once: mods.includes("once"), passive: mods.includes("passive") }
            : undefined;
    kind = { key, listener, options, delegated: false };
    eventKinds.set(id, kind);
    return kind;
}

/**
 * Délégation (`t-on-click.delegate`) : un seul écouteur sur le document pour ce type d'événement.
 * À chaque événement, on remonte depuis l'élément visé et on exécute les gestionnaires rencontrés.
 * Utile pour les très grandes listes : aucun écouteur n'est posé sur chaque ligne.
 * Particularités : ces gestionnaires s'exécutent après les écouteurs directs (l'événement doit
 * d'abord remonter jusqu'au document), et `.stop` arrête la remontée entre gestionnaires délégués.
 */
function delegatedKind(type: string, id: string, mods: string[]): EventKind {
    const capture = mods.includes("capture");
    const passive = mods.includes("passive");
    const key = Symbol(`trame.on.${id}`);
    const group = delegationGroup(type, capture, passive);
    group.kinds.push({
        key,
        prevent: mods.includes("prevent"),
        stop: mods.includes("stop"),
        self: mods.includes("self"),
        once: mods.includes("once"),
    });
    return { key, listener: group.listener, options: { capture, passive }, delegated: true };
}

interface DelegatedKind {
    key: symbol;
    prevent: boolean;
    stop: boolean;
    self: boolean;
    once: boolean;
}

interface DelegationGroup {
    kinds: DelegatedKind[];
    listener: (ev: Event) => void;
}

const delegationGroups = new Map<string, DelegationGroup>();

/**
 * Un seul écouteur sur le document par type d'événement (et options) : il remonte une fois depuis
 * l'élément visé et exécute, à chaque niveau, les gestionnaires délégués trouvés, quels que soient
 * leurs modificateurs. Ainsi `.stop` arrête bien tous les gestionnaires délégués des ancêtres.
 */
function delegationGroup(type: string, capture: boolean, passive: boolean): DelegationGroup {
    const id = `${type}|${capture}|${passive}`;
    let group = delegationGroups.get(id);
    if (group !== undefined) {
        return group;
    }
    const kinds: DelegatedKind[] = [];
    const listener = (ev: Event): void => {
        // composedPath() traverse les Shadow DOM (au niveau du document, ev.target est l'hôte).
        const path = typeof ev.composedPath === "function" ? ev.composedPath() : [];
        const target = (path.length ? path[0] : ev.target) as Node | null;
        let index = 0;
        let node = target;
        while (node !== null && node !== document) {
            const holder = node as unknown as Record<symbol, EventRecord | undefined>;
            let stopped = false;
            for (const kind of kinds) {
                const record = holder[kind.key];
                if (record === undefined || (kind.self && target !== node)) {
                    continue;
                }
                if (kind.prevent) {
                    ev.preventDefault();
                }
                if (kind.once) {
                    delete holder[kind.key];
                }
                runHandler(record, ev);
                stopped ||= kind.stop;
            }
            if (stopped) {
                ev.stopPropagation();
                return;
            }
            node = path.length ? ((path[++index] as Node | undefined) ?? null) : node.parentNode;
        }
    };
    document.addEventListener(type, listener, { capture, passive });
    group = { kinds, listener };
    delegationGroups.set(id, group);
    return group;
}

/**
 * Exécute un gestionnaire en batch (le DOM est à jour dès qu'il se termine). Ses erreurs, y compris
 * celles d'une promesse renvoyée, sont des erreurs d'actions : elles remontent au <ErrorHandler> le
 * plus proche (voir Owner.handleActionError), pas aux <ErrorBoundary>.
 * Il s'exécute dans le scope du composant : un objet qu'il crée (avec des @resource ou des @effect)
 * est nettoyé à la destruction du composant.
 */
function runHandler(record: EventRecord, ev: Event): void {
    const { owner, loc } = record;
    if (owner?.disposed) {
        return;
    }
    const report = (error: unknown) => {
        if (owner !== null) {
            owner.handleActionError(annotateError(error, loc, owner));
        } else {
            console.error(error);
        }
    };
    try {
        runWithOwner(owner, () =>
            batch(() => {
                const result = record.handler(ev) as Promise<unknown> | undefined;
                if (result !== null && typeof result === "object" && typeof result.then === "function") {
                    result.then(undefined, report);
                }
            }),
        );
    } catch (error) {
        report(error);
    }
}

/** t-ref : affecte l'élément tout de suite, et null à la destruction. */
export function bindRef(el: Element, setter: (el: Element | null) => void): void {
    setter(el);
    getOwner()?.onCleanup(() => setter(null));
}
