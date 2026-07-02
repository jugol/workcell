# Workcell

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-20%2B-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![pnpm 9.15+](https://img.shields.io/badge/pnpm-9.15%2B-F69220.svg?logo=pnpm&logoColor=white)](https://pnpm.io)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

**Workcell ist eine Multi-Agenten-Betriebsplattform, die auf die Durchführung von Entwicklungsprojekten spezialisiert ist: Ein menschliches Board gibt die Richtung vor, und ein KI-Team — Orchestrator, Developer, Designer, QA — liefert die Ergebnisse mit Nachweisen.**

[English](./README.md) · [한국어](./README.ko.md) · [日本語](./README.ja.md) · [简体中文](./README.zh-CN.md) · [繁體中文](./README.zh-TW.md) · [Español](./README.es.md) · [Français](./README.fr.md) · [Deutsch](./README.de.md) · [Português (BR)](./README.pt-BR.md) · [Русский](./README.ru.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md) · [Bahasa Indonesia](./README.id.md) · [Italiano](./README.it.md)

Sie bleiben das Board: Sie bestimmen die Richtung, erteilen Freigaben und legen die Richtlinien fest. Agenten übernehmen funktionale Rollen, bearbeiten Issues und hinterlassen sowohl Arbeitsergebnisse als auch den **Nachweis**, dass die Arbeit tatsächlich erledigt wurde. Die Steuerungsebene verwaltet die Organisation — Projekte, Issues, Budgets, Governance und ein unveränderliches Prüfprotokoll — während Sie Ihre Zeit für die wirklich wichtigen Entscheidungen nutzen.

> Wie ein Unternehmen führen · wie Issues ausführen · Design als Quelle der Wahrheit · Menschen urteilen lassen.

---

## Philosophie

Workcell hat eine klare Meinung darüber, wie ein Entwicklungsprojekt ablaufen sollte. Vier Grundsätze prägen das gesamte Produkt:

### 1. Der Mensch ist das Board, kein Zuschauer

Es gibt hier kein „Zero-Human-Company". Der Mensch verantwortet Richtung, Freigaben und Richtlinien; Agenten verantworten die Ausführung. Jedes wichtige Gate — Design-Freigabe, Nachweisprüfung, Budget, Einstellung — endet in einer menschlichen Entscheidung, die im unveränderlichen Prüfprotokoll festgehalten wird.

### 2. Ein Entwicklungsprojekt liefert mit einem echten Team

Workcell umfasst **standardmäßig vier Rollen — Orchestrator, Designer, Developer, QA.** Dies ist eine bewusste Philosophie, kein Template: Diese vier bilden das *kleinste* Team, das eine Idee von der Absicht bis zum bewiesenen Ergebnis umsetzen kann — design-first, mit einem klaren Verantwortlichen für jedes Gate.

| Rolle | Funktion | Verantwortet |
| --- | --- | --- |
| **Orchestrator** | Routing & Koordination | Wandelt natürliche Sprache in strukturierte Issues um, leitet Arbeit an die richtige Rolle weiter und überwacht hängende Ausführungen |
| **Designer** | `designer` | Das Design-System — schlägt 시안 (gerenderte Design-Entwürfe) vor, pflegt die freigegebenen Referenzdesigns (**Design kommt zuerst**) |
| **Developer** | `engineer` | Implementierung, Debugging, Tests — baut auf Basis des *freigegebenen* Designs, niemals davor |
| **QA** | `qa` | Das *Erledigt*-Urteil — reproduziert, verifiziert und zeichnet Nachweise ab |

Beim Onboarding wird der Orchestrator angelegt; die Agenten-Seite zeigt fehlende Rollen als One-Click-Einstellungen an. Das Charter des Orchestrators leitet Code an Engineers, UX an Designer und Verifikation an QA weiter — die Teamstruktur ist also nicht nur Dokumentation, sondern bestimmt, wie Arbeit fließt.

**Die vier Rollen sind ein Grundgerüst, keine Obergrenze — erweitern Sie frei darüber hinaus.** Stellen Sie weitere funktionale Rollen nach Bedarf ein — **Lead, PM, Researcher, Writer, Security, DevOps oder einen Allzweck-Agenten** — und statten Sie jeden Agenten mit eingegrenzten Skills, Plugins, MCP-Servern und Design-Systemen aus der Capability Registry aus. Führen Sie den Owner eines Issues als einzelnen Agenten aus oder — experimentell, opt-in — als **Dual-Brain** (zwei Modelle generieren parallel, ein Synthesizer führt sie zusammen). Der Standard hält ein neues Projekt vom ersten Tag an kohärent; die Organisation wächst dann mit dem Projekt — nicht umgekehrt.

### 3. Die gesamte App wird als ein Blueprint geplant — Design ist die Quelle der Wahrheit

Jedes Projekt hat einen **App Blueprint (전체 앱 기획)**: eine Flow-first-, Figma-ähnliche Ansicht aller Screens der App, sodass Plan und Design an einem Ort zusammenleben.

![App Blueprint — Screens als Flow, jeweils mit ihrem Plan verknüpft](docs/assets/app-blueprint.svg)

- **Screen + Plan als Paar.** Jeder Screen ist ein **reines 시안 (der gerenderte Entwurf)**, verbunden mit seiner **화면 기획 (Bildschirmplan)** — der Spezifikation für Zweck, Zustände, Interaktionen und Daten. Der Entwurf zeigt *was* ein Screen ist; der Plan beschreibt ihn. Sie werden gemeinsam erstellt und bewegt (ein Screen = ein 시안 + ein Plan).
- **Flow-first.** Der Blueprint öffnet sich auf dem Flow: Screen-Knoten, die durch beschriftete Navigations-Pfeile miteinander verbunden sind, sodass die Gesamtkomposition der App auf einen Blick erfassbar ist. Knoten sind **per Drag-and-Drop repositionierbar mit persistierten Positionen**, der Canvas zoomt am Cursor, und ein Klick auf einen Screen öffnet seine **화면 기획**-Details — den Entwurf neben seinem Plan, mit den eingehenden/ausgehenden Links dieses Screens.
- **Design ist die Quelle der Wahrheit.** Bei screenbezogener Arbeit folgt die Implementierung dem Design — niemals umgekehrt. Das primäre 시안 eines Issues durchläuft ein Review-Gate (`needs_board_review → approved | changes_requested`); bis das Board es freigibt, **stoppen Agenten die Entwicklung**; nach der Freigabe wird das Design als Implementierungsziel injiziert. Neue Teams sind **standardmäßig design-first** (nicht-visuelle Issues können pro Issue mit Begründung abweichen).
- Der Designer-Agent erstellt jeden Screen als reines 시안 **plus** seinen Plan; bestehende Designs können in dasselbe Paarmodell überführt werden.

### 4. Erledigt bedeutet bewiesen

In Anlehnung an die Issueflow-Disziplin trägt jedes Issue Akzeptanzkriterien, Nicht-Ziele und eine Nachweisfläche. Ein Issue **kann *Erledigt* nicht erreichen ohne ein Nachweispaket**; die QA-Rolle verantwortet das Urteil; der Abschluss eines Issues startet einen Compound-Learning-Zyklus (Auto-Checkliste → optionales LLM-Auto-Fill → Folge-Issues). Wissen akkumuliert sich, anstatt zu verdampfen.

---

## Von Paperclip geforkt, für Entwicklungsprojekte neu aufgebaut

Workcell begann als Fork von **Paperclip** (`paperclipai`, MIT-lizenziert) — einer gut gebauten Open-Source-Steuerungsebene für die Orchestrierung von KI-Agenten-Teams: Organigramme, Heartbeats, Budgets, Governance, ein Ticket-System, ein unveränderliches Prüfprotokoll und echte Multi-Company-Isolation. Diese Steuerungsebene ist echte, solide Ingenieursarbeit, und Workcell behält sie als Grundlage. Wir sind dankbar dafür, und Paperclips ursprünglicher Copyright-Hinweis und MIT-Erlaubnishinweis sind in [`NOTICE`](./NOTICE) erhalten.

Wir haben geforkt, weil unsere **Produktphilosophie auseinanderging** — nicht weil irgendetwas an Paperclip für seine eigenen Ziele falsch war. Paperclip positioniert sich rund um *Zero-Human-Companies*: eine autonome KI-Belegschaft, die man in ein CEO/CTO-Organigramm „einstellt" und weitgehend sich selbst überlässt. Workcell nimmt die entgegengesetzte Haltung zur Rolle des Menschen ein und verengt das Ziel von „jedes Unternehmen führen" auf **Entwicklungsprojekte gut führen**. Dieser Unterschied ist tief genug, um das Domänenmodell, die UX und die Definition von „erledigt" zu verändern:

- **Die CEO-Unternehmens-Metapher → ein Board + Orchestrator + Funktionsrollen-Modell.** Der Mensch ist das **Board**; der Top-Agent ist ein **Orchestrator**, der leitet und koordiniert. Agenten sind Funktionsrollen (orchestrator, lead, PM, engineer, designer, researcher, writer, QA, security, devops, general), keine C-Suite-Titel.
- **Design-first + Nachweis-gesperrte Ausführungsdisziplin.** Design-Freigabe sperrt die Implementierung; Nachweis sperrt *Erledigt*; QA verantwortet das Urteil; Compound Learning schließt den Kreislauf. Nichts davon existiert im ursprünglichen Paperclip — es ist die gewichtigste Verhaltensänderung des Forks.
- **Open Design + Graphify, eingewoben.** Workcell integriert [Open Design](https://github.com/nexu-io/open-design)-ähnliche Design-Operationen (Design-Artefakte, Review-Gates, ein Design-Dashboard-Plugin) und einen **Knowledge Graph**, der vom **Graphify** Code-Graph-Produzenten gespeist wird — sodass Agenten Issues, Code, Entscheidungen und Designs als einen verbundenen Index navigieren, anstatt das Repository bei jeder Ausführung neu zu entdecken.
- **Neu entwickelte Orchestrierungssubsysteme.** Eine **Capability Registry** (Skills / Plugins / MCP / Design-Systeme mit Geltungsbereich, Sichtbarkeit und Vertrauensstufen), **Dual-Brain-Deliberation** (ein Agent, der sich selbst über zwei Modelle prüft), eine ausgehende **MCP-Bridge** und eine Watchdog-/Recovery-Schicht, die abgeschlossene-aber-hängende Ausführungen zusammenführt, anstatt Papierkram zu produzieren.
- **Multi-Tenant / i18n-Produktisierung.** Gehärtete Tenant-Isolation, vollständige Delete-Cascade-Audits, erstklassige Internationalisierung, Dark Theme standardmäßig.

Workcell ist ein unabhängiger Fork und steht in keiner Verbindung zu Paperclip und wird von Paperclip nicht unterstützt.

---

## Hauptfunktionen

- **Natürliche Sprache → Issue.** Beschreiben Sie ein Feature auf dem Board, und der Orchestrator erstellt ein strukturiertes Issue mit Akzeptanzkriterien, Nicht-Zielen und einer Nachweisfläche.
- **Design-Gate.** Screenbezogene Issues werden zurückgehalten, bis das Board ein Referenzdesign freigibt; das freigegebene Design wird zum Implementierungsziel, das in Agenten-Ausführungen injiziert wird.
- **Nachweis-gesperrtes Erledigt + QA-Abzeichnung.** Issues erreichen *Erledigt* nur mit Nachweisen; eine Ausführungsrichtlinie leitet das erste „erledigt" automatisch zur QA-Review weiter.
- **Knowledge Graph + Graphify.** Ein Pointer-Only-Graph über Issues, Code, Entscheidungen und Pläne; `workcell code-graph` importiert einen Graphify-Export, sodass die Code-Struktur dem Graph beitritt.
- **App Blueprint (전체 앱 기획).** Eine Flow-first-, Figma-ähnliche Ansicht aller Screens der App — reines 시안 gepaart mit einer 화면 기획 (Bildschirmplan), draggbare persistierte Knoten, Cursor-Zoom, beschriftete Navigationspfeile und Durchklicken zum Plan jedes Screens. Pro Projekt; das freigegebene 시안 ist das Implementierungsziel. (Das Open Design-Plugin rendert weiterhin Artefakte, Versionsdiffs und sandboxed Previews auf einer dedizierten `/design`-Seite.)
- **Dual-Brain-Deliberation** *(experimentell, opt-in)*. Ein Agent, zwei Modelle: beide generieren parallel einen Kandidaten, dann führt ein Synthesizer-Gehirn sie zur endgültigen Antwort zusammen (OpenRouter-Fusion-Stil); Live-Ausführungen sind flag-gesperrt (standardmäßig deaktiviert).
- **Eigenen Agenten mitbringen.** Claude- und Codex-Local-Adapter (plus HTTP/Prozess) unter einem Organigramm.
- **Capability Registry.** Skills, Plugins, MCP-Server und Design-Systeme, zugewiesen auf Company- oder per-Agent-Ebene, mit Vertrauensstufen, Sichtbarkeitszuständen und Board-Freigabe.
- **MCP-Bridge (ein- und ausgehend).** Ein eingehender MCP-Server stellt Workcells API als Tools bereit; ein ausgehender MCP-Client ermöglicht Workcell den Aufruf externer Sidecars (capability-gesteuert, tenant-eingegrenzt).
- **Kostenkontrolle & Governance.** Per-Agent-Budgets mit Hard-Stops, ein Usage Center mit `Exact / Synced / Estimated`-Genauigkeitsbadges, Board-Freigabe-Gates und ein unveränderliches, company-eingegrenztes Prüfprotokoll.
- **Multi-Company-Isolation & i18n.** Ein Deployment, viele vollständig isolierte Companies; benutzerorientierte UI internationalisiert; Dark Theme standardmäßig.

Ein detailliertes, stets aktuelles Feature-Inventar (mit `[Paperclip]` / `[Changed]` / `[New]`-Tags) befindet sich in [`docs/FEATURES.md`](./docs/FEATURES.md).

---

## Dual-Brain-Deliberation (experimentell)

Ein Issue-Owner kann als **ein Agent mit zwei Gehirnen** ausgeführt werden — zwei unabhängig konfigurierte Modelle — zusammengeführt im **OpenRouter-Fusion-Stil**. Beide Gehirne **generieren parallel und unabhängig voneinander eine Kandidatenantwort** (keines sieht den Entwurf des anderen); dann **reconciliert ein Synthesizer-Gehirn** (standardmäßig Gehirn A) die beiden zu einer stärkeren endgültigen Antwort — behält, was jedes richtig gemacht hat, lässt den Rest weg, löst Konflikte auf. Wählen Sie zwei *verschiedene* Modelle, und Sie stapeln Modell-Diversität auf die Synthese.

![Dual-Brain-Deliberation](docs/assets/dual-brain.svg)

Warum es funktioniert: Der größte Teil des Gewinns kommt vom **Syntheseschritt selbst**, nicht nur von der Modell-Diversität. Als OpenRouter seinen **Fusion**-Ansatz auf Perplexitys **DRACO** Deep-Research-Benchmark maß, hob das Paaren von **Claude Opus 4.8 mit *sich selbst*** als Zwei-Modell-Panel seinen Score von **58.8% auf 65.5%** — weil zwei Durchläufe selbst desselben Modells divergieren, und ein Synthesizer, der sie reconciliert, einen einzelnen Schuss übertrifft.
([Artikel](https://datasciencedojo.com/blog/openrouter-fusion-api/), [OpenRouter](https://openrouter.ai/).)

**Status: opt-in, standardmäßig deaktiviert.** Die Fusion-Engine — paralleles Generieren + Synthetisieren — ist implementiert und getestet, aber das Ausführen mit *echten* Modellen ist hinter einem Flag gesperrt (`WORKCELL_PAIR_LIVE_LLM`, damit dev/CI nie versehentlich Kosten verursachen) und läuft als dedizierte, abfragbare Agenten-Deliberations-Ausführung. Siehe [`docs/FEATURES.md`](./docs/FEATURES.md) für den genauen, flag-für-flag Umfang.

---

## Architektur (Monorepo-Layout)

Workcell ist ein pnpm-Workspace (Node 20+, pnpm 9.15+):

| Pfad | Paket | Rolle |
| --- | --- | --- |
| `server/` | `@workcell/server` | Express REST API + Orchestrierungsdienste (Heartbeat, Runs, Design-Gate, Governance, Audit) |
| `ui/` | `@workcell/ui` | React + Vite Board-UI (in der Entwicklung vom API bereitgestellt) |
| `cli/` | `workcell` | CLI / `workcell`-Binary — Onboarding, Konfiguration, Code-Graph, Cloud-Sync |
| `packages/shared/` | `@workcell/shared` | Gemeinsame Typen, Konstanten, Validatoren, API-Pfadverträge |
| `packages/db/` | `@workcell/db` | Drizzle-Schema, Migrationen, DB-Clients (eingebettetes Postgres in der Entwicklung) |
| `packages/adapters/` | — | Agenten-Adapter (claude / codex / …) |
| `packages/adapter-utils/` | `@workcell/adapter-utils` | Gemeinsame Adapter-Utilities (MCP-Injektion, Kosten-Mapping) |
| `packages/mcp-server/` | `@workcell/mcp-server` | Eingehender MCP-Server (Workcell-API → Tools) |
| `packages/mcp-bridge/` | `@workcell/mcp-bridge` | Ausgehender MCP-Client (Workcell → externe MCP-Sidecars) |
| `packages/plugins/` | — | Plugin-System, SDK, Sandbox-Provider, Beispiel-Plugins (inkl. Open Design-Dashboard) |

Ein einzelner Node-Prozess führt in der Entwicklung die API, ein eingebettetes PostgreSQL und lokalen Dateispeicher aus; in der Produktion verweisen Sie auf Ihr eigenes Postgres.

---

## Erste Schritte

Voraussetzungen: **Node.js 20+**, **pnpm 9.15+**.

```bash
pnpm install
pnpm dev          # API + UI im Watch-Modus
```

Eine eingebettete PostgreSQL-Datenbank wird in der Entwicklung automatisch erstellt — lassen Sie `DATABASE_URL` ungesetzt, um sie zu verwenden. Gängige Skripte (aus `package.json`):

```bash
pnpm dev          # Vollständige Entwicklung (API + UI, Watch)
pnpm dev:server   # Nur Server
pnpm typecheck    # Workspace-weite Typprüfung
pnpm test         # Stabiler Vitest-Lauf (führt Playwright NICHT aus)
pnpm build        # Alle Pakete bauen
pnpm test:e2e     # Playwright-Browser-Suite (opt-in)
pnpm db:generate  # DB-Migration generieren
pnpm db:migrate   # Migrationen anwenden
```

Erster Start: Der Onboarding-Wizard erstellt Ihr Team (standardmäßig design-first), legt den **Orchestrator** an und öffnet Ihr erstes Issue. Stellen Sie dann den Rest des empfohlenen Teams — Engineer, Designer, QA — über die Agenten-Seite ein (ein Klick pro fehlender Rolle).

Siehe [`AGENTS.md`](./AGENTS.md) für den Contributor-Workflow und Engineering-Regeln.

### Dokumentationsübersicht

| Bereich | Datei |
| --- | --- |
| Detaillierte Produktspezifikation | [`PRODUCT_SPEC.md`](./PRODUCT_SPEC.md) |
| Feature-Inventar (vs. Paperclip) | [`docs/FEATURES.md`](./docs/FEATURES.md) |
| Aktiver Plan / Roadmap / Entscheidungen | [`docs/plan/PLAN.md`](./docs/plan/PLAN.md) · [`docs/plan/ROADMAP.md`](./docs/plan/ROADMAP.md) · [`docs/plan/DECISIONS.md`](./docs/plan/DECISIONS.md) |
| Wiederverwendbare Lösungen / Präventionsregeln | [`docs/solutions/INDEX.md`](./docs/solutions/INDEX.md) |

---

## Lizenz & Attribution

Workcell wird unter der [MIT-Lizenz](./LICENSE) veröffentlicht (© 2026 Workcell).

Teile von Workcell leiten sich von **Paperclip** (`paperclipai`) ab, © 2025 Paperclip AI, ebenfalls MIT-lizenziert. Wie von der MIT-Lizenz gefordert, sind Paperclips ursprünglicher Copyright-Hinweis und Erlaubnishinweis in [`NOTICE`](./NOTICE) wiedergegeben und müssen in Weitergaben erhalten bleiben.
