/**
 * Utilitaires de test pour les composants Trame (Vitest, Jest... avec un DOM : jsdom, happy-dom).
 *
 *   import { cleanup, click, render, settle } from "trame/testing";
 *
 *   afterEach(cleanup);
 *
 *   test("compteur", async () => {
 *       const { html } = await render(Counter, { props: { start: 1 } });
 *       await click("button");
 *       expect(html()).toBe("<button>2</button>");
 *   });
 */

import { type Component, type ComponentClass, mount, type MountOptions, nextTick, type Root } from "./index";

export interface Rendered<C extends Component> {
    /** Élément (attaché au document) dans lequel le composant est monté. */
    fixture: HTMLElement;
    root: Root<C>;
    component: C;
    /** HTML actuel du composant. */
    html(): string;
    /** Démonte le composant et retire le fixture du document. */
    destroy(): void;
}

const rendered = new Set<Rendered<Component>>();

/**
 * Monte un composant dans un élément attaché au document (mode dev activé par défaut).
 * La promesse est résolue une fois le composant affiché, donc ses données chargées.
 */
export async function render<C extends Component>(Ctor: ComponentClass<C>, options: MountOptions = {}): Promise<Rendered<C>> {
    const fixture = document.createElement("div");
    fixture.setAttribute("data-trame-fixture", "");
    document.body.appendChild(fixture);
    let root: Root<C>;
    try {
        root = await mount(Ctor, fixture, { dev: true, ...options });
    } catch (error) {
        fixture.remove();
        throw error;
    }
    const result: Rendered<C> = {
        fixture,
        root,
        component: root.component,
        html: () => fixture.innerHTML,
        destroy() {
            rendered.delete(result as unknown as Rendered<Component>);
            root.destroy();
            fixture.remove();
        },
    };
    rendered.add(result as unknown as Rendered<Component>);
    return result;
}

/** Démonte tous les composants montés avec render() (à appeler dans afterEach). */
export function cleanup(): void {
    for (const r of Array.from(rendered)) {
        r.destroy();
    }
}

/** Attend que les promesses en cours et les mises à jour du DOM soient traitées. */
export async function settle(rounds = 10): Promise<void> {
    for (let i = 0; i < rounds; i++) {
        await nextTick();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
}

export interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
}

/** Promesse contrôlée par le test (pour simuler une réponse serveur au moment voulu). */
export function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

export interface WaitForOptions {
    /** Délai maximal en ms (défaut : 1000). */
    timeout?: number;
    /** Intervalle entre deux essais en ms (défaut : 10). */
    interval?: number;
}

/**
 * Réessaie `check` jusqu'à ce qu'il ne lève plus d'erreur (ex. un expect), puis renvoie son résultat.
 * Au-delà du délai, relance la dernière erreur.
 */
export async function waitFor<T>(check: () => T | Promise<T>, options: WaitForOptions = {}): Promise<T> {
    const timeout = options.timeout ?? 1000;
    const interval = options.interval ?? 10;
    const start = Date.now();
    for (;;) {
        try {
            return await check();
        } catch (error) {
            if (Date.now() - start >= timeout) {
                throw error;
            }
        }
        await nextTick();
        await new Promise<void>((resolve) => setTimeout(resolve, interval));
    }
}

type Target = Element | string;

/** Trouve un élément (lève une erreur explicite s'il n'existe pas). */
export function find<E extends Element = HTMLElement>(selector: string, root: ParentNode = document): E {
    const el = root.querySelector<E>(selector);
    if (el === null) {
        const context = root instanceof Element ? root.outerHTML : document.body.innerHTML;
        throw new Error(`[trame/testing] Aucun élément ne correspond à "${selector}" dans :\n${context.slice(0, 500)}`);
    }
    return el;
}

function resolve(target: Target, root: ParentNode): Element {
    return typeof target === "string" ? find(target, root) : target;
}

/** Déclenche un événement (qui remonte), puis attend les mises à jour. */
export async function trigger(target: Target, type: string, init: EventInit = {}, root: ParentNode = document): Promise<void> {
    const el = resolve(target, root);
    el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
    await nextTick();
}

/** Clic sur un élément, puis attente des mises à jour. */
export async function click(target: Target, root: ParentNode = document): Promise<void> {
    const el = resolve(target, root);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await nextTick();
}

/** Saisie dans un champ : modifie sa valeur et déclenche « input » (et « change » si demandé). */
export async function input(target: Target, value: string, options: { change?: boolean } = {}, root: ParentNode = document): Promise<void> {
    const el = resolve(target, root) as HTMLInputElement;
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    if (options.change) {
        el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await nextTick();
}

/** Coche ou décoche une case (ou un bouton radio) et déclenche « change ». */
export async function check(target: Target, checked = true, root: ParentNode = document): Promise<void> {
    const el = resolve(target, root) as HTMLInputElement;
    el.checked = checked;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
}
