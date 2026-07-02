# Workcell

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-20%2B-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![pnpm 9.15+](https://img.shields.io/badge/pnpm-9.15%2B-F69220.svg?logo=pnpm&logoColor=white)](https://pnpm.io)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

**Workcell 是一个专为开发项目运营打造的多智能体协作平台：人类董事会负责把控方向，AI 团队——协调者、开发者、设计师、QA——以可验证的方式交付成果。**

[English](./README.md) · [한국어](./README.ko.md) · [日本語](./README.ja.md) · [简体中文](./README.zh-CN.md) · [繁體中文](./README.zh-TW.md) · [Español](./README.es.md) · [Français](./README.fr.md) · [Deutsch](./README.de.md) · [Português (BR)](./README.pt-BR.md) · [Русский](./README.ru.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md) · [Bahasa Indonesia](./README.id.md) · [Italiano](./README.it.md)

您担任董事会角色：掌握方向、审批决策、制定策略。智能体承担各自的职能角色，领取任务，并留下工作成果与**验证证明**，证明工作已真正完成。控制平面负责运营整个组织——项目、任务、预算、治理，以及不可篡改的审计追踪——而您则将精力集中在真正重要的决策上。

> 像公司一样运营 · 像任务一样执行 · 以设计为唯一可信源 · 让人类做最终裁决。

---

## 设计理念

Workcell 对开发项目的运作方式有着鲜明的主张。四项核心承诺塑造了整个产品：

### 1. 人类是董事会，而非旁观者

这里不存在"零人类公司"。人类掌握方向、审批决策和策略制定；智能体负责具体执行。每一个关键节点——设计审批、证明审查、预算、人员招募——都以人类决策为终点，并记录在不可篡改的审计日志中。

### 2. 开发项目配备真实团队

Workcell 默认设有**四个席位——协调者（Orchestrator）、设计师（Designer）、开发者（Developer）、QA。** 这是一种深思熟虑的产品理念，而非模板：这四个角色是能够将一个想法从构想推进到可验证成果的*最小*团队——设计优先，每个节点都有明确的负责人。

| 席位 | 角色 | 职责 |
| --- | --- | --- |
| **协调者** | routing & coordination | 将自然语言转化为结构化任务，将工作路由至合适角色，并监控卡住的运行 |
| **设计师** | `designer` | 设计系统——提出시안（渲染设计稿），维护经审批的权威设计（**设计优先**） |
| **开发者** | `engineer` | 实现、调试、测试——基于*已审批*的设计进行构建，不得超前于设计 |
| **QA** | `qa` | *完成*的最终裁决——复现、验证，并签署证明 |

入职流程会初始化协调者；智能体页面以一键操作方式展示待招募的席位。协调者的职责章程将代码路由给工程师，将 UX 路由给设计师，将验证路由给 QA——因此团队结构不仅仅是文档，而是工作流转的方式。

**四个席位是框架，而非上限——可以在此基础上自由扩展。** 根据项目需求增招职能角色——**负责人、PM、研究员、撰稿人、安全、DevOps，或通用智能体**——并通过能力注册表（Capability Registry）为任意智能体配置作用域化的技能、插件、MCP 服务器和设计系统。可以将某个任务的负责人设为单一智能体运行，或（实验性、可选）以**双脑（dual-brain）**模式运行（两个模型并行生成，合成器负责融合）。默认配置让新项目从第一天起就保持内聚；组织随后围绕项目成长——而非反过来。

### 3. 整个应用作为一个蓝图统一规划——设计是唯一可信源

每个项目都有一个 **App Blueprint（전체 앱 기획，全局应用规划）**：一个以流程为中心、类 Figma 风格的视图，展示整个应用的所有屏幕，让规划与设计共存于同一处。

![App Blueprint — 以流程视图呈现屏幕，每个屏幕配对其规划说明](docs/assets/app-blueprint.svg)

- **屏幕与规划，成对出现。** 每个屏幕都是一个**纯粹的시안（渲染设计稿）**，与其**화면 기획（屏幕规划）**配对——规划说明屏幕的用途、状态、交互和数据。设计稿展示屏幕*是什么*；规划则对其进行描述。两者共同创作、同步移动（一个屏幕 = 一个시안 + 一份规划）。
- **流程优先。** 蓝图以流程视图打开：屏幕节点通过带标签的导航箭头相互连接，使整个应用的组成结构一目了然。节点**支持拖拽重新定位并持久化位置**，画布支持以光标为中心缩放，点击某个屏幕可打开其**화면 기획**详情——设计稿与规划并排展示，并列出该屏幕的所有入链和出链。
- **设计是唯一可信源。** 对于涉及界面的工作，实现跟随设计——而非反过来。任务的主요시안需通过审查节点（`needs_board_review → approved | changes_requested`）；在董事会批准之前，智能体**暂停开发**；批准后，设计将作为实现目标注入。新团队**默认遵循设计优先原则**（非视觉类任务可逐项注明原因后选择退出）。
- 设计师智能体将每个屏幕创作为纯粹的시안**加上**其规划，旧有设计也可重新创作为同样的配对模型。

### 4. 完成意味着经过验证

借鉴 issueflow 规范，每个任务都承载着验收标准、非目标和证明面。一个任务**在没有证明包的情况下无法达到*完成*状态**，QA 角色拥有裁决权，完成一个任务将触发复合学习循环（自动检查清单 → 可选 LLM 自动填充 → 后续任务）。知识得以积累，而非消散。

---

## 从 Paperclip 分叉，为开发项目重新构建

Workcell 最初是 **Paperclip**（`paperclipai`，MIT 许可）的一个分支——Paperclip 是一个构建精良的开源控制平面，用于编排 AI 智能体团队：组织架构、心跳检测、预算、治理、工单系统、不可篡改的审计日志，以及真正的多公司隔离。这个控制平面是真实、扎实的工程成果，Workcell 将其保留为基础。我们对此深感感谢，Paperclip 的原始版权和 MIT 许可声明已保存在 [`NOTICE`](./NOTICE) 中。

我们之所以分叉，是因为我们的**产品理念出现了分歧**——而非 Paperclip 本身对其目标有任何问题。Paperclip 将自身定位于*零人类公司*：一支自主的 AI 劳动力，您将其"招募"进 CEO/CTO 组织架构，然后基本上退后旁观。Workcell 对人类角色持相反立场，并将目标从"运营任何业务"收窄为**高质量地运营开发项目**。这一差异足够深刻，足以改变领域模型、用户体验和"完成"的定义：

- **CEO-公司隐喻 → 董事会 + 协调者 + 职能角色模型。** 人类是**董事会**；顶层智能体是负责路由和协调的**协调者（Orchestrator）**。智能体是职能角色（协调者、负责人、PM、工程师、设计师、研究员、撰稿人、QA、安全、DevOps、通用），而非 C 级头衔。
- **设计优先 + 证明门控的执行规范。** 设计审批门控实现；证明门控*完成*；QA 拥有裁决权；复合学习形成闭环。这些在原版 Paperclip 中均不存在——它是本次分叉中最核心的行为变更。
- **Open Design + Graphify，深度集成。** Workcell 集成了 [Open Design](https://github.com/nexu-io/open-design) 风格的设计操作（设计产物、审查节点、设计仪表盘插件），以及由 **Graphify** 代码图生产器提供的**知识图谱**——使智能体能够将任务、代码、决策和设计作为一个互联索引进行导航，而无需在每次运行时重新探索代码库。
- **全新编排子系统。** **能力注册表**（技能/插件/MCP/设计系统，具有作用域、可见性和信任等级），**双脑审议**（一个智能体跨两个模型进行自我审查），出站 **MCP 桥接**，以及一个看门狗/恢复层，用于折叠已完成但卡住的运行，而非填写繁琐的工单。
- **多租户/i18n 产品化。** 强化的租户隔离、完整的级联删除审计、一流的国际化支持、默认深色主题。

Workcell 是一个独立的分支项目，与 Paperclip 没有从属或背书关系。

---

## 核心功能

- **自然语言 → 任务。** 在看板上描述一个功能，协调者将起草一个包含验收标准、非目标和证明面的结构化任务。
- **设计门控。** 涉及界面的任务将等待直至董事会批准权威设计；已批准的设计将作为实现目标注入智能体运行。
- **证明门控的完成 + QA 签署。** 任务只有在提交证明依据后才能达到*完成*状态；执行策略会自动将第一个"完成"路由至 QA 审查。
- **知识图谱 + Graphify。** 覆盖任务、代码、决策和规划的指针型图谱；`workcell code-graph` 可导入 Graphify 导出文件，使代码结构融入图谱。
- **App Blueprint（전체 앱 기획，全局应用规划）。** 以流程为中心、类 Figma 风格的应用全屏幕视图——纯粹的시안与화면 기획（屏幕规划）配对，可拖拽的持久化节点、光标缩放、带标签的导航箭头，以及点击直达每个屏幕规划。按项目隔离；已审批的시안即为实现目标。（Open Design 插件仍可在专用的 `/design` 页面上渲染产物、版本差异和沙箱预览。）
- **双脑审议** *（实验性，可选启用）*。一个智能体，两个模型：两者并行生成候选答案，然后合成器脑将其融合为最终答案（OpenRouter-Fusion 风格）；实时运行通过标志位控制（默认关闭）。
- **自带智能体。** Claude 和 Codex 本地适配器（以及 HTTP/进程适配器）统一纳入同一组织架构。
- **能力注册表。** 技能、插件、MCP 服务器和设计系统，可在公司或单个智能体作用域内分配，具有信任等级、可见性状态和董事会审批机制。
- **MCP 桥接（入站 + 出站）。** 入站 MCP 服务器将 Workcell 的 API 以工具形式对外暴露；出站 MCP 客户端让 Workcell 能够调用外部 sidecar（受能力门控，租户隔离）。
- **成本控制与治理。** 每个智能体的预算设有硬性上限，使用中心提供 `Exact / Synced / Estimated` 精度徽章，设有董事会审批节点，并配有不可篡改的公司作用域审计日志。
- **多公司隔离与 i18n。** 单次部署，多个完全隔离的公司；用户界面已国际化；默认深色主题。

详细且持续更新的功能清单（含 `[Paperclip]` / `[Changed]` / `[New]` 标签）见 [`docs/FEATURES.md`](./docs/FEATURES.md)。

---

## 双脑审议（实验性）

任务负责人可以作为**一个智能体搭载两个大脑**运行——两个独立配置的模型——以 **OpenRouter-Fusion 风格**融合。两个大脑**并行且独立地生成候选答案**（互不可见对方的草稿）；然后由**合成器大脑**（默认为大脑 A）将两者融合为一个更强的最终答案——保留各自正确的部分，舍弃其余，解决冲突。选择两个*不同*的模型，可在合成的基础上叠加模型多样性的优势。

![双脑审议](docs/assets/dual-brain.svg)

其有效性的原因：大部分提升来自**合成步骤本身**，而非仅仅是模型多样性。当 OpenRouter 在 Perplexity 的 **DRACO** 深度研究基准上测试其 **Fusion** 方法时，将 **Claude Opus 4.8 与*其自身***配对为双模型组合，得分从 **58.8% 提升至 65.5%**——这是因为即使是同一个模型的两次运行也会产生差异，而能够融合两者的合成器表现优于单次生成。
（[详细解读](https://datasciencedojo.com/blog/openrouter-fusion-api/)，[OpenRouter](https://openrouter.ai/)。）

**状态：可选启用，默认关闭。** 融合引擎——并行生成 + 合成——已实现并经过测试，但使用*真实*模型驱动需通过标志位控制（`WORKCELL_PAIR_LIVE_LLM`，以防开发/CI 环境意外产生费用），并作为专用的、可轮询的智能体审议运行执行。确切的标志位作用域详见 [`docs/FEATURES.md`](./docs/FEATURES.md)。

---

## 架构（Monorepo 布局）

Workcell 是一个 pnpm 工作区（Node 20+，pnpm 9.15+）：

| 路径 | 包名 | 职责 |
| --- | --- | --- |
| `server/` | `@workcell/server` | Express REST API + 编排服务（心跳、运行、设计门控、治理、审计） |
| `ui/` | `@workcell/ui` | React + Vite 看板 UI（开发模式由 API 提供服务） |
| `cli/` | `workcell` | CLI / `workcell` 二进制——入职、配置、代码图、云同步 |
| `packages/shared/` | `@workcell/shared` | 共享类型、常量、验证器、API 路径契约 |
| `packages/db/` | `@workcell/db` | Drizzle 模式、迁移、数据库客户端（开发环境内嵌 Postgres） |
| `packages/adapters/` | — | 智能体适配器（claude / codex / ……） |
| `packages/adapter-utils/` | `@workcell/adapter-utils` | 共享适配器工具（MCP 注入、成本映射） |
| `packages/mcp-server/` | `@workcell/mcp-server` | 入站 MCP 服务器（Workcell API → 工具） |
| `packages/mcp-bridge/` | `@workcell/mcp-bridge` | 出站 MCP 客户端（Workcell → 外部 MCP sidecar） |
| `packages/plugins/` | — | 插件系统、SDK、沙箱提供者、示例插件（含 Open Design 仪表盘） |

开发环境中，单个 Node 进程运行 API、内嵌 PostgreSQL 和本地文件存储；生产环境中，您需指向自己的 Postgres 实例。

---

## 快速开始

环境要求：**Node.js 20+**，**pnpm 9.15+**。

```bash
pnpm install
pnpm dev          # API + UI 监听模式
```

开发环境中会自动创建内嵌 PostgreSQL 数据库——不设置 `DATABASE_URL` 即可使用它。常用脚本（来自 `package.json`）：

```bash
pnpm dev          # 完整开发模式（API + UI，监听）
pnpm dev:server   # 仅启动服务器
pnpm typecheck    # 工作区范围内的类型检查
pnpm test         # 稳定的 Vitest 运行（不运行 Playwright）
pnpm build        # 构建所有包
pnpm test:e2e     # Playwright 浏览器测试套件（可选启用）
pnpm db:generate  # 生成数据库迁移
pnpm db:migrate   # 应用迁移
```

首次运行：入职向导将创建您的团队（默认遵循设计优先原则）、初始化**协调者**，并开启您的第一个任务。然后从智能体页面招募其余推荐成员——工程师、设计师、QA（每个缺失席位一键完成）。

贡献者工作流和工程规范详见 [`AGENTS.md`](./AGENTS.md)。

### 文档导航

| 领域 | 文件 |
| --- | --- |
| 详细产品规范 | [`PRODUCT_SPEC.md`](./PRODUCT_SPEC.md) |
| 功能清单（与 Paperclip 对比） | [`docs/FEATURES.md`](./docs/FEATURES.md) |
| 当前计划 / 路线图 / 决策记录 | [`docs/plan/PLAN.md`](./docs/plan/PLAN.md) · [`docs/plan/ROADMAP.md`](./docs/plan/ROADMAP.md) · [`docs/plan/DECISIONS.md`](./docs/plan/DECISIONS.md) |
| 可复用方案 / 预防规则 | [`docs/solutions/INDEX.md`](./docs/solutions/INDEX.md) |

---

## 许可证与署名

Workcell 以 [MIT 许可证](./LICENSE)发布（© 2026 Workcell）。

Workcell 的部分内容源自 **Paperclip**（`paperclipai`），© 2025 Paperclip AI，同样采用 MIT 许可证。依据 MIT 许可证的要求，Paperclip 的原始版权和许可声明已在 [`NOTICE`](./NOTICE) 中复现，并须在再分发时予以保留。
