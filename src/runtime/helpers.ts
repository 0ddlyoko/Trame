/**
 * Fonctions appelées par le code généré des templates (`$h.xxx`).
 */

import { _t } from "../i18n";
import { Computed } from "../reactivity/core";
import { error, loading, refresh } from "../reactivity/resource";
import { builtinComponents, type Component, type ComponentClass, renderComponent, type Slots } from "./component";
import { bindAttr, bindAttrs, bindClass, bindEvent, bindProp, bindRef, bindStyle, bindText, toText, tpl } from "./dom";
import { type BlockBuilder, ListRegion, markup, OutRegion, type Root, StaticRegion, SwitchRegion } from "./regions";
import { getTemplate } from "./template";

function resolveComponent(parent: Component, name: string): ComponentClass {
    const Parent = parent.constructor as ComponentClass;
    const Ctor = Parent.components?.[name] ?? builtinComponents[name];
    if (Ctor === undefined) {
        throw new Error(
            `[trame] Composant <${name}> introuvable dans ${Parent.name}. Déclarez-le : static components = { ${name} };`,
        );
    }
    return Ctor;
}

const emptyBlock: BlockBuilder = () => [document.createTextNode("")];

/** Props = getters explicites + objet dynamique (t-props). */
function spreadProps(explicit: Record<string, unknown>, spread: () => unknown): object {
    const get = (): Record<string, unknown> => (spread() ?? {}) as Record<string, unknown>;
    return new Proxy(explicit, {
        get(target, key) {
            if (key in target) {
                return Reflect.get(target, key);
            }
            return get()[key as string];
        },
        has(target, key) {
            return key in target || key in get();
        },
        ownKeys(target) {
            return Array.from(new Set([...Reflect.ownKeys(target), ...Reflect.ownKeys(get())]));
        },
        getOwnPropertyDescriptor(target, key) {
            if (key in target) {
                return Reflect.getOwnPropertyDescriptor(target, key);
            }
            const source = get();
            return key in source ? { value: source[key as string], enumerable: true, configurable: true } : undefined;
        },
    });
}

export const helpers = {
    tpl,
    s: toText,
    text: bindText,
    attr: bindAttr,
    attrs: bindAttrs,
    cls: bindClass,
    style: bindStyle,
    prop: bindProp,
    on: bindEvent,
    ref: bindRef,
    markup,
    _t,
    loading,
    error,
    refresh,
    computed<T>(fn: () => T): Computed<T> {
        return new Computed(fn);
    },
    sw(anchor: Node, keyFn: () => number, builders: BlockBuilder[], loc?: string): SwitchRegion {
        return new SwitchRegion(anchor, keyFn, (i) => ((i as number) >= 0 ? builders[i as number] : null), loc);
    },
    /** t-key hors d'une boucle : même contenu, recréé quand la clé change. */
    keyed(anchor: Node, keyFn: () => unknown, builder: BlockBuilder, loc?: string): SwitchRegion {
        return new SwitchRegion(anchor, keyFn, () => builder, loc);
    },
    each(
        anchor: Node,
        listFn: () => unknown,
        keyFn: ((item: unknown, index: number) => unknown) | null,
        rowFn: (item: unknown, index: unknown) => Root[],
        loc?: string,
        withIndex?: number,
    ): ListRegion {
        return new ListRegion(anchor, listFn, keyFn, rowFn, loc, withIndex !== 0);
    },
    out(anchor: Node, fn: () => unknown, loc?: string): OutRegion {
        return new OutRegion(anchor, fn, loc);
    },
    comp(anchor: Node, parent: Component, name: string, props: object, slots: Slots | null, loc?: string): StaticRegion {
        return new StaticRegion(anchor, () => renderComponent(resolveComponent(parent, name), props, slots).roots, loc);
    },
    dyn(anchor: Node, parent: Component, fn: () => unknown, props: object, slots: Slots | null, loc?: string): SwitchRegion {
        return new SwitchRegion(
            anchor,
            () => {
                const value = fn();
                return typeof value === "string" ? resolveComponent(parent, value) : value;
            },
            (Ctor) => (Ctor ? () => renderComponent(Ctor as ComponentClass, props, slots).roots : null),
            loc,
        );
    },
    slot(anchor: Node, slots: Slots | null, name: string, params: object | null, fallback: BlockBuilder | null, loc?: string): StaticRegion {
        const slot = slots?.[name];
        const builder: BlockBuilder = slot ? () => slot(params ?? undefined) : (fallback ?? emptyBlock);
        return new StaticRegion(anchor, builder, loc);
    },
    call(anchor: Node, name: string, component: unknown, slots: Slots | null, params: object, loc?: string): StaticRegion {
        return new StaticRegion(anchor, () => getTemplate(name).getRender("call")(component, slots, params), loc);
    },
    props: spreadProps,
};
