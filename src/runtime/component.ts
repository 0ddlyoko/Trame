/**
 * Composants.
 *
 * Un composant est une classe : ses champs décorés (@state, @computed, @resource...) forment son état,
 * son template statique décrit son DOM. Il n'est construit qu'une fois : il n'y a pas de re-rendu,
 * chaque liaison du template se met à jour seule.
 */

import { untrack } from "../reactivity/core";
import { getOwner, type Owner, runWithOwner } from "../reactivity/owner";
import { initPatches } from "../patch";
import type { Root } from "./regions";
import { resolveTemplate, type Template } from "./template";

export type Slots = Record<string, (scope?: unknown) => Root[]>;

export interface ComponentClass<C extends Component = Component> {
    new (): C;
    template?: Template | string;
    components?: Record<string, ComponentClass>;
    /** Rendu personnalisé (composants internes : Suspense, ErrorBoundary, Portal). */
    customRender?: (instance: C, slots: Slots | null) => Root[];
}

interface ConstructionContext {
    /** Classe du composant (le schéma des props est mis en cache par classe). */
    Ctor: Function;
    props: object;
    slots: Slots | null;
    owner: Owner;
    /** Nom du composant (messages d'erreur). */
    name: string;
}

let construction: ConstructionContext | null = null;

/** Contexte du composant en cours de construction (utilisé par props()). */
export function getConstruction(): ConstructionContext | null {
    return construction;
}

const INTERNALS = Symbol("trame.component");

/** Composants intégrés (Suspense, ErrorBoundary, Portal), utilisables sans déclaration. */
export const builtinComponents: Record<string, ComponentClass> = {};

interface Internals {
    owner: Owner;
    slots: Slots | null;
}

/**
 * Classe de base des composants.
 *
 *   class OrderForm extends Component {
 *       static template = xml`...`;
 *       static components = { OrderLineRow };
 *       props = props({ orderId: t.number() });
 *       ...
 *   }
 *
 * `template`, `components` et `props` ne sont volontairement pas déclarés ici : les sous-classes
 * les définissent sans avoir besoin du mot-clé `override`.
 */
export class Component {
    constructor() {
        const ctx = construction;
        if (ctx === null) {
            throw new Error(
                "[trame] Un composant ne peut pas être instancié avec new : utilisez mount() ou un template.",
            );
        }
        // Props brutes ; remplacées par la vue validée si le composant déclare `props = props({...})`.
        (this as unknown as { props: unknown }).props = ctx.props;
        Object.defineProperty(this, INTERNALS, { value: { owner: ctx.owner, slots: ctx.slots } satisfies Internals });
    }
}

/** Scope d'un composant (pour les utilitaires internes). */
export function ownerOf(component: Component): Owner {
    return (component as unknown as { [INTERNALS]: Internals })[INTERNALS].owner;
}

export function slotsOf(component: Component): Slots | null {
    return (component as unknown as { [INTERNALS]: Internals })[INTERNALS].slots;
}

/**
 * Construit un composant sous le scope courant (qui devient le sien) et renvoie ses racines DOM.
 */
export function renderComponent<C extends Component>(
    Ctor: ComponentClass<C>,
    props: object,
    slots: Slots | null,
): { component: C; roots: Root[] } {
    const owner = getOwner();
    if (owner === null) {
        throw new Error("[trame] Rendu d'un composant hors d'un scope");
    }
    const prev = construction;
    construction = { Ctor, props, slots, owner, name: Ctor.name || "composant" };
    let component: C;
    try {
        component = runWithOwner(owner, () =>
            untrack(() => {
                const instance = new Ctor();
                // Champs ajoutés par patch() : initialisés dès la construction.
                initPatches(instance);
                return instance;
            }),
        );
    } finally {
        construction = prev;
    }
    const custom = Ctor.customRender;
    let roots: Root[];
    if (custom) {
        roots = runWithOwner(owner, () => untrack(() => custom(component, slots)));
    } else {
        const template = resolveTemplate(Ctor);
        const render = template.getRender("component");
        roots = runWithOwner(owner, () => untrack(() => render(component, slots, null)));
    }
    return { component, roots };
}
