# Workcell

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-20%2B-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![pnpm 9.15+](https://img.shields.io/badge/pnpm-9.15%2B-F69220.svg?logo=pnpm&logoColor=white)](https://pnpm.io)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

**Workcell é uma plataforma de operações multi-agente especializada na condução de projetos de desenvolvimento: um conselho humano define a direção, e uma equipe de IA — Orquestrador, Desenvolvedor, Designer, QA — entrega com evidências.**

[English](./README.md) · [한국어](./README.ko.md) · [日本語](./README.ja.md) · [简体中文](./README.zh-CN.md) · [繁體中文](./README.zh-TW.md) · [Español](./README.es.md) · [Français](./README.fr.md) · [Deutsch](./README.de.md) · [Português (BR)](./README.pt-BR.md) · [Русский](./README.ru.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md) · [Bahasa Indonesia](./README.id.md) · [Italiano](./README.it.md)

Você permanece no conselho: você é responsável pela direção, aprovações e políticas. Os agentes assumem papéis funcionais, pegam issues e deixam para trás tanto os produtos de trabalho quanto a **evidência** de que o trabalho foi realmente concluído. O plano de controle gerencia a organização — projetos, issues, orçamentos, governança e um registro de auditoria imutável — enquanto você dedica seu tempo às decisões que realmente importam.

> Opere como uma empresa · execute como issues · design como fonte de verdade · deixe os humanos julgarem.

---

## Filosofia

Workcell tem uma opinião bem definida sobre como um projeto de desenvolvimento deve ser conduzido. Quatro compromissos moldam todo o produto:

### 1. O humano é o conselho, não um espectador

Não existe "empresa sem humanos" aqui. O humano é dono da direção, das aprovações e das políticas; os agentes são donos da execução. Cada portão que importa — aprovação de design, revisão de evidências, orçamento, contratação — termina em uma decisão humana, registrada em um log de auditoria imutável.

### 2. Um projeto de desenvolvimento é entregue por uma equipe real

Workcell traz **quatro papéis por padrão — Orquestrador, Designer, Desenvolvedor, QA.** Esta é uma filosofia deliberada, não um template: esses quatro são a *menor* equipe capaz de levar uma ideia da intenção à prova — design-first, com um responsável claro em cada portão.

| Papel | Função | Responsabilidade |
| --- | --- | --- |
| **Orchestrator** | roteamento e coordenação | transforma linguagem natural em issues estruturadas, direciona o trabalho para o papel certo e monitora execuções travadas |
| **Designer** | `designer` | o sistema de design — propõe o rascunho de design (시안, o mockup renderizado/rascunho), mantém os designs aprovados como fonte de verdade (**o design vem primeiro**) |
| **Developer** | `engineer` | implementação, depuração, testes — desenvolve com base no design *aprovado*, nunca à sua frente |
| **QA** | `qa` | o veredicto de *Concluído* — reproduz, verifica e assina a evidência |

O onboarding inicializa o Orquestrador; a página de Agentes exibe os papéis ausentes como contratações de um clique. O estatuto do Orquestrador direciona código para engenheiros, UX para designers e verificação para QA — assim, a forma da equipe não é apenas documentação, é como o trabalho flui.

**Os quatro papéis são um esqueleto, não um teto — expanda livremente sobre eles.** Contrate papéis funcionais adicionais conforme o trabalho exigir — **Lead, PM, Pesquisador, Escritor, Segurança, DevOps ou um agente de propósito geral** — e equipe qualquer agente com habilidades com escopo definido, plugins, servidores MCP e sistemas de design do Registro de Capacidades. Execute o responsável por um issue como um único agente ou — experimental, opt-in — como **dual-brain** (dois modelos geram em paralelo, depois um sintetizador os mescla). O padrão mantém um novo projeto coerente desde o primeiro dia; a organização então cresce para se adequar ao projeto — não o contrário.

### 3. Todo o app é planejado como um único blueprint — o design é a fonte de verdade

Cada projeto tem um **App Blueprint (전체 앱 기획, o plano geral do aplicativo)**: uma visão flow-first, no estilo Figma, de todas as telas do aplicativo, para que o plano e o design vivam em um único lugar.

![App Blueprint — telas como um fluxo, cada uma pareada com seu plano](docs/assets/app-blueprint.svg)

- **Tela + plano, como um par.** Cada tela é um **rascunho de design puro (시안, o mockup renderizado)** unido ao seu **plano de tela (화면 기획)** — a especificação de propósito, estados, interações e dados. O mockup mostra *o que* uma tela é; o plano a descreve. Eles são criados e movem juntos (uma tela = um 시안 + um plano).
- **Flow-first.** O blueprint abre no fluxo: nós de tela conectados por setas de navegação rotuladas, para que a composição completa do aplicativo seja legível de relance. Os nós são **reposicionáveis por arrastar com posições persistidas**, o canvas amplia no cursor, e clicar em uma tela abre seu detalhe de **plano de tela (화면 기획)** — o mockup ao lado do plano, com os links de entrada/saída daquela tela explicitados.
- **O design é a fonte de verdade.** Para trabalhos voltados a telas, a implementação segue o design — nunca o contrário. O rascunho de design (시안) principal de um issue passa por um portão de revisão (`needs_board_review → approved | changes_requested`); até o conselho aprovar, os agentes **pausam o desenvolvimento**; após a aprovação, o design é injetado como alvo de implementação. Novas equipes são **design-first por padrão** (issues não visuais podem optar por sair por issue com uma justificativa).
- O agente designer cria cada tela como o rascunho de design (시안) puro **mais** seu plano, e designs legados podem ser recriados no mesmo modelo pareado.

### 4. Concluído significa comprovado

Adotando a disciplina do issueflow, cada issue carrega critérios de aceitação, não-objetivos e uma superfície de evidência. Um issue **não pode chegar a *Concluído* sem um pacote de evidências**, o papel de QA é dono do veredicto, e concluir um issue inicia um ciclo de aprendizado composto (checklist automático → preenchimento automático opcional por LLM → issues de acompanhamento). O conhecimento se acumula em vez de evaporar.

---

## Derivado do Paperclip, reconstruído para projetos de desenvolvimento

Workcell começou como um fork do **Paperclip** (`paperclipai`, licença MIT) — um plano de controle open-source bem construído para orquestrar equipes de agentes de IA: organogramas, heartbeats, orçamentos, governança, um sistema de tickets, um log de auditoria imutável e isolamento real multi-empresa. Esse plano de controle é engenharia real e sólida, e Workcell o mantém como fundação. Somos gratos por isso, e o aviso de copyright original do Paperclip e a permissão MIT estão preservados em [`NOTICE`](./NOTICE).

Fizemos o fork porque nossa **filosofia de produto divergiu** — não porque algo no Paperclip estava errado para seus próprios objetivos. O Paperclip se posiciona em torno de *empresas sem humanos*: uma força de trabalho de IA autônoma que você "contrata" em um organograma CEO/CTO e da qual você se afasta em grande parte. Workcell adota a postura oposta sobre o papel do humano e estreita o objetivo de "gerir qualquer negócio" para **gerenciar projetos de desenvolvimento bem**. Essa diferença é profunda o suficiente para mudar o modelo de domínio, a UX e a definição de "concluído":

- **A metáfora CEO-empresa → um modelo de conselho + orquestrador + papéis funcionais.** O humano é o **conselho**; o agente principal é um **Orquestrador** que roteia e coordena. Os agentes são papéis funcionais (orquestrador, lead, PM, engenheiro, designer, pesquisador, escritor, QA, segurança, devops, geral), não títulos de C-suite.
- **Disciplina de execução design-first + gate por evidência.** A aprovação de design porta a implementação; a evidência porta *Concluído*; QA é dono do veredicto; o aprendizado composto fecha o ciclo. Nada disso existe no Paperclip padrão — é a mudança comportamental mais estrutural do fork.
- **Open Design + Graphify, integrados.** Workcell integra operações de design no estilo [Open Design](https://github.com/nexu-io/open-design) (artefatos de design, portões de revisão, um plugin de painel de design) e um **Grafo de Conhecimento** alimentado pelo produtor de grafo de código **Graphify** — para que os agentes naveguem por issues, código, decisões e designs como um índice conectado, em vez de redescobrir o repositório a cada execução.
- **Novos subsistemas de orquestração.** Um **Registro de Capacidades** (habilidades / plugins / MCP / sistemas de design com escopo, visibilidade e níveis de confiança), **deliberação dual-brain** (um agente se auto-revisando em dois modelos), uma **ponte MCP** de saída, e uma camada de watchdog/recuperação que encerra execuções concluídas-mas-travadas em vez de gerar burocracia.
- **Produtização multi-tenant / i18n.** Isolamento de tenant reforçado, auditorias completas de delete-cascade, internacionalização de primeira classe, tema escuro por padrão.

Workcell é um fork independente e não é afiliado nem endossado pelo Paperclip.

---

## Funcionalidades principais

- **Linguagem natural → issue.** Descreva uma funcionalidade no board e o Orquestrador elabora um issue estruturado com critérios de aceitação, não-objetivos e uma superfície de evidência.
- **Portão de design.** Issues voltados a telas ficam suspensos até o conselho aprovar um design como fonte de verdade; o design aprovado torna-se o alvo de implementação injetado nas execuções dos agentes.
- **Concluído gate por evidência + aprovação de QA.** Issues chegam a *Concluído* apenas com evidências; uma política de execução direciona o primeiro "concluído" para revisão de QA automaticamente.
- **Grafo de Conhecimento + Graphify.** Um grafo apenas de ponteiros sobre issues, código, decisões e planos; `workcell code-graph` ingere uma exportação do Graphify para que a estrutura do código entre no grafo.
- **App Blueprint (전체 앱 기획).** Uma visão flow-first, no estilo Figma, de cada tela do aplicativo — rascunho de design (시안) puro pareado com um plano de tela (화면 기획), nós arrastáveis com posições persistidas, zoom no cursor, setas de navegação rotuladas e clique para o plano de cada tela. Por projeto; o 시안 aprovado é o alvo de implementação. (O plugin Open Design ainda renderiza artefatos, diffs de versão e pré-visualizações em sandbox em uma página dedicada `/design`.)
- **Deliberação dual-brain** *(experimental, opt-in)*. Um agente, dois modelos: ambos geram um candidato em paralelo, depois um cérebro sintetizador os mescla na resposta final (estilo OpenRouter-Fusion); execuções ao vivo são controladas por flag (desativado por padrão).
- **Traga seu próprio agente.** Adaptadores locais para Claude e Codex (além de HTTP/processo) sob um único organograma.
- **Registro de Capacidades.** Habilidades, plugins, servidores MCP e sistemas de design atribuídos no escopo da empresa ou por agente, com níveis de confiança, estados de visibilidade e aprovação do conselho.
- **Ponte MCP (entrada + saída).** Um servidor MCP de entrada expõe a API do Workcell como ferramentas; um cliente MCP de saída permite que o Workcell chame sidecars externos (com gate de capacidade e escopo de tenant).
- **Controle de custos e governança.** Orçamentos por agente com paradas rígidas, um Centro de Uso com emblemas de precisão `Exact / Synced / Estimated`, portões de aprovação do conselho e um log de auditoria imutável com escopo de empresa.
- **Isolamento multi-empresa e i18n.** Uma única implantação, muitas empresas totalmente isoladas; UI voltada ao usuário internacionalizada; tema escuro por padrão.

Um inventário de funcionalidades detalhado e sempre atualizado (com tags `[Paperclip]` / `[Changed]` / `[New]`) está em [`docs/FEATURES.md`](./docs/FEATURES.md).

---

## Deliberação dual-brain (experimental)

O responsável por um issue pode ser executado como **um agente com dois cérebros** — dois modelos configurados de forma independente — fundidos **no estilo OpenRouter-Fusion**. Ambos os cérebros **geram uma resposta candidata em paralelo e de forma independente** (nenhum vê o rascunho do outro); em seguida, um **cérebro sintetizador** (cérebro A por padrão) reconcilia os dois em uma resposta final mais robusta — mantendo o que cada um acertou, descartando o resto, resolvendo conflitos. Escolha dois modelos *diferentes* e você acumula diversidade de modelos sobre a síntese.

![Deliberação dual-brain](docs/assets/dual-brain.svg)

Por que funciona: a maior parte do ganho vem da **etapa de síntese em si**, não apenas da diversidade de modelos. Quando a OpenRouter mediu sua abordagem **Fusion** no benchmark de pesquisa profunda **DRACO** da Perplexity, parear **Claude Opus 4.8 *consigo mesmo*** como um painel de dois modelos elevou sua pontuação de **58.8% para 65.5%** — porque duas passagens do mesmo modelo divergem, e um sintetizador que as reconcilia supera uma única tentativa.
([artigo](https://datasciencedojo.com/blog/openrouter-fusion-api/), [OpenRouter](https://openrouter.ai/).)

**Status: opt-in, desativado por padrão.** O motor de fusão — gerar em paralelo + sintetizar — está implementado e testado, mas executá-lo com modelos *reais* está bloqueado por uma flag (`WORKCELL_PAIR_LIVE_LLM`, para que dev/CI nunca gastem por acidente) e é executado como uma execução de deliberação de agente dedicada e consultável. Veja [`docs/FEATURES.md`](./docs/FEATURES.md) para o escopo exato, flag a flag.

---

## Arquitetura (estrutura do monorepo)

Workcell é um workspace pnpm (Node 20+, pnpm 9.15+):

| Caminho | Pacote | Função |
| --- | --- | --- |
| `server/` | `@workcell/server` | API REST Express + serviços de orquestração (heartbeat, execuções, portão de design, governança, auditoria) |
| `ui/` | `@workcell/ui` | UI do board em React + Vite (servida pela API em dev) |
| `cli/` | `workcell` | CLI / binário `workcell` — onboard, configurar, code-graph, sincronização na nuvem |
| `packages/shared/` | `@workcell/shared` | Tipos, constantes, validadores e contratos de caminho de API compartilhados |
| `packages/db/` | `@workcell/db` | Schema Drizzle, migrações, clientes de BD (Postgres embutido em dev) |
| `packages/adapters/` | — | Adaptadores de agente (claude / codex / …) |
| `packages/adapter-utils/` | `@workcell/adapter-utils` | Utilitários compartilhados de adaptador (injeção MCP, mapeamento de custo) |
| `packages/mcp-server/` | `@workcell/mcp-server` | Servidor MCP de entrada (API Workcell → ferramentas) |
| `packages/mcp-bridge/` | `@workcell/mcp-bridge` | Cliente MCP de saída (Workcell → sidecars MCP externos) |
| `packages/plugins/` | — | Sistema de plugins, SDK, provedores sandbox, plugins de exemplo (incl. painel Open Design) |

Um único processo Node executa a API, um PostgreSQL embutido e armazenamento local de arquivos em desenvolvimento; em produção você aponta para o seu próprio Postgres.

---

## Primeiros passos

Requisitos: **Node.js 20+**, **pnpm 9.15+**.

```bash
pnpm install
pnpm dev          # API + UI em modo watch
```

Um banco de dados PostgreSQL embutido é criado automaticamente em desenvolvimento — deixe `DATABASE_URL` sem valor para usá-lo. Scripts comuns (de `package.json`):

```bash
pnpm dev          # dev completo (API + UI, watch)
pnpm dev:server   # apenas servidor
pnpm typecheck    # verificação de tipos em todo o workspace
pnpm test         # execução estável do Vitest (NÃO executa Playwright)
pnpm build        # compila todos os pacotes
pnpm test:e2e     # suite de browser Playwright (opt-in)
pnpm db:generate  # gera uma migração de BD
pnpm db:migrate   # aplica as migrações
```

Primeira execução: o assistente de onboarding cria sua equipe (design-first por padrão), inicializa o **Orquestrador** e abre seu primeiro issue. Em seguida, contrate o restante da equipe recomendada — Engenheiro, Designer, QA — na página de Agentes (um clique por vaga ausente).

Veja [`AGENTS.md`](./AGENTS.md) para o fluxo de trabalho de colaboradores e as regras de engenharia.

### Mapa de documentação

| Área | Arquivo |
| --- | --- |
| Especificação detalhada do produto | [`PRODUCT_SPEC.md`](./PRODUCT_SPEC.md) |
| Inventário de funcionalidades (vs Paperclip) | [`docs/FEATURES.md`](./docs/FEATURES.md) |
| Plano ativo / roadmap / decisões | [`docs/plan/PLAN.md`](./docs/plan/PLAN.md) · [`docs/plan/ROADMAP.md`](./docs/plan/ROADMAP.md) · [`docs/plan/DECISIONS.md`](./docs/plan/DECISIONS.md) |
| Soluções reutilizáveis / regras de prevenção | [`docs/solutions/INDEX.md`](./docs/solutions/INDEX.md) |

---

## Licença e atribuição

Workcell é lançado sob a [Licença MIT](./LICENSE) (© 2026 Workcell).

Partes do Workcell são derivadas do **Paperclip** (`paperclipai`), © 2025 Paperclip AI, também licenciado sob MIT. Conforme exigido pela Licença MIT, o aviso de copyright e permissão original do Paperclip está reproduzido em [`NOTICE`](./NOTICE) e deve ser mantido nas redistribuições.
