# Trame : conception

Ce document consigne les décisions prises lors du cadrage (inspiré d'OWL 3, sans reprendre son code), comment elles sont implémentées, et les limites connues.

## 1. Décisions

| Sujet                 | Décision                                                                                                                                                                                           | Raison                                                                                                                                                                                                                                       |
|-----------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Modèle de rendu       | **Réactivité fine** : chaque liaison du template est un petit effet qui met à jour son nœud. Le composant est construit une seule fois.                                                            | Supprime le re-rendu, le diff par composant, les fibers et le scheduler de rendu, soit la partie la plus complexe et la plus fragile d'OWL. Seul le nœud concerné change.                                                                    |
| Réactivité            | Signaux push-pull (DIRTY / CHECK), computed paresseux, graphe dynamique reconstruit à chaque exécution                                                                                             | Sans glitch. Rien n'est calculé ni chargé tant que ce n'est pas lu.                                                                                                                                                                          |
| API                   | **Un seul système public** : décorateurs `@state`, `@computed`, `@resource`, `@effect`, `@provide`, `@inject`                                                                                      | Éviter deux façons de faire la même chose. Les getters sur le prototype sont **patchables**.                                                                                                                                                 |
| Hooks de cycle de vie | Aucun (`onWillStart`, `onMounted`… supprimés)                                                                                                                                                      | `@resource` remplace `onWillStart`, `@effect` remplace `onMounted` / `onWillUnmount`, `<ErrorBoundary>` remplace `onError`.                                                                                                                  |
| Asynchrone            | Données paresseuses. **Attente avant affichage** du bloc qui les lit. Une lecture n'interrompt pas l'exécution. Transitions.                                                                       | Rien n'est chargé inutilement, on ne voit jamais d'écran à moitié rempli, et les chargements partent en parallèle.                                                                                                                           |
| `loading(x)`          | Observe sans charger. Macro dans les templates, `loading(() => this.x)` en TS.                                                                                                                     | Les arguments JS sont évalués avant l'appel : sans compilateur, la fonction ne verrait que la valeur.                                                                                                                                        |
| Props                 | Objet `props` séparé, déclaré par un schéma `props({...})` (types, validation dev, défauts). **Lecture seule profonde**, vérifiée par TypeScript (`DeepReadonly`) et `trame-check`. Aucun Proxy : l'enfant reçoit les objets du parent.                    | Distinguer props et état. Les données descendent, les actions remontent (callbacks). Un Proxy de dev a existé ; il a été retiré car il rendait dev et prod différents (identité des objets, `Map`/`Set` et champs `#privés` cassés en dev seulement). |
| Templates précompilés | Fichiers XML de templates par module ; compilation côté serveur au démarrage (`compileTemplateFiles`, exécuté par un moteur JS embarqué) ; `trame.runtime.js` sans compilateur dans le navigateur. | Une extension d'un module peut viser le template d'un autre : le template final n'est connu qu'une fois les modules installés connus. Un seul compilateur (TS) sert au navigateur et au serveur.                                             |
| Contexte              | `@provide` / `@inject`, clé = la classe                                                                                                                                                            | Évite de faire transiter des callbacks à travers les niveaux intermédiaires. Sert aussi aux services globaux (plugins).                                                                                                                      |
| Liaison de formulaire | **Pas de `t-model`**. `t-att-value` et `t-on-input` explicites.                                                                                                                                    | Choix explicite. Le runtime écrit la propriété `value` et ne réécrit pas une saisie équivalente.                                                                                                                                             |
| Templates             | XML façon QWeb, `{{ }}` et `t-*`, sans `this.`, inline via `xml\`\``                                                                                                                               | Le XML permet l'**héritage par xpath**, indispensable à un ERP modulaire.                                                                                                                                                                    |
| Extensibilité         | `patch()` de toute classe (méthodes, getters, champs décorés), `extendTemplate` / `inheritTemplate`, `Registry`                                                                                    | Équivalent côté client de l'héritage de modèles du backend Rust.                                                                                                                                                                             |
| Distribution          | Sources en plusieurs fichiers TS → un seul `dist/trame.js` (ESM, ES2019) + `dist/types`                                                                                                            | Comme OWL, mais l'ERP consomme les types TS.                                                                                                                                                                                                 |

## 2. Architecture

```
src/
  reactivity/
    core.ts       Signal, Computed, Effect, file de priorité, batch / groupWrites / nextTick
    owner.ts      Owner (scopes : nettoyage, AbortSignal, services, erreurs, montage) et Boundary (attente)
    resource.ts   Resource (données asynchrones), transitions, loading / error / refresh
    store.ts      Proxy réactif profond (objets, tableaux, Map, Set)
  compiler/
    xml.ts        parseur XML maison (sans DOM, réutilisable côté serveur pour précompiler)
    expression.ts parseur d'expressions JS (portées exactes) et réécriture (identifiants libres → composant, macros)
    parser.ts     XML → AST (directives)
    codegen.ts    AST → code JS (DOM statique cloné + effets ciblés)
    xpath.ts      héritage de templates
  runtime/
    regions.ts    régions dynamiques : Static, Switch (t-if), List (t-foreach), Out (t-out)
    dom.ts        attributs, classes, styles, propriétés, événements, refs, partie statique
    component.ts  Component, construction, rendu
    template.ts   Template, xml``, templates nommés, extensions
    helpers.ts    fonctions appelées par le code généré ($h)
    builtins.ts   Suspense, ErrorBoundary, Portal
    app.ts        mount()
  decorators.ts, props.ts, patch.ts, registry.ts, i18n.ts
```

### 2.1 Graphe réactif (`core.ts`)

- **Écriture** : les observateurs directs passent à DIRTY, les suivants à CHECK, et les effets touchés sont mis en file.
- **Lecture** : un nœud CHECK vérifie ses sources (numéros de version) avant de décider s'il se recalcule. Un computed dont la valeur ne change pas arrête la propagation.
- **Nœuds vivants et nœuds froids.** Les effets et les computed observés sont abonnés à leurs sources. Un computed non observé n'est abonné à rien : il se revalide à la lecture grâce aux versions, et reste donc collectable par le GC.
- **File d'effets** : tas binaire trié par priorité (ressources, puis rendu, puis effets utilisateur), puis par profondeur de scope (parents d'abord), puis par ordre de création. Un `t-if` qui bascule détruit ses enfants avant qu'ils ne s'exécutent avec un état incohérent.
- **Moments d'exécution** :
  - Les écritures sont appliquées au microtask suivant.
  - `batch()` applique de façon synchrone à la fin ; les gestionnaires d'événements s'exécutent dans un batch.
  - `groupWrites()` regroupe sans forcer d'exécution synchrone (utilisé par le store, pour qu'un échange `a[1] = a[998]; a[998] = x` n'expose jamais d'état intermédiaire).

### 2.2 Compilation et rendu

Un template est compilé paresseusement, au premier rendu, en une fonction JS (`new Function`). Pour chaque bloc (template, branche de `t-if`, ligne de `t-foreach`, slot) :
1. **Partie statique** : construite une seule fois avec `createElement` (ce qui évite les corrections du parseur HTML, comme `<tr>` hors de `<tbody>`), puis clonée par `cloneNode(true)`.
2. **Navigation** vers les nœuds dynamiques via `firstChild` et `nextSibling`, calculée à la compilation.
3. **Un effet par liaison** (texte, attribut, classe…).
4. **Régions** pour les structures (`t-if`, `t-foreach`, composants, slots, `t-out`) : un nœud texte vide sert d'ancre, et le contenu est inséré juste avant.

Les enfants reçoivent leurs props sous forme de **getters**. Une liaison de l'enfant qui lit `props.x` s'abonne donc directement à la source du parent : ni le parent ni l'enfant ne se ré-exécutent.

`t-foreach` réconcilie par clé. Les lignes appartenant à la plus longue sous-suite croissante (LIS) restent en place, et seules les autres sont déplacées : une rotation ne coûte qu'un seul déplacement DOM.

### 2.3 Asynchrone

- **Lecture pendant le premier chargement.** Elle démarre le chargement, renvoie `undefined` et signale la ressource « en attente » au calcul en cours.
  - Une erreur levée par ce calcul **pendant** qu'une dépendance charge est ignorée. Le calcul est réexécuté à l'arrivée de la donnée, puisqu'il y est déjà abonné.
- **Boundary** : chaque bloc en construction appartient à une frontière d'attente. Elle compte les ressources en attente lues pendant sa construction et insère le bloc quand tout est prêt.
  - **Au montage**, c'est la frontière de l'application : `mount()` n'est résolu qu'une fois tout inséré.
  - **Après le montage**, chaque nouveau contenu (branche de `t-if`, nouvelle ligne) a sa propre frontière. Pour un `t-if`, l'ancienne branche reste affichée ; pour une nouvelle ligne, un nœud vide tient sa place.
  - **`<Suspense>`** crée une frontière explicite, avec un contenu d'attente (`fallback`).
- **Dépendances d'une ressource** : un effet interne (tracker) suit ce que lit la source (`load(source, fetcher)`, le fetcher étant alors exécuté sans suivi), ou, sans source, ce que le fetcher lit avant son premier `await`. Si ces valeurs changent :
  - la ressource est relancée tout de suite si elle est observée ;
  - sinon, elle est marquée périmée et rechargée à la prochaine lecture.
- **Transitions** : les ressources relancées dans un même tick forment un groupe. Leurs valeurs sont retenues jusqu'à ce que tout le groupe soit arrivé, puis appliquées ensemble.
- **Annulation** : une requête lancée va au bout. Elle n'est annulée (AbortSignal) que si elle est remplacée ou si son scope propriétaire est détruit.
- **Observation** : `loading()`, `error()` et `refresh()` évaluent l'expression dans un calcul spécial (`PeekComputation`). Les ressources lues directement dans ce calcul ne chargent pas. Le graphe des sources est ensuite parcouru pour trouver les ressources impliquées, y compris à travers des `@computed`.

### 2.4 patch()

- **Membres copiés sur le prototype de la cible.** Un objet intermédiaire (« holder ») porte les implémentations précédentes et sert de cible à `super`. Les patchs sont donc empilables.
- **Champs d'une classe de patch** (`@state accessor ecoTax = 0`…) : ils sont posés sur l'instance en construisant la classe de patch au-dessus d'une base temporaire dont le constructeur **renvoie l'instance existante** (technique du *return override*).
  - Pour un composant ou un service, c'est fait dès la construction.
  - Pour tout autre objet, c'est fait au premier accès à un membre du patch.

## 3. Performances

Le benchmark comparatif (`npm run bench`, liste de 1 000 lignes) tourne dans jsdom, avec `requestAnimationFrame` remplacé par un microtask pour ne pas pénaliser OWL. Médianes sur une machine de développement :

| Opération                    | Trame       | OWL 3 alpha.49 |
|------------------------------|-------------|----------------|
| Créer 1 000 lignes           | ~65 ms      | ~72 ms         |
| Remplacer 1 000 lignes       | ~81 ms      | ~126 ms        |
| Mettre à jour 1 ligne sur 10 | **~0,5 ms** | ~2,9 ms        |
| Échanger 2 lignes            | ~1,9 ms     | ~2,4 ms        |
| Vider                        | ~11 ms      | ~11 ms         |

jsdom n'est pas un navigateur : ces chiffres donnent une tendance. Le gain principal vient des mises à jour : Trame modifie directement les 100 nœuds texte concernés, là où OWL re-rend la liste et compare ses 1 000 blocs. Il faudra confirmer ces mesures dans un vrai navigateur.

Taille du bundle : ~71 Ko minifié, ~24 Ko en gzip, messages d'erreur détaillés compris.

## 4. Limites connues et pistes

- **Vérification des templates (`trame-check`)** : c'est un outil à lancer à part (en CI). Il ne couvre pas les templates nommés, les extensions xpath, les templates avec `${...}`, ni les champs ajoutés par `patch()`. Le contenu de `t-slot-scope` est typé `any`.
- **`new Function`** : la compilation dans le navigateur (version complète) est incompatible avec une CSP stricte. Avec des templates précompilés et `trame.runtime.js`, il n'y a plus de `new Function`. En revanche, les templates inline `xml\`...\`` et `extendTemplate()` / `inheritTemplate()` restent compilés dans le navigateur.
- **`loading(this.x)` en TypeScript** nécessite pour l'instant la forme `loading(() => this.x)`. Une transformation de build permettra la forme courte.
- **Syntaxe des expressions** : un sous-ensemble de JavaScript est analysé (expressions, fonctions fléchées ou non, instructions dans leur corps : `const`/`let`/`var`, `if`, boucles, `try`, `switch`…). `class`, `super`, `import` et les générateurs `yield` ne sont pas pris en charge. Un `/` après `)`, `]` ou `}` est lu comme une division.
- **Objets créés après un `await`** : le scope courant est perdu (JavaScript ne propage pas de contexte à travers `await`). Leurs `@resource` et `@effect` ne sont rattachés à aucun scope : ni annulation ni arrêt automatiques. Les gestionnaires d'événements et les `@effect` s'exécutent, eux, dans un scope.
- **Champs ajoutés par `patch()` à un objet non créé par Trame** : ils sont initialisés au premier accès à un membre du patch, et non à la construction. À ce moment-là, il n'y a généralement pas de scope courant : un `@inject` y échoue, et un `@resource` / `@effect` n'est rattaché à aucun scope, donc ni nettoyage ni AbortSignal. Pour ces objets, un patch devrait se limiter aux méthodes, aux getters, à `@computed` et à `@state`.
- **Transition incomplète** : une nouvelle ligne apparue lors d'une transition et qui lit une donnée pas encore chargée s'affiche quand sa donnée arrive, sans retarder le reste de la bascule. Pour la faire attendre, il faudrait préparer tout l'affichage suivant en double, sans toucher à l'affichage courant, ce qui revient au modèle de rendu d'OWL (re-rendu + fibers) que Trame a justement écarté. C'est donc laissé tel quel : `<Suspense>` permet d'isoler une partie lente si besoin.
- **Lecture seule des props** : elle n'est pas vérifiée à l'exécution (seulement par TypeScript et `trame-check`). Une écriture faite malgré le type (cast, `any`) passe inaperçue.
- **Événements** : une fonction d'écoute partagée par type d'événement (une fiche par élément). La délégation est optionnelle (`.delegate`) : les gestionnaires délégués s'exécutent après les écouteurs directs.
- **Traductions** : appliquées une fois, à la construction de la partie statique d'un template. Changer de langue nécessite de recharger l'application.
- **Outillage** : Vite 8 (utilisé par Vitest 5) compile le TypeScript avec oxc, qui ne convertit pas encore les décorateurs standard. `vitest.config.ts` confie donc les fichiers `.ts` à esbuild. Ce contournement pourra être retiré quand oxc les prendra en charge.
- **Pas encore faits** (hors v1) : rendu serveur, routeur, devtools, animations.

## 5. Couche ERP (à venir, hors du cœur)

Les points suivants appartiennent à une couche séparée, construite sur Trame :
- **Client JSON-RPC** : batch, token, domaines `erp_search`.
- **Cache d'enregistrements réactif** : relations `Ref` / `Refs` paresseuses, qui seraient des `@resource` regroupées en un seul `read`.
- **Widgets de champ** par `FieldKind`, avec un contrôleur d'enregistrement fourni par `@provide`.
- **Vues, menus, actions.**
- **Bundles par plugin**, dans l'ordre des dépendances du backend.
