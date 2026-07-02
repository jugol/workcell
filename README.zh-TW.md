# Workcell

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-20%2B-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![pnpm 9.15+](https://img.shields.io/badge/pnpm-9.15%2B-F69220.svg?logo=pnpm&logoColor=white)](https://pnpm.io)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

**Workcell 是一個專為開發專案設計的多智能體運營平台：人類董事會負責設定方向，而 AI 團隊——協調者、開發者、設計師、QA——則負責交付成果並留下完成的證明。**

[English](./README.md) · [한국어](./README.ko.md) · [日本語](./README.ja.md) · [简体中文](./README.zh-CN.md) · [繁體中文](./README.zh-TW.md) · [Español](./README.es.md) · [Français](./README.fr.md) · [Deutsch](./README.de.md) · [Português (BR)](./README.pt-BR.md) · [Русский](./README.ru.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md) · [Bahasa Indonesia](./README.id.md) · [Italiano](./README.it.md)

您作為董事會：您掌握方向、審批和政策。智能體承擔職能角色，接收任務，並同時留下工作成果與**實際完成的證明**。控制平台管理整個組織——專案、任務、預算、治理，以及不可竄改的稽核記錄——讓您將時間集中在真正重要的決策上。

> 像公司一樣運作 · 以任務方式執行 · 以設計為唯一事實來源 · 讓人類做最終判斷。

---

## 設計理念

Workcell 對開發專案的運作方式有明確的主張。四項核心承諾塑造了整個產品：

### 1. 人類是董事會，而非旁觀者

這裡沒有「零人力公司」。人類擁有方向、審批和政策；智能體擁有執行權。每一個關鍵閘門——設計審批、成果驗收、預算、招募——都終止於人類決策，並記錄在不可竄改的稽核日誌中。

### 2. 開發專案由真實的團隊交付

Workcell 預設配備**四個職位——協調者、設計師、開發者、QA。** 這是經過深思熟慮的理念，而非模板：這四個角色是能夠將想法從概念推進至已驗證成果的*最小*團隊——以設計為先，每個閘門都有明確的負責人。

| 職位 | 角色 | 負責事項 |
| --- | --- | --- |
| **協調者 (Orchestrator)** | 路由與協調 | 將自然語言轉化為結構化任務，將工作路由至正確角色，並監控卡住的執行流程 |
| **設計師 (Designer)** | `designer` | 設計系統——提出시안（渲染稿），維護經審批的唯一事實來源設計（**設計優先**） |
| **開發者 (Developer)** | `engineer` | 實作、除錯、測試——依據*已審批*的設計進行建構，絕不超前設計 |
| **QA** | `qa` | *完成*的最終裁決——重現、驗證，並對成果進行簽核 |

入職流程會初始化協調者；智能體頁面會將缺少的職位顯示為一鍵招募選項。協調者的章程將程式碼路由給工程師、UX 路由給設計師、驗證路由給 QA——因此團隊結構不只是文件，它決定了工作流程的走向。

**四個職位是骨架，而非上限——可自由擴展。** 根據工作需求招募額外的職能角色——**Lead、PM、研究員、撰稿人、資安、DevOps，或通用智能體**——並透過能力登錄系統 (Capability Registry) 為任何智能體配備有範圍限制的技能、插件、MCP 伺服器與設計系統。以單一智能體執行任務的負責人，或——實驗性、選擇性啟用——以**雙腦 (dual-brain)** 模式運作（兩個模型並行生成，再由合成器合併）。預設設定讓新專案從第一天起保持一致性；組織隨後依據專案需求成長——而非反其道而行。

### 3. 整個應用以單一藍圖規劃——設計是唯一事實來源

每個專案都有一份 **App Blueprint（全體 App 企劃）**：以流程優先、類 Figma 的視角呈現整個應用的所有畫面，讓企劃與設計共存於同一處。

![App Blueprint — 以流程呈現畫面，每個畫面與其企劃配對](docs/assets/app-blueprint.svg)

- **畫面與企劃，成對存在。** 每個畫面都是**純시안（渲染稿）**，與其**화면 기획（畫面企劃）**相結合——涵蓋目的、狀態、互動與資料的規格說明。渲染稿呈現*畫面是什麼*；企劃描述它。兩者同步撰寫、同步移動（一個畫面 = 一份시안 + 一份企劃）。
- **流程優先。** 藍圖以流程視角開啟：畫面節點透過帶有標籤的導覽箭頭相互連接，讓整個應用的結構一目了然。節點可**拖曳調整位置並持久保存**，畫布以游標為中心縮放，點擊畫面可開啟其**화면 기획**詳細頁面——渲染稿與企劃並排呈現，並列出該畫面的入站/出站連結。
- **設計是唯一事實來源。** 對於面向畫面的工作，實作跟隨設計——絕不反過來。任務的主要시안通過審核閘門（`needs_board_review → approved | changes_requested`）；在董事會審批之前，智能體**暫停開發**；審批後設計將被注入為實作目標。新團隊**預設以設計優先**（非視覺性任務可逐一選擇退出並附上理由）。
- 設計師智能體將每個畫面撰寫為純시안**加上**其企劃，既有設計亦可重新整合至相同的配對模型中。

### 4. 完成意味著已驗證

借鑒 issueflow 的規範，每個任務都包含驗收標準、非目標，以及成果展示面。任務**必須附帶成果包才能進入*完成*狀態**，QA 角色擁有裁決權，任務完成後將啟動複合學習循環（自動核查清單 → 可選 LLM 自動填寫 → 後續任務）。知識持續累積，而非消散。

---

## 從 Paperclip 分叉，為開發專案重建

Workcell 起源於 **Paperclip**（`paperclipai`，MIT 授權）的分叉——一個架構完善的開源控制平台，用於協調 AI 智能體團隊：組織架構圖、心跳機制、預算、治理、工單系統、不可竄改的稽核日誌，以及真正的多公司隔離。這個控制平台是真實且紮實的工程，Workcell 將其作為基礎。我們對此深表感謝，Paperclip 的原始版權與 MIT 授權聲明已保存於 [`NOTICE`](./NOTICE) 中。

我們選擇分叉，是因為**產品理念產生了分歧**——並非 Paperclip 在其自身目標上有任何問題。Paperclip 圍繞*零人力公司*的概念構建：一個自主的 AI 勞動力，讓您「招募」進 CEO/CTO 組織架構後基本上退居幕後。Workcell 對人類角色採取相反立場，並將目標從「運營任何業務」縮小至**妥善運行開發專案**。這一差異深入到領域模型、使用者體驗，以及「完成」的定義：

- **CEO 公司隱喻 → 董事會 + 協調者 + 職能角色模型。** 人類是**董事會**；頂層智能體是負責路由與協調的**協調者**。智能體是職能角色（協調者、主管、PM、工程師、設計師、研究員、撰稿人、QA、資安、DevOps、通用），而非 C 字頭職稱。
- **設計優先 + 成果閘門執行規範。** 設計審批閘管實作；成果閘管*完成*；QA 擁有裁決權；複合學習形成閉環。這些在原版 Paperclip 中均不存在——這是本分叉最核心的行為變更。
- **Open Design + Graphify，深度整合。** Workcell 整合了 [Open Design](https://github.com/nexu-io/open-design) 風格的設計操作（設計物件、審核閘門、設計儀表板插件），以及由 **Graphify** 程式碼圖譜生成器驅動的**知識圖譜 (Knowledge Graph)**——讓智能體將任務、程式碼、決策與設計作為一個連通索引來瀏覽，而不是每次執行都重新探索代碼庫。
- **全新的協調子系統。** **能力登錄系統** (Capability Registry)（技能/插件/MCP/設計系統，具備範圍、可見性與信任等級）、**雙腦審議** (dual-brain deliberation)（一個智能體跨兩個模型進行自我審查）、對外的 **MCP 橋接**，以及一個看門狗/恢復層，用於折疊已完成但卡住的執行流程，而非繼續填寫文書。
- **多租戶 / i18n 產品化。** 強化的租戶隔離、完整的級聯刪除稽核、第一級國際化支援、預設深色主題。

Workcell 是一個獨立的分叉，與 Paperclip 沒有從屬或背書關係。

---

## 主要功能

- **自然語言 → 任務。** 在董事會上描述一項功能，協調者會起草一份包含驗收標準、非目標與成果展示面的結構化任務。
- **設計閘門。** 面向畫面的任務暫停執行，直至董事會審批唯一事實來源設計；已審批的設計成為注入智能體執行流程的實作目標。
- **成果閘門完成 + QA 簽核。** 任務僅在附有成果證據時才能進入*完成*狀態；執行策略自動將首次「完成」路由至 QA 審核。
- **知識圖譜 + Graphify。** 一個僅含指針的圖譜，涵蓋任務、程式碼、決策與計劃；`workcell code-graph` 可匯入 Graphify 匯出檔，使程式碼結構加入圖譜。
- **App Blueprint（全體 App 企劃）。** 以流程優先、類 Figma 的視角呈現應用中的每個畫面——純시안與화면 기획（畫面企劃）配對，節點可拖曳並持久保存，游標縮放，帶標籤的導覽箭頭，以及點擊至各畫面企劃的功能。各專案獨立；已審批的시안是實作目標。（Open Design 插件仍在專用的 `/design` 頁面渲染物件、版本差異與沙盒預覽。）
- **雙腦審議** *(實驗性，選擇啟用)*。一個智能體，兩個模型：兩者並行生成候選答案，再由合成器腦合併為最終答案（OpenRouter-Fusion 風格）；即時執行以旗標控制（預設關閉）。
- **自帶智能體。** Claude 和 Codex 本地適配器（以及 HTTP/程序）統一在同一組織架構下。
- **能力登錄系統。** 在公司或各智能體層級分配技能、插件、MCP 伺服器與設計系統，具備信任等級、可見性狀態與董事會審批。
- **MCP 橋接（入站 + 出站）。** 入站 MCP 伺服器將 Workcell 的 API 暴露為工具；出站 MCP 客戶端讓 Workcell 呼叫外部邊車服務（受能力閘門控制，以租戶為範圍）。
- **成本控制與治理。** 每個智能體的預算有硬性上限，使用中心附有 `精確/同步/估計` 精確度標籤，董事會審批閘門，以及不可竄改的公司範圍稽核日誌。
- **多公司隔離與 i18n。** 單一部署，多個完全隔離的公司；面向使用者的 UI 已國際化；預設深色主題。

詳細且持續更新的功能清單（含 `[Paperclip]` / `[Changed]` / `[New]` 標籤）位於 [`docs/FEATURES.md`](./docs/FEATURES.md)。

---

## 雙腦審議（實驗性）

任務負責人可以以**一個智能體搭配兩個腦**的方式執行——兩個獨立配置的模型——以 **OpenRouter-Fusion 風格**融合。兩個腦**並行且獨立地生成候選答案**（兩者互不知曉對方的草稿）；然後由**合成器腦**（預設為腦 A）將兩者整合為一個更強的最終答案——保留各自做對的部分，捨棄其餘，解決衝突。選擇兩個*不同*的模型，即可在合成之上疊加模型多樣性的優勢。

![雙腦審議](docs/assets/dual-brain.svg)

為什麼有效：大部分提升來自**合成步驟本身**，而非僅來自模型多樣性。當 OpenRouter 在 Perplexity 的 **DRACO** 深度研究基準上測量其 **Fusion** 方法時，將 **Claude Opus 4.8 與*自身***配對作為雙模型面板，其得分從 **58.8% 提升至 65.5%**——因為即使同一個模型進行兩次，也會產生差異，而能夠調和兩者的合成器優於單次嘗試。
（[詳細說明](https://datasciencedojo.com/blog/openrouter-fusion-api/)，[OpenRouter](https://openrouter.ai/)。）

**狀態：選擇啟用，預設關閉。** 融合引擎——並行生成 + 合成——已實作並測試，但以*真實*模型驅動受旗標控制（`WORKCELL_PAIR_LIVE_LLM`，確保開發/CI 環境不會意外產生費用），並以專用的、可輪詢的智能體審議執行流程運行。精確的旗標範圍說明請參閱 [`docs/FEATURES.md`](./docs/FEATURES.md)。

---

## 架構（Monorepo 結構）

Workcell 是一個 pnpm 工作區（Node 20+，pnpm 9.15+）：

| 路徑 | 套件 | 角色 |
| --- | --- | --- |
| `server/` | `@workcell/server` | Express REST API + 協調服務（心跳、執行流程、設計閘門、治理、稽核） |
| `ui/` | `@workcell/ui` | React + Vite 董事會 UI（開發模式由 API 提供服務） |
| `cli/` | `workcell` | CLI / `workcell` 執行檔——入職、設定、程式碼圖譜、雲端同步 |
| `packages/shared/` | `@workcell/shared` | 共用型別、常數、驗證器、API 路徑合約 |
| `packages/db/` | `@workcell/db` | Drizzle 結構描述、遷移、DB 客戶端（開發模式使用內嵌 Postgres） |
| `packages/adapters/` | — | 智能體適配器（claude / codex / …） |
| `packages/adapter-utils/` | `@workcell/adapter-utils` | 共用適配器工具（MCP 注入、成本對應） |
| `packages/mcp-server/` | `@workcell/mcp-server` | 入站 MCP 伺服器（Workcell API → 工具） |
| `packages/mcp-bridge/` | `@workcell/mcp-bridge` | 出站 MCP 客戶端（Workcell → 外部 MCP 邊車服務） |
| `packages/plugins/` | — | 插件系統、SDK、沙盒提供者、範例插件（含 Open Design 儀表板） |

單一 Node 程序在開發模式下同時執行 API、內嵌 PostgreSQL 與本機文件儲存；在生產環境中，您可指向自己的 Postgres 實例。

---

## 快速上手

需求：**Node.js 20+**、**pnpm 9.15+**。

```bash
pnpm install
pnpm dev          # API + UI 監看模式
```

開發模式下會自動建立內嵌的 PostgreSQL 資料庫——不設定 `DATABASE_URL` 即可使用。常用指令（來自 `package.json`）：

```bash
pnpm dev          # 完整開發模式（API + UI，監看）
pnpm dev:server   # 僅啟動伺服器
pnpm typecheck    # 工作區範圍的型別檢查
pnpm test         # 穩定的 Vitest 執行（不執行 Playwright）
pnpm build        # 建構所有套件
pnpm test:e2e     # Playwright 瀏覽器測試套件（選擇啟用）
pnpm db:generate  # 產生 DB 遷移
pnpm db:migrate   # 套用遷移
```

首次執行：入職精靈會建立您的團隊（預設設計優先）、初始化**協調者**，並開啟您的第一個任務。然後從智能體頁面招募其餘推薦的團隊成員——工程師、設計師、QA（每個缺少的職位一鍵完成）。

貢獻者工作流程與工程規範請參閱 [`AGENTS.md`](./AGENTS.md)。

### 文件導覽

| 領域 | 文件 |
| --- | --- |
| 詳細產品規格 | [`PRODUCT_SPEC.md`](./PRODUCT_SPEC.md) |
| 功能清單（vs Paperclip） | [`docs/FEATURES.md`](./docs/FEATURES.md) |
| 現行計劃 / 路線圖 / 決策 | [`docs/plan/PLAN.md`](./docs/plan/PLAN.md) · [`docs/plan/ROADMAP.md`](./docs/plan/ROADMAP.md) · [`docs/plan/DECISIONS.md`](./docs/plan/DECISIONS.md) |
| 可重用解決方案 / 預防規則 | [`docs/solutions/INDEX.md`](./docs/solutions/INDEX.md) |

---

## 授權與致謝

Workcell 依據 [MIT 授權](./LICENSE)發布（© 2026 Workcell）。

Workcell 的部分內容衍生自 **Paperclip**（`paperclipai`），© 2025 Paperclip AI，同樣採用 MIT 授權。依 MIT 授權的要求，Paperclip 的原始版權與授權聲明已收錄於 [`NOTICE`](./NOTICE) 中，且在再發布時必須保留。
