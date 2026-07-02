# Workcell

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-20%2B-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![pnpm 9.15+](https://img.shields.io/badge/pnpm-9.15%2B-F69220.svg?logo=pnpm&logoColor=white)](https://pnpm.io)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

**Workcell è una piattaforma operativa multi-agente specializzata nella gestione di
progetti di sviluppo: un consiglio umano stabilisce la direzione, e un team AI —
Orchestrator, Developer, Designer, QA — la porta a termine con prove concrete.**

[English](./README.md) · [한국어](./README.ko.md) · [日本語](./README.ja.md) · [简体中文](./README.zh-CN.md) · [繁體中文](./README.zh-TW.md) · [Español](./README.es.md) · [Français](./README.fr.md) · [Deutsch](./README.de.md) · [Português (BR)](./README.pt-BR.md) · [Русский](./README.ru.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md) · [Bahasa Indonesia](./README.id.md) · [Italiano](./README.it.md)

Tu rimani il consiglio di amministrazione: detieni la direzione, le approvazioni e le
politiche. Gli agenti assumono ruoli funzionali, si assegnano i ticket e lasciano dietro
di sé sia i prodotti del lavoro sia la **prova** che il lavoro è stato effettivamente
completato. Il piano di controllo gestisce l'organizzazione — progetti, ticket, budget,
governance e un registro di audit immutabile — mentre tu ti concentri sulle decisioni
che contano davvero.

> Opera come un'azienda · esegui tramite ticket · il design è la fonte di verità · lascia che gli umani giudichino.

---

## Filosofia

Workcell ha una visione precisa su come dovrebbe funzionare un progetto di sviluppo.
Quattro principi fondamentali guidano l'intero prodotto:

### 1. L'essere umano è il consiglio, non uno spettatore

Qui non esiste nessuna "azienda senza esseri umani". L'essere umano possiede la
direzione, le approvazioni e le politiche; gli agenti si occupano dell'esecuzione. Ogni
gate che conta — approvazione del design, revisione delle prove, budget, assunzioni —
termina con una decisione umana, registrata in un registro di audit immutabile.

### 2. Un progetto di sviluppo avanza con un team reale

Workcell include **quattro posizioni di default — Orchestrator, Designer, Developer, QA.**
Questa è una filosofia deliberata, non un template: queste quattro figure rappresentano
il *team minimo* in grado di portare un'idea dall'intenzione alla realizzazione
verificata — design-first, con un responsabile chiaro per ogni gate.

| Posizione | Ruolo | Responsabilità |
| --- | --- | --- |
| **Orchestrator** | instradamento e coordinamento | trasforma il linguaggio naturale in ticket strutturati, indirizza il lavoro al ruolo giusto e monitora le esecuzioni bloccate |
| **Designer** | `designer` | il design system — propone 시안 (bozze di design renderizzate), mantiene i design approvati come fonte di verità (**il design viene prima di tutto**) |
| **Developer** | `engineer` | implementazione, debug, test — costruisce seguendo il design *approvato*, mai in anticipo rispetto ad esso |
| **QA** | `qa` | il verdetto *Done* — riproduce, verifica e firma le prove |

L'onboarding inizializza l'Orchestrator; la pagina Agenti mostra le posizioni vacanti con
un clic per assumerle. Il mandato dell'Orchestrator indirizza il codice agli ingegneri, la
UX ai designer e la verifica al QA — quindi la struttura del team non è solo
documentazione, ma definisce il flusso del lavoro.

**Le quattro posizioni sono uno scheletro, non un limite — estendile liberamente.** Assumi
ruoli funzionali aggiuntivi in base alle esigenze del lavoro — **Lead, PM, Researcher,
Writer, Security, DevOps o un agente generico** — e fornisci a ogni agente skills,
plugin, server MCP e design system dal Capability Registry con scope definito. Esegui il
responsabile di un ticket come singolo agente o — sperimentale, opt-in — come
**dual-brain** (due modelli generano in parallelo, poi un sintetizzatore li unisce). Il
default mantiene un nuovo progetto coerente fin dal primo giorno; l'organizzazione cresce
quindi per adattarsi al progetto — non il contrario.

### 3. L'intera app è pianificata come un unico progetto — il design è la fonte di verità

Ogni progetto ha un **App Blueprint (전체 앱 기획, il piano dell'intera app)**: una vista
flusso-first in stile Figma di tutte le schermate dell'app, così che il piano e il design
vivano in un unico posto.

![App Blueprint — le schermate come flusso, ciascuna abbinata al proprio piano](docs/assets/app-blueprint.svg)

- **Schermata + piano, come coppia.** Ogni schermata è una **pura 시안 (il mockup
  renderizzato)** abbinata alla sua **화면 기획 (piano della schermata)** — la specifica
  per scopo, stati, interazioni e dati. Il mockup mostra *cosa* è una schermata; il piano
  la descrive. Vengono create e spostate insieme (una schermata = una 시안 + un piano).
- **Flusso prima di tutto.** Il blueprint si apre sul flusso: nodi schermata collegati da
  frecce di navigazione etichettate, così la composizione dell'intera app è leggibile a
  colpo d'occhio. I nodi sono **riposizionabili tramite drag con posizioni persistite**,
  il canvas ingrandisce seguendo il cursore e cliccando su una schermata si apre il
  dettaglio della sua **화면 기획** — il mockup accanto al piano, con i link entranti e
  uscenti di quella schermata elencati.
- **Il design è la fonte di verità.** Per il lavoro che coinvolge le schermate,
  l'implementazione segue il design — mai il contrario. La 시안 principale di un ticket
  supera un gate di revisione (`needs_board_review → approved | changes_requested`); finché
  il consiglio non approva, gli agenti **sospendono lo sviluppo**; dopo l'approvazione il
  design viene iniettato come target di implementazione. I nuovi team sono **design-first
  per default** (i ticket non visivi possono rinunciare a questa modalità singolarmente
  con una motivazione).
- L'agente designer crea ogni schermata come pura 시안 **più** il suo piano, e i design
  esistenti possono essere rielaborati nello stesso modello accoppiato.

### 4. Completato significa verificato

Adottando la disciplina issueflow, ogni ticket porta criteri di accettazione, non-obiettivi
e una superficie di prova. Un ticket **non può raggiungere lo stato *Done* senza un bundle
di prove**; il ruolo QA possiede il verdetto e il completamento di un ticket avvia un ciclo
di apprendimento composto (checklist automatica → compilazione automatica LLM opzionale →
ticket di follow-up). La conoscenza si accumula invece di evaporare.

---

## Derivato da Paperclip, ricostruito per i progetti di sviluppo

Workcell è nato come fork di **Paperclip** (`paperclipai`, licenza MIT) — un piano di
controllo open-source ben costruito per orchestrare team di agenti AI: organigrammi,
heartbeat, budget, governance, un sistema di ticket, un registro di audit immutabile e
un vero isolamento multi-azienda. Quel piano di controllo è ingegneria solida e reale, e
Workcell lo mantiene come propria fondazione. Ne siamo grati, e il copyright originale di
Paperclip e l'avviso di licenza MIT sono preservati in [`NOTICE`](./NOTICE).

Abbiamo fatto il fork perché la nostra **filosofia di prodotto si è differenziata** — non
perché qualcosa in Paperclip fosse sbagliato rispetto ai propri obiettivi. Paperclip si
inquadra attorno alle *aziende senza esseri umani*: una forza lavoro AI autonoma che si
"assume" in un organigramma CEO/CTO da cui si rimane largamente distanti. Workcell assume
la posizione opposta sul ruolo dell'essere umano e restringe l'obiettivo da "gestire
qualsiasi attività" a **gestire bene i progetti di sviluppo**. Questa differenza è
abbastanza profonda da cambiare il modello di dominio, la UX e la definizione di
"completato":

- **La metafora CEO-azienda → un modello consiglio + orchestratore + ruoli funzionali.**
  L'essere umano è il **consiglio**; l'agente di vertice è un **Orchestrator** che
  instrada e coordina. Gli agenti sono ruoli funzionali (orchestrator, lead, PM, engineer,
  designer, researcher, writer, QA, security, devops, general), non titoli dirigenziali.
- **Disciplina di esecuzione design-first e proof-gated.** L'approvazione del design
  costituisce un gate per l'implementazione; le prove costituiscono un gate per il *Done*;
  il QA possiede il verdetto; l'apprendimento composto chiude il ciclo. Niente di tutto
  questo esiste nel Paperclip originale — è il cambiamento comportamentale più significativo
  del fork.
- **Open Design + Graphify, integrati.** Workcell integra operazioni di design in stile
  [Open Design](https://github.com/nexu-io/open-design) (artefatti di design, gate di
  revisione, un plugin dashboard di design) e un **Knowledge Graph** alimentato dal
  produttore di code-graph **Graphify** — così gli agenti navigano ticket, codice,
  decisioni e design come un unico indice connesso invece di riscoprire il repository ad
  ogni esecuzione.
- **Nuovi sottosistemi di orchestrazione.** Un **Capability Registry** (skills / plugin /
  MCP / design system con scope, visibilità e livelli di fiducia), la **deliberazione
  dual-brain** (un agente che si auto-revisiona su due modelli), un **bridge MCP** in
  uscita e un livello watchdog/recovery che ripiega le esecuzioni terminate-ma-bloccate
  invece di produrre documentazione.
- **Produttivizzazione multi-tenant / i18n.** Isolamento tenant robusto, audit completi
  di delete-cascade, internazionalizzazione di prima classe, tema scuro di default.

Workcell è un fork indipendente e non è affiliato né approvato da Paperclip.

---

## Funzionalità principali

- **Linguaggio naturale → ticket.** Descrivi una funzionalità al consiglio e l'Orchestrator
  crea un ticket strutturato con criteri di accettazione, non-obiettivi e una superficie
  di prova.
- **Gate di design.** I ticket che coinvolgono schermate si bloccano finché il consiglio
  non approva un design fonte di verità; il design approvato diventa il target di
  implementazione iniettato nelle esecuzioni degli agenti.
- **Done proof-gated + firma QA.** I ticket raggiungono *Done* solo con prove concrete;
  una policy di esecuzione instrada automaticamente il primo "done" alla revisione QA.
- **Knowledge Graph + Graphify.** Un grafo pointer-only su ticket, codice, decisioni e
  piani; `workcell code-graph` importa un export Graphify così la struttura del codice
  entra nel grafo.
- **App Blueprint (전체 앱 기획).** Una vista flusso-first in stile Figma di ogni
  schermata dell'app — pura 시안 abbinata a una 화면 기획 (piano della schermata), nodi
  persistiti e trascinabili, zoom al cursore, frecce di navigazione etichettate e
  click-through al piano di ogni schermata. Per progetto; la 시안 approvata è il target di
  implementazione. (Il plugin Open Design continua a renderizzare artefatti, diff di
  versione e anteprime sandbox su una pagina `/design` dedicata.)
- **Deliberazione dual-brain** *(sperimentale, opt-in)*. Un agente, due modelli: entrambi
  generano un candidato in parallelo, poi un sintetizzatore li fonde nella risposta finale
  (stile OpenRouter-Fusion); le esecuzioni live sono protette da un flag (disattivato per
  default).
- **Porta il tuo agente.** Adattatori locali per Claude e Codex (più HTTP/processo) sotto
  un unico organigramma.
- **Capability Registry.** Skills, plugin, server MCP e design system assegnati a scope
  aziendale o per singolo agente, con livelli di fiducia, stati di visibilità e
  approvazione del consiglio.
- **Bridge MCP (in entrata + in uscita).** Un server MCP inbound espone le API di
  Workcell come strumenti; un client MCP outbound consente a Workcell di chiamare sidecar
  esterni (con gate per capability e scope per tenant).
- **Controllo dei costi e governance.** Budget per agente con blocchi rigidi, un Usage
  Center con badge di accuratezza `Exact / Synced / Estimated`, gate di approvazione del
  consiglio e un registro di audit immutabile con scope aziendale.
- **Isolamento multi-azienda e i18n.** Un solo deployment, molte aziende completamente
  isolate; UI utente internazionalizzata; tema scuro di default.

Un inventario dettagliato e sempre aggiornato delle funzionalità (con tag `[Paperclip]` /
`[Changed]` / `[New]`) si trova in [`docs/FEATURES.md`](./docs/FEATURES.md).

---

## Deliberazione dual-brain (sperimentale)

Il responsabile di un ticket può essere eseguito come **un agente con due cervelli** —
due modelli configurati indipendentemente — fusi **in stile OpenRouter-Fusion**. Entrambi
i cervelli **generano una risposta candidata in parallelo e in modo indipendente** (nessuno
vede la bozza dell'altro); poi un **cervello sintetizzatore** (il cervello A di default)
riconcilia i due in un'unica risposta finale più solida — mantenendo ciò che ciascuno ha
colto, scartando il resto, risolvendo i conflitti. Scegli due modelli *diversi* e
sommerai la diversità dei modelli alla sintesi.

![Deliberazione dual-brain](docs/assets/dual-brain.svg)

Perché funziona: la maggior parte del valore proviene dal **passaggio di sintesi in sé**,
non solo dalla diversità dei modelli. Quando OpenRouter ha misurato il proprio approccio
**Fusion** sul benchmark di deep-research **DRACO** di Perplexity, abbinare **Claude Opus 4.8
con *se stesso*** come pannello a due modelli ha portato il punteggio da **58.8% a 65.5%**
— perché due passaggi anche dello stesso modello divergono, e un sintetizzatore che li
riconcilia batte un singolo tentativo.
([articolo](https://datasciencedojo.com/blog/openrouter-fusion-api/), [OpenRouter](https://openrouter.ai/).)

**Stato: opt-in, disattivato per default.** Il motore di fusione — generate parallelo +
sintetizza — è implementato e testato, ma il suo utilizzo con modelli *reali* è protetto
da un flag (`WORKCELL_PAIR_LIVE_LLM`, così dev/CI non spendono mai per errore) e viene
eseguito come una run di deliberazione agente dedicata e interrogabile. Consulta
[`docs/FEATURES.md`](./docs/FEATURES.md) per lo scope esatto, flag per flag.

---

## Architettura (struttura del monorepo)

Workcell è un workspace pnpm (Node 20+, pnpm 9.15+):

| Percorso | Pacchetto | Ruolo |
| --- | --- | --- |
| `server/` | `@workcell/server` | API REST Express + servizi di orchestrazione (heartbeat, run, gate di design, governance, audit) |
| `ui/` | `@workcell/ui` | UI del consiglio in React + Vite (servita dall'API in dev) |
| `cli/` | `workcell` | CLI / binario `workcell` — onboarding, configurazione, code-graph, sincronizzazione cloud |
| `packages/shared/` | `@workcell/shared` | Tipi condivisi, costanti, validatori, contratti dei percorsi API |
| `packages/db/` | `@workcell/db` | Schema Drizzle, migrazioni, client DB (PostgreSQL embedded in dev) |
| `packages/adapters/` | — | Adattatori agente (claude / codex / …) |
| `packages/adapter-utils/` | `@workcell/adapter-utils` | Utilities condivise per adattatori (iniezione MCP, mappatura costi) |
| `packages/mcp-server/` | `@workcell/mcp-server` | Server MCP inbound (API Workcell → strumenti) |
| `packages/mcp-bridge/` | `@workcell/mcp-bridge` | Client MCP outbound (Workcell → sidecar MCP esterni) |
| `packages/plugins/` | — | Sistema di plugin, SDK, provider sandbox, plugin di esempio (incluso dashboard Open Design) |

Un singolo processo Node esegue l'API, un PostgreSQL embedded e lo storage locale su file
in sviluppo; in produzione lo si punta al proprio Postgres.

---

## Per iniziare

Requisiti: **Node.js 20+**, **pnpm 9.15+**.

```bash
pnpm install
pnpm dev          # API + UI in modalità watch
```

Un database PostgreSQL embedded viene creato automaticamente in sviluppo — lascia
`DATABASE_URL` non impostato per utilizzarlo. Script comuni (da `package.json`):

```bash
pnpm dev          # sviluppo completo (API + UI, watch)
pnpm dev:server   # solo server
pnpm typecheck    # verifica dei tipi a livello workspace
pnpm test         # esecuzione Vitest stabile (NON esegue Playwright)
pnpm build        # build di tutti i pacchetti
pnpm test:e2e     # suite browser Playwright (opt-in)
pnpm db:generate  # genera una migrazione DB
pnpm db:migrate   # applica le migrazioni
```

Prima esecuzione: la procedura guidata di onboarding crea il tuo team (design-first per
default), inizializza l'**Orchestrator** e apre il tuo primo ticket. Poi assumi il resto
del team consigliato — Engineer, Designer, QA — dalla pagina Agenti (un clic per ogni
posizione vacante).

Consulta [`AGENTS.md`](./AGENTS.md) per il flusso di lavoro dei contributor e le regole
di ingegneria.

### Mappa della documentazione

| Area | File |
| --- | --- |
| Specifica dettagliata del prodotto | [`PRODUCT_SPEC.md`](./PRODUCT_SPEC.md) |
| Inventario delle funzionalità (vs Paperclip) | [`docs/FEATURES.md`](./docs/FEATURES.md) |
| Piano attivo / roadmap / decisioni | [`docs/plan/PLAN.md`](./docs/plan/PLAN.md) · [`docs/plan/ROADMAP.md`](./docs/plan/ROADMAP.md) · [`docs/plan/DECISIONS.md`](./docs/plan/DECISIONS.md) |
| Soluzioni riutilizzabili / regole di prevenzione | [`docs/solutions/INDEX.md`](./docs/solutions/INDEX.md) |

---

## Licenza e attribuzioni

Workcell è rilasciato sotto la [Licenza MIT](./LICENSE) (© 2026 Workcell).

Parti di Workcell derivano da **Paperclip** (`paperclipai`), © 2025 Paperclip AI, anch'esso
con licenza MIT. Come richiesto dalla Licenza MIT, il copyright originale di Paperclip e
l'avviso di licenza sono riprodotti in [`NOTICE`](./NOTICE) e devono essere mantenuti nelle
redistribuzioni.
