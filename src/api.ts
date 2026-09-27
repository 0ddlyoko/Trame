/**
 * API publique de Trame (commune à trame.js et trame.runtime.js).
 */

// Composants et application
export { Component, type ComponentClass } from "./runtime/component";
export { mount, type MountOptions, type Root } from "./runtime/app";
export { Suspense, ErrorBoundary, ErrorHandler, Portal } from "./runtime/builtins";

// Templates
export {
    xml,
    Template,
    registerTemplate,
    registerTemplates,
    registerCompiled,
    getTemplate,
    extendTemplate,
    inheritTemplate,
    type CompiledTemplate,
    type RenderFactory,
} from "./runtime/template";
export { markup, Markup } from "./runtime/regions";

// Réactivité (décorateurs)
export { state, computed, resource, load, effect, provide, inject } from "./decorators";
export { loading, error, refresh, type ResourceContext, type ResourceOptions } from "./reactivity/resource";
export { batch, untrack, nextTick } from "./reactivity/core";
export { markRaw, toRaw } from "./reactivity/store";

// Props
export { props, t, Validator, type PropsOf, type PropsInputOf, type ComponentPropsInput, type DeepReadonly } from "./props";

// Traductions
export { setTranslator, _t } from "./i18n";

// Extensibilité
export { patch } from "./patch";
export { Registry, registry, type AddOptions } from "./registry";

export const VERSION = "0.1.0";
