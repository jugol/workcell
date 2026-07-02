# Workcell

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-20%2B-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![pnpm 9.15+](https://img.shields.io/badge/pnpm-9.15%2B-F69220.svg?logo=pnpm&logoColor=white)](https://pnpm.io)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

**Workcell est une plateforme d'opérations multi-agents spécialisée pour piloter des projets
de développement : un conseil humain fixe la direction, et une équipe IA — Orchestrateur,
Développeur, Designer, QA — livre avec des preuves.**

[English](./README.md) · [한국어](./README.ko.md) · [日本語](./README.ja.md) · [简体中文](./README.zh-CN.md) · [繁體中文](./README.zh-TW.md) · [Español](./README.es.md) · [Français](./README.fr.md) · [Deutsch](./README.de.md) · [Português (BR)](./README.pt-BR.md) · [Русский](./README.ru.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md) · [Bahasa Indonesia](./README.id.md) · [Italiano](./README.it.md)

Vous restez le conseil : vous décidez de la direction, des approbations et des politiques.
Les agents assument des rôles fonctionnels, prennent en charge les tickets et laissent
derrière eux à la fois des livrables et la **preuve** que le travail est réellement accompli.
Le plan de contrôle gère l'organisation — projets, tickets, budgets, gouvernance et journal
d'audit immuable — pendant que vous consacrez votre temps aux décisions qui comptent.

> Opérer comme une entreprise · exécuter par tickets · la conception comme source de vérité · laisser les humains juger.

---

## Philosophie

Workcell a une vision arrêtée sur la façon dont un projet de développement doit être mené.
Quatre engagements fondamentaux structurent l'ensemble du produit :

### 1. L'humain est le conseil, pas un observateur passif

Il n'y a pas de « company zéro humain » ici. L'humain possède la direction, les approbations
et les politiques ; les agents possèdent l'exécution. Chaque point de contrôle important —
approbation de conception, validation des preuves, budget, recrutement — aboutit à une
décision humaine, consignée dans un journal d'audit immuable.

### 2. Un projet de développement est livré avec une vraie équipe

Workcell comporte **quatre postes par défaut — Orchestrateur, Designer, Développeur, QA.**
Il s'agit d'une philosophie délibérée, pas d'un modèle : ces quatre postes constituent la
*plus petite* équipe capable de faire passer une idée de l'intention à la réalisation
prouvée — conception en premier, avec un responsable clair pour chaque étape.

| Poste | Rôle | Responsabilités |
| --- | --- | --- |
| **Orchestrateur** | routage & coordination | transforme le langage naturel en tickets structurés, achemine le travail vers le bon rôle et surveille les exécutions bloquées |
| **Designer** | `designer` | le système de conception — propose des 시안 (maquettes rendues), maintient les designs sources de vérité approuvés (**la conception passe en premier**) |
| **Développeur** | `engineer` | implémentation, débogage, tests — construit à partir du design *approuvé*, jamais en avance sur lui |
| **QA** | `qa` | le verdict *Terminé* — reproduit, vérifie et valide les preuves |

L'intégration initialise l'Orchestrateur ; la page Agents présente les postes manquants
sous forme de recrutements en un clic. La charte de l'Orchestrateur achemine le code vers
les développeurs, l'UX vers les designers, et la vérification vers le QA — la forme de
l'équipe n'est donc pas seulement de la documentation, c'est la façon dont le travail circule.

**Les quatre postes sont un squelette, pas un plafond — étendez librement au-dessus.**
Recrutez des rôles fonctionnels supplémentaires selon les besoins du projet — **Lead, PM,
Researcher, Writer, Security, DevOps, ou un agent polyvalent** — et dotez chaque agent de
compétences ciblées, plugins, serveurs MCP et systèmes de conception issus du Registre de
Capacités. Exécutez le responsable d'un ticket en tant qu'agent unique ou — expérimental,
opt-in — en mode **dual-brain** (deux modèles génèrent en parallèle, puis un synthétiseur
les fusionne). La configuration par défaut maintient la cohérence d'un nouveau projet dès
le premier jour ; l'organisation grandit ensuite pour s'adapter au projet — pas l'inverse.

### 3. L'ensemble de l'application est planifié comme un seul plan directeur — la conception est la source de vérité

Chaque projet possède un **App Blueprint (전체 앱 기획)** : une vue d'ensemble de toutes
les écrans de l'application, centrée sur les flux, dans un style Figma, afin que le plan et
la conception coexistent au même endroit.

![App Blueprint — écrans sous forme de flux, chacun associé à son plan](docs/assets/app-blueprint.svg)

- **Écran + plan, en binôme.** Chaque écran est une **시안 pure (la maquette rendue)**
  associée à sa **화면 기획 (plan d'écran)** — la spécification de l'objectif, des états,
  des interactions et des données. La maquette montre *ce qu'est* un écran ; le plan le
  décrit. Ils sont créés et évoluent ensemble (un écran = une 시안 + un plan).
- **Flux en premier.** Le plan directeur s'ouvre sur le flux : des nœuds d'écran reliés par
  des flèches de navigation étiquetées, afin que la composition complète de l'application
  soit lisible d'un coup d'œil. Les nœuds sont **repositionnables par glisser-déposer avec
  positions persistées**, le canevas zoome au niveau du curseur, et cliquer sur un écran
  ouvre le détail de sa **화면 기획** — la maquette à côté de son plan, avec les liens
  entrants/sortants de cet écran explicitement indiqués.
- **La conception est la source de vérité.** Pour les travaux orientés écran,
  l'implémentation suit la conception — jamais l'inverse. La 시안 principale d'un ticket
  passe par une étape de validation (`needs_board_review → approved | changes_requested`) ;
  jusqu'à l'approbation du conseil, les agents **suspendent le développement** ; après
  approbation, la conception est injectée comme cible d'implémentation. Les nouvelles
  équipes sont **conception-first par défaut** (les tickets non visuels peuvent y renoncer
  au cas par cas avec une justification).
- L'agent designer crée chaque écran comme la 시안 pure **plus** son plan, et les designs
  existants peuvent être réintégrés dans le même modèle binôme.

### 4. Terminé signifie prouvé

En empruntant la discipline issueflow, chaque ticket porte des critères d'acceptation,
des non-objectifs et une surface de preuve. Un ticket **ne peut pas atteindre l'état
*Terminé* sans un dossier de preuve**, le rôle QA possède le verdict, et la clôture d'un
ticket déclenche un cycle d'apprentissage composé (liste de contrôle automatique → remplissage
automatique LLM optionnel → tickets de suivi). La connaissance se capitalise au lieu de
s'évaporer.

---

## Dérivé de Paperclip, reconstruit pour les projets de développement

Workcell a commencé comme un fork de **Paperclip** (`paperclipai`, sous licence MIT) — un
plan de contrôle open source bien conçu pour orchestrer des équipes d'agents IA : organigrammes,
heartbeats, budgets, gouvernance, système de tickets, journal d'audit immuable et véritable
isolation multi-entreprises. Ce plan de contrôle est une ingénierie solide et réelle, et
Workcell le conserve comme fondation. Nous en sommes reconnaissants, et l'avis de copyright
original de Paperclip ainsi que la notice de permission MIT sont préservés dans
[`NOTICE`](./NOTICE).

Nous avons forké parce que notre **philosophie produit a divergé** — non pas parce que
quoi que ce soit dans Paperclip était mauvais pour ses propres objectifs. Paperclip se
positionne autour des *companies zéro humain* : une main-d'œuvre IA autonome que l'on
« recrute » dans un organigramme PDG/CTO et dont on se retire largement. Workcell adopte
la position opposée sur le rôle de l'humain et resserre l'ambition de « gérer n'importe
quelle entreprise » à **piloter des projets de développement avec excellence**. Cette
différence est suffisamment profonde pour changer le modèle de domaine, l'UX et la
définition de « terminé » :

- **La métaphore PDG-entreprise → un modèle conseil + orchestrateur + rôles fonctionnels.**
  L'humain est le **conseil** ; l'agent principal est un **Orchestrateur** qui achemine et
  coordonne. Les agents sont des rôles fonctionnels (orchestrateur, lead, PM, développeur,
  designer, researcher, writer, QA, security, devops, polyvalent), pas des titres de
  direction.
- **Discipline d'exécution conception-first + preuve-gated.** L'approbation de conception
  conditionne l'implémentation ; la preuve conditionne *Terminé* ; le QA possède le verdict ;
  l'apprentissage composé boucle la boucle. Rien de tout cela n'existe dans le Paperclip
  de base — c'est le changement comportemental le plus structurant du fork.
- **Open Design + Graphify, intégrés.** Workcell intègre des opérations de conception de
  style [Open Design](https://github.com/nexu-io/open-design) (artefacts de conception,
  étapes de validation, un plugin de tableau de bord de conception) et un **Graphe de
  Connaissance** alimenté par le producteur de graphe de code **Graphify** — afin que les
  agents naviguent dans les tickets, le code, les décisions et les conceptions comme un
  index connecté unique au lieu de redécouvrir le dépôt à chaque exécution.
- **Nouveaux sous-systèmes d'orchestration.** Un **Registre de Capacités** (compétences /
  plugins / MCP / systèmes de conception avec portée, visibilité et niveaux de confiance),
  la **délibération dual-brain** (un agent s'auto-révisant sur deux modèles), un **pont MCP**
  sortant, et une couche de surveillance/récupération qui ferme les exécutions
  terminées-mais-bloquées au lieu de créer des tickets.
- **Productisation multi-tenant / i18n.** Isolation de tenant renforcée, audits de cascade
  de suppression complets, internationalisation de premier plan, thème sombre par défaut.

Workcell est un fork indépendant et n'est pas affilié à Paperclip ni approuvé par eux.

---

## Fonctionnalités clés

- **Langage naturel → ticket.** Décrivez une fonctionnalité au conseil et l'Orchestrateur
  rédige un ticket structuré avec critères d'acceptation, non-objectifs et surface de preuve.
- **Étape de conception.** Les tickets orientés écran sont mis en attente jusqu'à ce que le
  conseil approuve un design source de vérité ; le design approuvé devient la cible
  d'implémentation injectée dans les exécutions d'agents.
- **Done preuve-gated + validation QA.** Les tickets atteignent *Terminé* uniquement avec
  des preuves ; une politique d'exécution achemine automatiquement le premier « done » vers
  la revue QA.
- **Graphe de Connaissance + Graphify.** Un graphe de pointeurs sur les tickets, le code,
  les décisions et les plans ; `workcell code-graph` ingère un export Graphify pour que la
  structure du code rejoigne le graphe.
- **App Blueprint (전체 앱 기획).** Une vue d'ensemble de tous les écrans de l'application,
  centrée sur les flux, dans un style Figma — 시안 pure associée à une 화면 기획 (plan
  d'écran), nœuds persistés déplaçables, zoom au curseur, flèches de navigation étiquetées
  et navigation vers le plan de chaque écran. Par projet ; la 시안 approuvée est la cible
  d'implémentation. (Le plugin Open Design affiche toujours les artefacts, les diffs de
  version et les aperçus sandboxés sur une page `/design` dédiée.)
- **Délibération dual-brain** *(expérimental, opt-in)*. Un agent, deux modèles : les deux
  génèrent un candidat en parallèle, puis un cerveau synthétiseur les fusionne en réponse
  finale (style OpenRouter-Fusion) ; les exécutions en direct sont contrôlées par un flag
  (désactivé par défaut).
- **Apportez votre propre agent.** Adaptateurs locaux Claude et Codex (plus HTTP/process)
  sous un même organigramme.
- **Registre de Capacités.** Compétences, plugins, serveurs MCP et systèmes de conception
  assignés à l'échelle de l'entreprise ou par agent, avec niveaux de confiance, états de
  visibilité et approbation du conseil.
- **Pont MCP (entrant + sortant).** Un serveur MCP entrant expose l'API de Workcell comme
  outils ; un client MCP sortant permet à Workcell d'appeler des sidecars externes (contrôlé
  par capacité, délimité par tenant).
- **Contrôle des coûts & gouvernance.** Budgets par agent avec arrêts stricts, un Centre
  d'Utilisation avec badges de précision `Exact / Synced / Estimated`, étapes d'approbation
  du conseil et journal d'audit immuable délimité par entreprise.
- **Isolation multi-entreprises & i18n.** Un seul déploiement, de nombreuses entreprises
  entièrement isolées ; interface utilisateur internationalisée ; thème sombre par défaut.

Un inventaire de fonctionnalités détaillé et toujours à jour (avec les étiquettes
`[Paperclip]` / `[Changed]` / `[New]`) se trouve dans
[`docs/FEATURES.md`](./docs/FEATURES.md).

---

## Délibération dual-brain (expérimental)

Le responsable d'un ticket peut être exécuté comme **un agent à deux cerveaux** — deux
modèles configurés indépendamment — fusionnés **dans le style OpenRouter-Fusion**. Les deux
cerveaux **génèrent une réponse candidate en parallèle et indépendamment** (aucun ne voit
le brouillon de l'autre) ; puis un **cerveau synthétiseur** (cerveau A par défaut) réconcilie
les deux en une réponse finale plus solide — conservant ce que chacun a réussi, abandonnant
le reste, résolvant les conflits. Choisissez deux *modèles différents* et vous ajoutez la
diversité des modèles au-dessus de la synthèse.

![Délibération dual-brain](docs/assets/dual-brain.svg)

Pourquoi ça fonctionne : la majeure partie du gain provient de **l'étape de synthèse
elle-même**, pas seulement de la diversité des modèles. Quand OpenRouter a mesuré son
approche **Fusion** sur le benchmark de recherche approfondie **DRACO** de Perplexity,
apparier **Claude Opus 4.8 avec *lui-même*** en panel à deux modèles a fait passer son
score de **58,8 % à 65,5 %** — parce que deux passes même du même modèle divergent, et
qu'un synthétiseur qui les réconcilie bat un tir unique.
([article](https://datasciencedojo.com/blog/openrouter-fusion-api/), [OpenRouter](https://openrouter.ai/).)

**Statut : opt-in, désactivé par défaut.** Le moteur de fusion — génération parallèle +
synthèse — est implémenté et testé, mais le piloter avec de *vrais* modèles est conditionné
par un flag (`WORKCELL_PAIR_LIVE_LLM`, afin que dev/CI ne dépensent jamais par accident)
et s'exécute comme une exécution de délibération d'agent dédiée et interrogeable. Voir
[`docs/FEATURES.md`](./docs/FEATURES.md) pour la portée exacte, flag par flag.

---

## Architecture (organisation du monorepo)

Workcell est un espace de travail pnpm (Node 20+, pnpm 9.15+) :

| Chemin | Package | Rôle |
| --- | --- | --- |
| `server/` | `@workcell/server` | API REST Express + services d'orchestration (heartbeat, exécutions, étape de conception, gouvernance, audit) |
| `ui/` | `@workcell/ui` | Interface React + Vite (servie par l'API en dev) |
| `cli/` | `workcell` | CLI / binaire `workcell` — intégration, configuration, code-graph, synchronisation cloud |
| `packages/shared/` | `@workcell/shared` | Types partagés, constantes, validateurs, contrats de chemins d'API |
| `packages/db/` | `@workcell/db` | Schéma Drizzle, migrations, clients DB (PostgreSQL embarqué en dev) |
| `packages/adapters/` | — | Adaptateurs d'agents (claude / codex / …) |
| `packages/adapter-utils/` | `@workcell/adapter-utils` | Utilitaires d'adaptateurs partagés (injection MCP, cartographie des coûts) |
| `packages/mcp-server/` | `@workcell/mcp-server` | Serveur MCP entrant (API Workcell → outils) |
| `packages/mcp-bridge/` | `@workcell/mcp-bridge` | Client MCP sortant (Workcell → sidecars MCP externes) |
| `packages/plugins/` | — | Système de plugins, SDK, fournisseurs sandbox, exemples de plugins (dont le tableau de bord Open Design) |

Un seul processus Node exécute l'API, un PostgreSQL embarqué et le stockage de fichiers
local en développement ; en production, vous le pointez vers votre propre Postgres.

---

## Démarrage rapide

Prérequis : **Node.js 20+**, **pnpm 9.15+**.

```bash
pnpm install
pnpm dev          # API + UI en mode watch
```

Une base de données PostgreSQL embarquée est créée automatiquement en développement —
laissez `DATABASE_URL` non défini pour l'utiliser. Scripts courants (depuis `package.json`) :

```bash
pnpm dev          # dev complet (API + UI, watch)
pnpm dev:server   # serveur uniquement
pnpm typecheck    # vérification de types à l'échelle du workspace
pnpm test         # exécution stable Vitest (N'exécute PAS Playwright)
pnpm build        # compilation de tous les packages
pnpm test:e2e     # suite de navigateur Playwright (opt-in)
pnpm db:generate  # générer une migration DB
pnpm db:migrate   # appliquer les migrations
```

Premier démarrage : l'assistant d'intégration crée votre équipe (conception-first par
défaut), initialise l'**Orchestrateur** et ouvre votre premier ticket. Recrutez ensuite
le reste de l'équipe recommandée — Développeur, Designer, QA — depuis la page Agents (un
clic par poste manquant).

Voir [`AGENTS.md`](./AGENTS.md) pour le flux de travail des contributeurs et les règles
d'ingénierie.

### Carte de la documentation

| Domaine | Fichier |
| --- | --- |
| Spécification détaillée du produit | [`PRODUCT_SPEC.md`](./PRODUCT_SPEC.md) |
| Inventaire des fonctionnalités (vs Paperclip) | [`docs/FEATURES.md`](./docs/FEATURES.md) |
| Plan actif / feuille de route / décisions | [`docs/plan/PLAN.md`](./docs/plan/PLAN.md) · [`docs/plan/ROADMAP.md`](./docs/plan/ROADMAP.md) · [`docs/plan/DECISIONS.md`](./docs/plan/DECISIONS.md) |
| Solutions réutilisables / règles de prévention | [`docs/solutions/INDEX.md`](./docs/solutions/INDEX.md) |

---

## Licence & attribution

Workcell est publié sous la [Licence MIT](./LICENSE) (© 2026 Workcell).

Des parties de Workcell sont dérivées de **Paperclip** (`paperclipai`), © 2025 Paperclip AI,
également sous licence MIT. Conformément aux exigences de la Licence MIT, l'avis de copyright
original de Paperclip et la notice de permission sont reproduits dans [`NOTICE`](./NOTICE)
et doivent être conservés dans toute redistribution.
