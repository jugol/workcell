# Workcell

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-20%2B-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![pnpm 9.15+](https://img.shields.io/badge/pnpm-9.15%2B-F69220.svg?logo=pnpm&logoColor=white)](https://pnpm.io)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

**Workcell adalah platform operasi multi-agen yang dikhususkan untuk menjalankan proyek pengembangan: dewan manusia menetapkan arah, dan tim AI — Orchestrator, Developer, Designer, QA — mengeksekusinya disertai bukti.**

[English](./README.md) · [한국어](./README.ko.md) · [日本語](./README.ja.md) · [简体中文](./README.zh-CN.md) · [繁體中文](./README.zh-TW.md) · [Español](./README.es.md) · [Français](./README.fr.md) · [Deutsch](./README.de.md) · [Português (BR)](./README.pt-BR.md) · [Русский](./README.ru.md) · [हिन्दी](./README.hi.md) · [العربية](./README.ar.md) · [Bahasa Indonesia](./README.id.md) · [Italiano](./README.it.md)

Anda tetap menjadi dewan: Anda menentukan arah, persetujuan, dan kebijakan. Agen mengambil peran fungsional, mengerjakan isu, dan meninggalkan hasil kerja sekaligus **bukti** bahwa pekerjaan benar-benar telah selesai. Bidang kendali mengelola organisasi — proyek, isu, anggaran, tata kelola, dan jejak audit yang tidak dapat diubah — sementara Anda menghabiskan waktu pada keputusan yang benar-benar penting.

> Beroperasi seperti perusahaan · eksekusi melalui isu · desain sebagai sumber kebenaran · biarkan manusia yang menilai.

---

## Filosofi

Workcell memiliki pendapat yang kuat tentang bagaimana proyek pengembangan seharusnya dijalankan. Empat komitmen membentuk keseluruhan produk:

### 1. Manusia adalah dewan, bukan penonton

Tidak ada "perusahaan tanpa manusia" di sini. Manusia memiliki arah, persetujuan, dan kebijakan; agen memiliki eksekusi. Setiap gerbang yang penting — persetujuan desain, tinjauan bukti, anggaran, perekrutan — berakhir pada keputusan manusia, yang dicatat dalam log audit yang tidak dapat diubah.

### 2. Proyek pengembangan dikirimkan dengan tim yang nyata

Workcell menyertakan **empat peran secara default — Orchestrator, Designer, Developer, QA.** Ini adalah filosofi yang disengaja, bukan sekadar templat: keempat peran ini adalah tim *terkecil* yang dapat membawa sebuah ide dari niat ke terbukti — mengutamakan desain, dengan pemilik yang jelas untuk setiap gerbang.

| Peran | Fungsi | Bertanggung jawab atas |
| --- | --- | --- |
| **Orchestrator** | perutean & koordinasi | mengubah bahasa alami menjadi isu terstruktur, merutekan pekerjaan ke peran yang tepat, dan memantau jalannya yang macet |
| **Designer** | `designer` | sistem desain — mengusulkan 시안 (mockup desain yang dirender), memelihara desain sumber kebenaran yang disetujui (**desain didahulukan**) |
| **Developer** | `engineer` | implementasi, debugging, pengujian — membangun berdasarkan desain yang *disetujui*, tidak mendahuluinya |
| **QA** | `qa` | keputusan *Selesai* — mereproduksi, memverifikasi, dan menandatangani bukti |

Orientasi menanam Orchestrator; halaman Agen menampilkan peran yang belum diisi sebagai perekrutan satu klik. Piagam Orchestrator merutekan kode ke insinyur, UX ke desainer, dan verifikasi ke QA — sehingga bentuk tim bukan hanya dokumentasi, melainkan cara kerja mengalir.

**Empat peran adalah kerangka, bukan batas langit-langit — perluas dengan bebas di atasnya.** Rekrut peran fungsional tambahan sesuai kebutuhan pekerjaan — **Lead, PM, Researcher, Writer, Security, DevOps, atau agen serbaguna** — dan lengkapi agen mana pun dengan keahlian, plugin, server MCP, dan sistem desain yang cakupannya terbatas dari Capability Registry. Jalankan pemilik isu sebagai agen tunggal atau — eksperimental, atas pilihan — sebagai **dual-brain** (dua model menghasilkan secara paralel, kemudian synthesizer menggabungkannya). Pengaturan default menjaga proyek baru tetap koheren sejak hari pertama; organisasi kemudian berkembang sesuai proyek — bukan sebaliknya.

### 3. Seluruh aplikasi direncanakan sebagai satu cetak biru — desain adalah sumber kebenaran

Setiap proyek memiliki **App Blueprint (전체 앱 기획)**: tampilan berpusat pada alur bergaya Figma dari seluruh layar aplikasi, sehingga rencana dan desain berada di satu tempat.

![App Blueprint — layar sebagai alur, masing-masing dipasangkan dengan rencananya](docs/assets/app-blueprint.svg)

- **Layar + rencana, sebagai pasangan.** Setiap layar adalah **시안 murni (mockup yang dirender)** yang digabungkan dengan **화면 기획 (rencana layar)** — spesifikasi untuk tujuan, kondisi, interaksi, dan data. Mockup menunjukkan *apa* sebuah layar; rencana mendeskripsikannya. Keduanya dibuat dan bergerak bersama (satu layar = satu 시안 + satu rencana).
- **Berpusat pada alur.** Cetak biru terbuka pada alur: node layar yang terhubung dengan panah navigasi berlabel, sehingga komposisi seluruh aplikasi dapat dibaca sekilas. Node dapat **diatur ulang posisinya dengan seret-dan-lepas dengan posisi yang tersimpan**, kanvas dapat dizoom pada kursor, dan mengklik sebuah layar membuka detail **화면 기획** — mockup di samping rencananya, dengan tautan masuk/keluar layar tersebut yang tertera.
- **Desain adalah sumber kebenaran.** Untuk pekerjaan yang menghadap layar, implementasi mengikuti desain — tidak sebaliknya. 시안 utama sebuah isu melewati gerbang tinjauan (`needs_board_review → approved | changes_requested`); hingga dewan menyetujui, agen **menahan pengembangan**; setelah persetujuan, desain disuntikkan sebagai target implementasi. Tim baru **mengutamakan desain secara default** (isu non-visual dapat memilih keluar per isu dengan alasan).
- Agen desainer membuat setiap layar sebagai 시안 murni **ditambah** rencananya, dan desain lama dapat diubah ke model berpasangan yang sama.

### 4. Selesai berarti terbukti

Meminjam disiplin issueflow, setiap isu membawa kriteria penerimaan, non-tujuan, dan permukaan bukti. Sebuah isu **tidak dapat mencapai *Selesai* tanpa bundel bukti**, peran QA memiliki keputusan, dan menyelesaikan sebuah isu memulai siklus pembelajaran majemuk (daftar periksa otomatis → pengisian otomatis LLM opsional → isu lanjutan). Pengetahuan bertambah alih-alih menguap.

---

## Bercabang dari Paperclip, dibangun ulang untuk proyek pengembangan

Workcell dimulai sebagai cabang dari **Paperclip** (`paperclipai`, berlisensi MIT) — sebuah bidang kendali sumber terbuka yang dibangun dengan baik untuk mengorkestrasikan tim agen AI: bagan organisasi, detak jantung, anggaran, tata kelola, sistem tiket, log audit yang tidak dapat diubah, dan isolasi multi-perusahaan yang sesungguhnya. Bidang kendali tersebut adalah rekayasa yang nyata dan solid, dan Workcell mempertahankannya sebagai fondasi. Kami berterima kasih atas hal itu, dan pemberitahuan hak cipta asli serta izin MIT Paperclip dipertahankan dalam [`NOTICE`](./NOTICE).

Kami bercabang karena **filosofi produk kami menyimpang** — bukan karena ada yang salah dalam Paperclip untuk tujuannya sendiri. Paperclip membingkai dirinya di sekitar *perusahaan tanpa manusia*: tenaga kerja AI otonom yang Anda "rekrut" ke bagan organisasi CEO/CTO dan sebagian besar Anda tinggalkan. Workcell mengambil posisi berlawanan tentang peran manusia dan mempersempit tujuan dari "menjalankan bisnis apa pun" menjadi **menjalankan proyek pengembangan dengan baik**. Perbedaan itu cukup dalam untuk mengubah model domain, UX, dan definisi "selesai":

- **Metafora CEO-perusahaan → model dewan + orchestrator + peran fungsional.** Manusia adalah **dewan**; agen teratas adalah **Orchestrator** yang merutekan dan mengoordinasikan. Agen adalah peran fungsional (orchestrator, lead, PM, engineer, designer, researcher, writer, QA, security, devops, general), bukan jabatan C-suite.
- **Disiplin eksekusi mengutamakan desain + tergerbang bukti.** Persetujuan desain mengunci implementasi; bukti mengunci *Selesai*; QA memiliki keputusan; pembelajaran majemuk menutup lingkaran. Tidak satu pun dari ini ada dalam Paperclip standar — ini adalah perubahan perilaku paling krusial dari cabang tersebut.
- **Open Design + Graphify, terintegrasi.** Workcell mengintegrasikan operasi desain bergaya [Open Design](https://github.com/nexu-io/open-design) (artefak desain, gerbang tinjauan, plugin dasbor desain) dan sebuah **Knowledge Graph** yang diisi oleh produsen grafik kode **Graphify** — sehingga agen menavigasi isu, kode, keputusan, dan desain sebagai satu indeks terhubung alih-alih menemukan kembali repositori setiap kali berjalan.
- **Subsistem orkestrasi baru bersih.** Sebuah **Capability Registry** (keahlian / plugin / MCP / sistem desain dengan cakupan, visibilitas, dan tingkatan kepercayaan), **deliberasi dual-brain** (satu agen meninjau sendiri menggunakan dua model), sebuah **jembatan MCP** keluar, dan lapisan pengawas/pemulihan yang melipat jalannya yang selesai-namun-macet alih-alih mengarsipkan dokumen.
- **Produktisasi multi-penyewa / i18n.** Isolasi penyewa yang diperkuat, audit hapus-kaskade penuh, internasionalisasi kelas satu, tema gelap secara default.

Workcell adalah cabang independen dan tidak berafiliasi dengan atau didukung oleh Paperclip.

---

## Fitur utama

- **Bahasa alami → isu.** Deskripsikan fitur di papan dan Orchestrator menyusun isu terstruktur dengan kriteria penerimaan, non-tujuan, dan permukaan bukti.
- **Gerbang desain.** Isu yang menghadap layar ditahan hingga dewan menyetujui desain sumber kebenaran; desain yang disetujui menjadi target implementasi yang disuntikkan ke jalannya agen.
- **Selesai tergerbang bukti + persetujuan QA.** Isu mencapai *Selesai* hanya dengan bukti; kebijakan eksekusi merutekan "selesai" pertama ke tinjauan QA secara otomatis.
- **Knowledge Graph + Graphify.** Graf hanya penunjuk atas isu, kode, keputusan, dan rencana; `workcell code-graph` menyerap ekspor Graphify sehingga struktur kode bergabung ke dalam graf.
- **App Blueprint (전체 앱 기획).** Tampilan bergaya Figma berpusat pada alur dari setiap layar dalam aplikasi — 시안 murni yang dipasangkan dengan 화면 기획 (rencana layar), node tersimpan yang dapat diseret, zoom kursor, panah navigasi berlabel, dan klik-tayang ke rencana setiap layar. Per proyek; 시안 yang disetujui adalah target implementasi. (Plugin Open Design masih merender artefak, perbedaan versi, dan pratinjau tersandbox di halaman `/design` yang berdedikasi.)
- **Deliberasi dual-brain** *(eksperimental, atas pilihan)*. Satu agen, dua model: keduanya menghasilkan kandidat secara paralel, kemudian synthesizer brain menggabungkannya menjadi jawaban akhir yang lebih kuat (gaya OpenRouter-Fusion); jalannya langsung tergerbang oleh bendera (nonaktif secara default).
- **Bawa agen Anda sendiri.** Adaptor lokal Claude dan Codex (ditambah HTTP/proses) di bawah satu bagan organisasi.
- **Capability Registry.** Keahlian, plugin, server MCP, dan sistem desain yang ditugaskan pada cakupan perusahaan atau per agen, dengan tingkatan kepercayaan, kondisi visibilitas, dan persetujuan dewan.
- **Jembatan MCP (masuk + keluar).** Server MCP masuk memperlihatkan API Workcell sebagai alat; klien MCP keluar memungkinkan Workcell memanggil sidecar eksternal (tergerbang kemampuan, tercakup penyewa).
- **Kontrol biaya & tata kelola.** Anggaran per agen dengan pembatasan keras, Usage Center dengan lencana akurasi `Exact / Synced / Estimated`, gerbang persetujuan dewan, dan log audit yang tidak dapat diubah dan tercakup perusahaan.
- **Isolasi multi-perusahaan & i18n.** Satu deployment, banyak perusahaan yang sepenuhnya terisolasi; UI yang menghadap pengguna diinternasionalisasi; tema gelap secara default.

Inventaris fitur terperinci yang selalu terkini (dengan tag `[Paperclip]` / `[Changed]` / `[New]`) tersedia di [`docs/FEATURES.md`](./docs/FEATURES.md).

---

## Deliberasi dual-brain (eksperimental)

Pemilik isu dapat dijalankan sebagai **satu agen dengan dua otak** — dua model yang dikonfigurasi secara independen — digabungkan **gaya OpenRouter-Fusion**. Kedua otak **menghasilkan jawaban kandidat secara paralel dan independen** (tidak satu pun melihat draf yang lain); kemudian sebuah **synthesizer brain** (otak A secara default) merekonsiliasi keduanya menjadi satu jawaban akhir yang lebih kuat — mempertahankan apa yang benar dari masing-masing, membuang sisanya, menyelesaikan konflik. Pilih dua model yang *berbeda* dan Anda menambahkan keberagaman model di atas sintesis.

![Deliberasi dual-brain](docs/assets/dual-brain.svg)

Mengapa ini berhasil: sebagian besar keuntungan berasal dari **langkah sintesis itu sendiri**, bukan hanya keberagaman model. Ketika OpenRouter mengukur pendekatan **Fusion**-nya pada tolok ukur deep-research **DRACO** Perplexity, memasangkan **Claude Opus 4.8 dengan *dirinya sendiri*** sebagai panel dua model meningkatkan skornya dari **58.8% menjadi 65.5%** — karena dua kali lewatan bahkan model yang sama pun menghasilkan perbedaan, dan synthesizer yang merekonsiliasi keduanya mengalahkan satu tembakan tunggal.
([tulisan](https://datasciencedojo.com/blog/openrouter-fusion-api/), [OpenRouter](https://openrouter.ai/).)

**Status: atas pilihan, nonaktif secara default.** Mesin fusion — hasilkan paralel + sintesis — telah diimplementasikan dan diuji, tetapi menjalankannya dengan model *nyata* tergerbang di balik bendera (`WORKCELL_PAIR_LIVE_LLM`, sehingga dev/CI tidak pernah menghabiskan biaya secara tidak sengaja) dan berjalan sebagai jalannya deliberasi agen yang berdedikasi dan dapat di-polling. Lihat [`docs/FEATURES.md`](./docs/FEATURES.md) untuk cakupan yang tepat, bendera demi bendera.

---

## Arsitektur (tata letak monorepo)

Workcell adalah workspace pnpm (Node 20+, pnpm 9.15+):

| Path | Package | Peran |
| --- | --- | --- |
| `server/` | `@workcell/server` | Express REST API + layanan orkestrasi (detak jantung, jalannya, gerbang desain, tata kelola, audit) |
| `ui/` | `@workcell/ui` | UI papan React + Vite (dilayani oleh API dalam dev) |
| `cli/` | `workcell` | CLI / biner `workcell` — orientasi, konfigurasi, grafik kode, sinkronisasi cloud |
| `packages/shared/` | `@workcell/shared` | Tipe bersama, konstanta, validator, kontrak path API |
| `packages/db/` | `@workcell/db` | Skema Drizzle, migrasi, klien DB (Postgres tertanam dalam dev) |
| `packages/adapters/` | — | Adaptor agen (claude / codex / …) |
| `packages/adapter-utils/` | `@workcell/adapter-utils` | Utilitas adaptor bersama (injeksi MCP, pemetaan biaya) |
| `packages/mcp-server/` | `@workcell/mcp-server` | Server MCP masuk (API Workcell → alat) |
| `packages/mcp-bridge/` | `@workcell/mcp-bridge` | Klien MCP keluar (Workcell → sidecar MCP eksternal) |
| `packages/plugins/` | — | Sistem plugin, SDK, penyedia sandbox, plugin contoh (termasuk dasbor Open Design) |

Satu proses Node menjalankan API, PostgreSQL tertanam, dan penyimpanan file lokal dalam development; dalam production Anda mengarahkannya ke Postgres Anda sendiri.

---

## Memulai

Persyaratan: **Node.js 20+**, **pnpm 9.15+**.

```bash
pnpm install
pnpm dev          # API + UI dalam mode watch
```

Database PostgreSQL tertanam dibuat secara otomatis dalam development — biarkan `DATABASE_URL` tidak diatur untuk menggunakannya. Skrip umum (dari `package.json`):

```bash
pnpm dev          # dev penuh (API + UI, watch)
pnpm dev:server   # hanya server
pnpm typecheck    # pemeriksaan tipe seluruh workspace
pnpm test         # jalannya Vitest yang stabil (TIDAK menjalankan Playwright)
pnpm build        # bangun semua package
pnpm test:e2e     # suite browser Playwright (atas pilihan)
pnpm db:generate  # hasilkan migrasi DB
pnpm db:migrate   # terapkan migrasi
```

Jalankan pertama kali: wizard orientasi membuat tim Anda (mengutamakan desain secara default), menanam **Orchestrator**, dan membuka isu pertama Anda. Kemudian rekrut sisa tim yang direkomendasikan — Engineer, Designer, QA — dari halaman Agen (satu klik per peran yang belum diisi).

Lihat [`AGENTS.md`](./AGENTS.md) untuk alur kerja kontributor dan aturan rekayasa.

### Peta dokumentasi

| Area | File |
| --- | --- |
| Spesifikasi produk terperinci | [`PRODUCT_SPEC.md`](./PRODUCT_SPEC.md) |
| Inventaris fitur (vs Paperclip) | [`docs/FEATURES.md`](./docs/FEATURES.md) |
| Rencana aktif / peta jalan / keputusan | [`docs/plan/PLAN.md`](./docs/plan/PLAN.md) · [`docs/plan/ROADMAP.md`](./docs/plan/ROADMAP.md) · [`docs/plan/DECISIONS.md`](./docs/plan/DECISIONS.md) |
| Solusi yang dapat digunakan kembali / aturan pencegahan | [`docs/solutions/INDEX.md`](./docs/solutions/INDEX.md) |

---

## Lisensi & atribusi

Workcell dirilis di bawah [Lisensi MIT](./LICENSE) (© 2026 Workcell).

Sebagian dari Workcell berasal dari **Paperclip** (`paperclipai`), © 2025 Paperclip AI, juga berlisensi MIT. Sebagaimana disyaratkan oleh Lisensi MIT, pemberitahuan hak cipta asli dan izin Paperclip direproduksi dalam [`NOTICE`](./NOTICE) dan harus dipertahankan dalam redistribusi.
