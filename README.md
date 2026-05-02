# manga-auto-pipeline

<!-- Badges: add CI / version / license badges here -->


---

## 📌 Overview

manga-auto-pipeline is a lightweight Node.js toolchain to organize local manga/comic collections, generate metadata and cover files per series, and synchronize that metadata with a Komga library. It integrates AniList as a primary metadata source (titles, synopsis, genres, cover) and provides CLI/UI helpers to enqueue downloads, generate series metadata files, and trigger Komga scans and metadata refreshes.

This project is intended for users who maintain local collections and want consistent metadata for a Komga server.

---

## 🎯 Project Goal

Provide a safe, offline-capable pipeline to:
- generate Mylar-compatible `series.json` and `ComicInfo.xml` files,
- ensure series covers are discoverable locally or via AniList,
- push complete metadata to Komga using its API, and
- help automate enqueueing and simple renaming utilities.

Suitable for personal library management, testing, and integration with Komga.

---

## ✨ Features

- Generate `series.json` and `ComicInfo.xml` per series from AniList and local fallbacks
- Ensure a cover image exists for each series (AniList fallback)
- Patch full metadata into Komga (summary, language, genres, titles, total count)
- Safe metadata-only organization (does not rename/move chapter files unless explicitly enabled)
- Enqueue pipeline with configurable `capsAhead` and inclusion of current chapter
- CLI menus for pipeline operations and Komga control

---

## 🏗 Architecture

The project uses a small modular layout in `src/`:

```
src/
 ├── anilist.js          # AniList GraphQL integration
 ├── bridge.js          # Komga / Suwayomi HTTP helpers
 ├── cli-logic.js       # Main pipeline, metadata generation and sync
 ├── ui/                # Terminal UI menus
 └── scripts/           # Utilities (renamer, tests)
```

---

## 🛠 Tech Stack

### Runtime
- Node.js (CommonJS)

### Integrations
- AniList GraphQL (metadata)
- Komga REST API (library scan, metadata patch)
- Suwayomi (optional downloader integration)

---

## 📦 Installation

Quick start (Windows, macOS, Linux):

```bash
git clone <repository-url>
cd manga-auto-pipeline
npm install
# run the CLI UI
node src/cli.js
```

Configuration is stored in `data/config.json` — set your `downloadsPath`, `komgaUrl` and any Komga credentials there.

---

## ▶️ Basic Usage

- Use `node src/cli.js` to open the interactive menus.
- `Organize library (Komga)` will generate metadata files and can trigger a deep Komga scan + metadata push.
- `Start Suwayomi and downloads` will enqueue items (uses AniList progress) and optionally run post-download sync.

---

## 🧪 Future Improvements

- Add optional automatic translation for non-English sinopses (opt-in)
- More granular UI for selecting which series to patch
- Add unit tests for key transformation functions

---

## 👨‍💻 Author

Ywt00 — maintainer

---

## 📄 License

MIT License

---