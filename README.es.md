# Workcell

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-20%2B-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![pnpm 9.15+](https://img.shields.io/badge/pnpm-9.15%2B-F69220.svg?logo=pnpm&logoColor=white)](https://pnpm.io)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

**Workcell es una plataforma de operaciones multiagente especializada en la ejecución de
proyectos de desarrollo: un consejo directivo humano establece la dirección, y un equipo de IA
— Orquestador, Desarrollador, Diseñador, QA — la lleva a término con evidencia.**

[English](./README.md) · [한국어](./README.ko.md) · [日本語](./README.ja.md) · [简体中文](./README.zh-CN.md) · [繁體中文](./README.zh-TW.md) · [Español](./README.es.md) · [Français](./README.fr.md) · [Deutsch](./README.de.md) · [Português (BR)](./README.pt-BR.md) · [Русский](./README.ru.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md) · [Bahasa Indonesia](./README.id.md) · [Italiano](./README.it.md)

Tú mantienes el rol de consejo directivo: posees la dirección, las aprobaciones y la política.
Los agentes asumen roles funcionales, recogen issues y dejan tanto los productos del trabajo
como la **evidencia** de que el trabajo está realmente hecho. El plano de control gestiona la
organización — proyectos, issues, presupuestos, gobernanza y un registro de auditoría inmutable
— mientras tú inviertes tu tiempo en las decisiones que importan.

> Opera como una empresa · ejecuta mediante issues · diseña como fuente de verdad · que los humanos juzguen.

---

## Filosofía

Workcell tiene opiniones firmes sobre cómo debe ejecutarse un proyecto de desarrollo. Cuatro
compromisos dan forma a todo el producto:

### 1. El humano es el consejo directivo, no un espectador

Aquí no hay ninguna "empresa sin humanos". El humano posee la dirección, las aprobaciones y la
política; los agentes poseen la ejecución. Cada puerta que importa — aprobación de diseño,
revisión de evidencia, presupuesto, contratación — termina en una decisión humana, registrada
en un log de auditoría inmutable.

### 2. Un proyecto de desarrollo se entrega con un equipo real

Workcell tiene **cuatro puestos por defecto — Orquestador, Diseñador, Desarrollador, QA.** Esta
es una filosofía deliberada, no una plantilla: estos cuatro son el equipo *mínimo* capaz de
llevar una idea desde la intención hasta la demostración — con diseño primero y un responsable
claro para cada puerta.

| Puesto | Rol | Responsabilidad |
| --- | --- | --- |
| **Orquestador** | enrutamiento y coordinación | convierte lenguaje natural en issues estructurados, enruta el trabajo al rol correcto y vigila las ejecuciones bloqueadas |
| **Diseñador** | `designer` | el sistema de diseño — propone un boceto (시안, el mockup renderizado), mantiene los diseños aprobados como fuente de verdad (**el diseño va primero**) |
| **Desarrollador** | `engineer` | implementación, depuración, pruebas — construye contra el diseño *aprobado*, nunca por delante de él |
| **QA** | `qa` | el veredicto de *Listo* — reproduce, verifica y firma la evidencia |

El proceso de incorporación inicializa el Orquestador; la página de Agentes muestra los puestos
vacantes como contrataciones con un solo clic. El estatuto del Orquestador enruta código hacia
ingenieros, UX hacia diseñadores y verificación hacia QA — así la forma del equipo no es mera
documentación, sino el modo en que fluye el trabajo.

**Los cuatro puestos son un esqueleto, no un techo — extiéndelos libremente.** Contrata roles
funcionales adicionales según lo exija el trabajo — **Lead, PM, Investigador, Redactor,
Seguridad, DevOps o un agente de propósito general** — y equipa a cualquier agente con
habilidades de alcance delimitado, plugins, servidores MCP y sistemas de diseño del Registro de
Capacidades. Ejecuta al responsable de un issue como un único agente o — experimental y
opcional — como **dual-brain** (dos modelos generan en paralelo y un sintetizador los fusiona).
El conjunto por defecto mantiene un nuevo proyecto coherente desde el primer día; la
organización crece entonces para adaptarse al proyecto, no al revés.

### 3. Toda la app se planifica como un único plano — el diseño es la fuente de verdad

Cada proyecto tiene un **App Blueprint (전체 앱 기획, el plano completo de la aplicación)**: una
vista flujo-primero al estilo Figma de todas las pantallas de la app, de modo que el plan y el
diseño conviven en un mismo lugar.

![App Blueprint — pantallas como flujo, cada una emparejada con su plan](docs/assets/app-blueprint.svg)

- **Pantalla + plan, como par inseparable.** Cada pantalla es un **boceto puro (시안, el mockup
  renderizado)** unido a su **plan de pantalla (화면 기획)** — la especificación de propósito,
  estados, interacciones y datos. El mockup muestra *qué* es una pantalla; el plan la describe.
  Se crean y se mueven juntos (una pantalla = un boceto + un plan).
- **Flujo primero.** El plano se abre en el flujo: nodos de pantalla conectados mediante flechas
  de navegación etiquetadas, de modo que la composición completa de la app es legible de un
  vistazo. Los nodos son **reposicionables por arrastre con posiciones persistentes**, el lienzo
  hace zoom en el cursor y hacer clic en una pantalla abre el detalle de su **plan de pantalla**
  — el mockup junto a su plan, con los enlaces entrantes y salientes de esa pantalla detallados.
- **El diseño es la fuente de verdad.** Para el trabajo orientado a pantallas, la implementación
  sigue al diseño — nunca al revés. El boceto principal de un issue pasa por una puerta de
  revisión (`needs_board_review → approved | changes_requested`); hasta que el consejo aprueba,
  los agentes **suspenden el desarrollo**; tras la aprobación, el diseño se inyecta como
  objetivo de implementación. Los equipos nuevos son **diseño-primero por defecto** (los issues
  no visuales pueden desactivarlo por issue con una justificación).
- El agente diseñador crea cada pantalla como el boceto puro **más** su plan, y los diseños
  heredados pueden reintegrarse en el mismo modelo emparejado.

### 4. Listo significa demostrado

Adoptando la disciplina de issueflow, cada issue lleva criterios de aceptación, no-objetivos
y una superficie de evidencia. Un issue **no puede alcanzar *Listo* sin un paquete de
evidencia**, el rol de QA es dueño del veredicto, y completar un issue desencadena un ciclo de
aprendizaje compuesto (lista de verificación automática → relleno automático por LLM opcional →
issues de seguimiento). El conocimiento se acumula en lugar de evaporarse.

---

## Bifurcado de Paperclip, reconstruido para proyectos de desarrollo

Workcell comenzó como una bifurcación de **Paperclip** (`paperclipai`, con licencia MIT) — un
plano de control de código abierto bien construido para orquestar equipos de agentes de IA:
organigramas, latidos de estado, presupuestos, gobernanza, sistema de tickets, un log de
auditoría inmutable y verdadero aislamiento multiempresa. Ese plano de control es ingeniería
real y sólida, y Workcell lo conserva como su cimiento. Estamos agradecidos por él, y el
aviso de copyright original de Paperclip junto con el permiso MIT se conservan en
[`NOTICE`](./NOTICE).

Bifurcamos porque nuestra **filosofía de producto divergió** — no porque algo en Paperclip
fuera incorrecto para sus propios objetivos. Paperclip se enmarca en torno a *empresas sin
humanos*: una plantilla de trabajo de IA autónoma que se "contrata" en un organigrama CEO/CTO
y de la que uno se aparta en gran medida. Workcell adopta la postura opuesta sobre el papel
del humano y estrecha el objetivo desde "gestionar cualquier negocio" a **ejecutar proyectos de
desarrollo de manera óptima**. Esa diferencia es lo suficientemente profunda como para cambiar
el modelo de dominio, la UX y la definición de "listo":

- **La metáfora CEO-empresa → un modelo de consejo directivo + orquestador + roles funcionales.**
  El humano es el **consejo**; el agente superior es un **Orquestador** que enruta y coordina.
  Los agentes son roles funcionales (orquestador, lead, PM, ingeniero, diseñador, investigador,
  redactor, QA, seguridad, devops, general), no títulos de alta dirección.
- **Disciplina de ejecución diseño-primero con puertas de evidencia.** La aprobación del diseño
  bloquea la implementación; la evidencia bloquea *Listo*; QA es dueño del veredicto; el
  aprendizaje compuesto cierra el ciclo. Nada de esto existe en Paperclip original — es el
  cambio de comportamiento más estructural de la bifurcación.
- **Open Design + Graphify, integrados.** Workcell integra operaciones de diseño al estilo
  [Open Design](https://github.com/nexu-io/open-design) (artefactos de diseño, puertas de
  revisión, un plugin de panel de diseño) y un **Grafo de Conocimiento** alimentado por el
  productor de grafos de código **Graphify** — de modo que los agentes navegan issues, código,
  decisiones y diseños como un índice conectado en lugar de redescubrir el repositorio en cada
  ejecución.
- **Nuevos subsistemas de orquestación.** Un **Registro de Capacidades** (habilidades / plugins
  / MCP / sistemas de diseño con alcance, visibilidad y niveles de confianza), **deliberación
  dual-brain** (un agente que se auto-revisa en dos modelos), un **puente MCP** de salida y una
  capa de watchdog/recuperación que cierra ejecuciones terminadas pero bloqueadas en lugar de
  generar burocracia.
- **Productización multitenencia / i18n.** Aislamiento de tenencia reforzado, auditorías
  completas de eliminación en cascada, internacionalización de primera clase, tema oscuro por
  defecto.

Workcell es una bifurcación independiente y no está afiliado ni respaldado por Paperclip.

---

## Características principales

- **Lenguaje natural → issue.** Describe una funcionalidad en el panel y el Orquestador
  redacta un issue estructurado con criterios de aceptación, no-objetivos y una superficie de
  evidencia.
- **Puerta de diseño.** Los issues orientados a pantallas se detienen hasta que el consejo
  aprueba un diseño como fuente de verdad; el diseño aprobado se convierte en el objetivo de
  implementación inyectado en las ejecuciones de los agentes.
- **Listo con evidencia + firma de QA.** Los issues alcanzan *Listo* solo con evidencia; una
  política de ejecución enruta automáticamente el primer "listo" a la revisión de QA.
- **Grafo de Conocimiento + Graphify.** Un grafo de solo punteros sobre issues, código,
  decisiones y planes; `workcell code-graph` ingiere una exportación de Graphify para que la
  estructura del código se una al grafo.
- **App Blueprint (전체 앱 기획, plano completo de la aplicación).** Una vista flujo-primero al
  estilo Figma de cada pantalla de la app — boceto puro (시안) emparejado con un plan de pantalla
  (화면 기획), nodos arrastrables con posiciones persistentes, zoom en el cursor, flechas de
  navegación etiquetadas y navegación por clic hasta el plan de cada pantalla. Por proyecto; el
  boceto aprobado es el objetivo de implementación. (El plugin Open Design sigue renderizando
  artefactos, diferencias de versión y vistas previas en sandbox en una página `/design`
  dedicada.)
- **Deliberación dual-brain** *(experimental, opcional)*. Un agente, dos modelos: ambos generan
  un candidato en paralelo y luego un cerebro sintetizador los fusiona en la respuesta final
  (estilo OpenRouter-Fusion); las ejecuciones en vivo están detrás de un indicador de función
  (desactivado por defecto).
- **Trae tu propio agente.** Adaptadores locales de Claude y Codex (más HTTP/proceso) bajo un
  único organigrama.
- **Registro de Capacidades.** Habilidades, plugins, servidores MCP y sistemas de diseño
  asignados a nivel de empresa o por agente, con niveles de confianza, estados de visibilidad y
  aprobación del consejo.
- **Puente MCP (entrada + salida).** Un servidor MCP de entrada expone la API de Workcell como
  herramientas; un cliente MCP de salida permite que Workcell llame a sidecars externos
  (controlado por capacidades, con alcance por tenencia).
- **Control de costes y gobernanza.** Presupuestos por agente con límites duros, un Centro de
  Uso con insignias de precisión `Exact / Synced / Estimated`, puertas de aprobación del consejo
  y un log de auditoría inmutable de alcance por empresa.
- **Aislamiento multiempresa e i18n.** Un único despliegue, muchas empresas completamente
  aisladas; interfaz de usuario internacionalizada; tema oscuro por defecto.

Un inventario de características detallado y siempre actualizado (con etiquetas `[Paperclip]` /
`[Changed]` / `[New]`) vive en [`docs/FEATURES.md`](./docs/FEATURES.md).

---

## Deliberación dual-brain (experimental)

El responsable de un issue puede ejecutarse como **un agente con dos cerebros** — dos modelos
configurados de forma independiente — fusionados **al estilo OpenRouter-Fusion**. Ambos cerebros
**generan una respuesta candidata en paralelo e independientemente** (ninguno ve el borrador del
otro); luego un **cerebro sintetizador** (cerebro A por defecto) reconcilia los dos en una
respuesta final más sólida — conservando lo que cada uno acertó, descartando el resto y
resolviendo conflictos. Elige dos modelos *diferentes* y apilará diversidad de modelos sobre la
síntesis.

![Deliberación dual-brain](docs/assets/dual-brain.svg)

Por qué funciona: la mayor parte del beneficio viene del **propio paso de síntesis**, no solo
de la diversidad de modelos. Cuando OpenRouter midió su enfoque **Fusion** en el benchmark de
investigación profunda **DRACO** de Perplexity, emparejar **Claude Opus 4.8 *consigo mismo***
como panel de dos modelos elevó su puntuación del **58.8% al 65.5%** — porque dos pasadas
incluso del mismo modelo divergen, y un sintetizador que las reconcilia supera a un intento
único.
([artículo](https://datasciencedojo.com/blog/openrouter-fusion-api/), [OpenRouter](https://openrouter.ai/).)

**Estado: opcional, desactivado por defecto.** El motor de fusión — generación paralela +
síntesis — está implementado y probado, pero ejecutarlo con modelos *reales* está detrás de un
indicador (`WORKCELL_PAIR_LIVE_LLM`, para que dev/CI nunca gaste por accidente) y se ejecuta
como una ejecución de deliberación de agente dedicada y consultable. Consulta
[`docs/FEATURES.md`](./docs/FEATURES.md) para el alcance exacto, indicador por indicador.

---

## Arquitectura (estructura del monorepo)

Workcell es un workspace de pnpm (Node 20+, pnpm 9.15+):

| Ruta | Paquete | Rol |
| --- | --- | --- |
| `server/` | `@workcell/server` | API REST Express + servicios de orquestación (latido, ejecuciones, puerta de diseño, gobernanza, auditoría) |
| `ui/` | `@workcell/ui` | UI del panel React + Vite (servida por la API en desarrollo) |
| `cli/` | `workcell` | CLI / binario `workcell` — incorporación, configuración, code-graph, sincronización en la nube |
| `packages/shared/` | `@workcell/shared` | Tipos compartidos, constantes, validadores, contratos de rutas de API |
| `packages/db/` | `@workcell/db` | Esquema Drizzle, migraciones, clientes de BD (PostgreSQL embebido en desarrollo) |
| `packages/adapters/` | — | Adaptadores de agente (claude / codex / …) |
| `packages/adapter-utils/` | `@workcell/adapter-utils` | Utilidades compartidas de adaptador (inyección MCP, mapeo de costes) |
| `packages/mcp-server/` | `@workcell/mcp-server` | Servidor MCP de entrada (API de Workcell → herramientas) |
| `packages/mcp-bridge/` | `@workcell/mcp-bridge` | Cliente MCP de salida (Workcell → sidecars MCP externos) |
| `packages/plugins/` | — | Sistema de plugins, SDK, proveedores de sandbox, plugins de ejemplo (incl. panel Open Design) |

Un único proceso Node ejecuta la API, un PostgreSQL embebido y almacenamiento local de archivos
en desarrollo; en producción apúntalo a tu propio Postgres.

---

## Primeros pasos

Requisitos: **Node.js 20+**, **pnpm 9.15+**.

```bash
pnpm install
pnpm dev          # API + UI en modo watch
```

Una base de datos PostgreSQL embebida se crea automáticamente en desarrollo — deja
`DATABASE_URL` sin definir para usarla. Scripts comunes (desde `package.json`):

```bash
pnpm dev          # desarrollo completo (API + UI, watch)
pnpm dev:server   # solo servidor
pnpm typecheck    # comprobación de tipos en todo el workspace
pnpm test         # ejecución estable de Vitest (NO ejecuta Playwright)
pnpm build        # construir todos los paquetes
pnpm test:e2e     # suite de navegador Playwright (opcional)
pnpm db:generate  # generar una migración de BD
pnpm db:migrate   # aplicar migraciones
```

Primera ejecución: el asistente de incorporación crea tu equipo (diseño-primero por defecto),
inicializa el **Orquestador** y abre tu primer issue. Luego contrata el resto del equipo
recomendado — Ingeniero, Diseñador, QA — desde la página de Agentes (un clic por puesto
vacante).

Consulta [`AGENTS.md`](./AGENTS.md) para el flujo de trabajo del contribuidor y las reglas de
ingeniería.

### Mapa de documentación

| Área | Archivo |
| --- | --- |
| Especificación detallada del producto | [`PRODUCT_SPEC.md`](./PRODUCT_SPEC.md) |
| Inventario de características (vs Paperclip) | [`docs/FEATURES.md`](./docs/FEATURES.md) |
| Plan activo / hoja de ruta / decisiones | [`docs/plan/PLAN.md`](./docs/plan/PLAN.md) · [`docs/plan/ROADMAP.md`](./docs/plan/ROADMAP.md) · [`docs/plan/DECISIONS.md`](./docs/plan/DECISIONS.md) |
| Soluciones reutilizables / reglas de prevención | [`docs/solutions/INDEX.md`](./docs/solutions/INDEX.md) |

---

## Licencia y atribución

Workcell se publica bajo la [Licencia MIT](./LICENSE) (© 2026 Workcell).

Partes de Workcell están derivadas de **Paperclip** (`paperclipai`), © 2025 Paperclip AI,
también con licencia MIT. Según lo exige la Licencia MIT, el aviso de copyright original y el
aviso de permiso de Paperclip se reproducen en [`NOTICE`](./NOTICE) y deben conservarse en las
redistribuciones.
