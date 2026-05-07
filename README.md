# Sortly — AI File Organizer

A local desktop app that uses Ollama + a local LLM to classify and sort your messy Documents folder.
Built with Tauri 2 + React (frontend) and Python (AI backend).

---

## Prerequisites

Install these before anything else:

1. **Rust** — https://rustup.rs (run the installer, restart terminal)
2. **Node.js 18+** — https://nodejs.org
3. **Python 3.10+** — https://python.org (check "Add to PATH" during install)
4. **Ollama** — https://ollama.com/download
5. **Visual Studio C++ Build Tools** — required by Tauri on Windows
   - Download from: https://visualstudio.microsoft.com/visual-cpp-build-tools/
   - Install "Desktop development with C++"

---

## Setup

### 1. Pull the LLM model
```bash
ollama pull llama3.2
```

### 2. Install Python dependencies
```bash
cd python
pip install -r requirements.txt
```

### 3. Install Node dependencies
```bash
npm install
```

---

## Run in development

```bash
npm run tauri dev
```

This starts the Vite dev server + Tauri window. Hot-reloads on React changes.

---

## Build for production (creates a .exe installer)

```bash
npm run tauri build
```

Output will be in `src-tauri/target/release/bundle/`.

---

## How it works

```
[React UI] ──invoke──▶ [Tauri/Rust] ──stdin──▶ [Python sorter.py]
                              ◀──events────────────────── [stdout JSON]
```

1. You pick a folder in the UI
2. Rust spawns `python/sorter.py` as a child process
3. Python scans every file and sends its name/extension/content snippet to Ollama
4. Ollama classifies it (`Work`, `Finance`, `Photos`, etc.) with a confidence score
5. Each result streams back to the UI as a JSON event
6. You approve or skip each suggestion
7. Click "Apply moves" — Python moves the files and writes an undo log to `~/.sortly_undo.json`
8. Click "Undo last sort" in the titlebar to reverse the last batch

---

## Project structure

```
sortly/
├── src-tauri/          # Rust/Tauri backend
│   ├── src/main.rs     # Spawns Python, bridges Tauri commands ↔ Python events
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                # React frontend
│   ├── App.tsx         # Main UI component
│   ├── main.tsx
│   └── index.css
├── python/
│   ├── sorter.py       # Ollama classifier + file mover + undo log
│   └── requirements.txt
├── package.json
└── index.html
```

---

## Customizing categories

Edit the `CATEGORIES` dict in `python/sorter.py` to add or rename categories.
The LLM prompt also lists them — update it if you change the category names.
