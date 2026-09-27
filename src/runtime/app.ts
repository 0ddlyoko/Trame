/**
 * Montage d'une application.
 *
 *   const root = await mount(OrderForm, document.body, {
 *       props: { orderId: 42 },
 *       provide: [Rpc, new User(...)],     // services disponibles via @inject
 *       dev: true,                          // validations et messages d'erreur détaillés
 *   });
 *   root.destroy();
 *
 * La promesse est résolue une fois le composant inséré, c'est-à-dire quand toutes les données
 * lues pendant sa construction sont chargées.
 */

import { untrack } from "../reactivity/core";
import { type AppContext, Boundary, Owner, runWithOwner } from "../reactivity/owner";
import { provideOn } from "../decorators";
import { type Component, type ComponentClass, renderComponent } from "./component";
import { type Item, insertItem, removeItem } from "./regions";

export interface MountOptions {
    /** Props du composant racine. */
    props?: object;
    /** Services fournis à toute l'application : classes (instanciées à la demande) ou instances. */
    provide?: unknown[];
    /** Mode développement : validation des props, messages détaillés. */
    dev?: boolean;
    /**
     * Appelé pour une erreur non interceptée :
     * - erreur de rendu hors de toute <ErrorBoundary> (par défaut : console.error, puis destruction) ;
     * - erreur d'action hors de tout <ErrorHandler> (par défaut : console.error ; l'application reste montée).
     */
    onError?: (error: unknown) => void;
}

export interface Root<C extends Component = Component> {
    readonly component: C;
    destroy(): void;
}

export function mount<C extends Component>(Ctor: ComponentClass<C>, target: Element, options: MountOptions = {}): Promise<Root<C>> {
    return new Promise<Root<C>>((resolve, reject) => {
        let mounted = false;
        let destroyed = false;
        let item: Item | null = null;

        const destroy = () => {
            if (destroyed) {
                return;
            }
            destroyed = true;
            boundary.cancel();
            if (item !== null && mounted) {
                removeItem(item);
            }
            owner.dispose();
        };

        const app: AppContext = {
            dev: options.dev ?? false,
            handleUncaughtError(error: unknown) {
                if (!mounted) {
                    destroy();
                    reject(error);
                    return;
                }
                if (options.onError) {
                    options.onError(error);
                    return;
                }
                console.error(error);
                destroy();
            },
            handleActionError(error: unknown) {
                // Une action ratée (enregistrement refusé...) ne démonte pas l'application.
                if (options.onError) {
                    options.onError(error);
                } else {
                    console.error(error);
                }
            },
        };

        const owner = new Owner(null);
        owner.app = app;
        for (const service of options.provide ?? []) {
            provideOn(owner, service);
        }

        let component!: C;
        const boundary = new Boundary(
            () => {
                if (destroyed || item === null) {
                    return;
                }
                insertItem(item, target, null);
                mounted = true;
                owner.activate();
                resolve({ component, destroy });
            },
            (error) => app.handleUncaughtError(error),
        );
        owner.boundary = boundary;

        const componentOwner = new Owner(owner);
        try {
            const result = runWithOwner(componentOwner, () =>
                untrack(() => renderComponent(Ctor, options.props ?? {}, null)),
            );
            component = result.component;
            item = { roots: result.roots, owner: componentOwner, placeholder: null };
        } catch (error) {
            destroy();
            reject(error);
            return;
        }
        if (!destroyed) {
            boundary.done();
        }
    });
}
