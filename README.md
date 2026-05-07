# Sortly — File Organizer for Windows

Sortly is a simple Windows desktop app that helps organize messy folders by sorting files into clean category folders such as **Images**, **PDFs**, **Documents**, **Spreadsheets**, **Videos**, **Archives**, and more.

It is built with **Tauri 2**, **React**, **TypeScript**, and **Python**.

Sortly is designed to be safe, simple, and transparent: before anything is moved, you can review every item, change its destination category, preview the exact move plan, and undo or restore previous sort sessions.



* * * * *

Safety Features
---------------

Sortly is designed to avoid destructive file operations.

### Move Preview

Before moving anything, Sortly shows the exact move plan:

```
From: C:\Users\You\Downloads\resume.pdf To:   C:\Users\You\Downloads\PDFs\resume.pdf
```

### Conflict-Safe Moving

If a file with the same name already exists, Sortly does not overwrite it.

Instead, it automatically renames the moved file:

```
resume.pdfresume (1).pdfresume (2).pdf
```

### Undo Last Sort

After sorting, you can immediately undo the most recent sort session.

### Sort History

Sortly keeps a history of previous sort sessions, including:

-   Timestamp
-   Original folder
-   Number of moved items
-   Restore button for each session

### Restore Previous Sessions

You can restore a specific past sort session from the History page.

* * * * *

App Pages
---------

### Organize

The main sorting page.

You can:

-   Pick a folder
-   Scan files and folders
-   Approve or skip items
-   Change the suggested category
-   Preview moves
-   Apply moves
-   Open the sorted folder in File Explorer

### Settings

Sortly includes simple settings:

| Setting | Options |
| --- | --- |
| Default action | Ask before moving / Auto-approve all |
| Sorting mode | Files only / Files and folders |
| Unknown files | Move to Other / Move to `_unsorted` |

Settings are saved locally using `localStorage`.

### History

The History page shows previous sort sessions and lets you restore them.

* * * * *

Tech Stack
----------

| Layer | Technology |
| --- | --- |
| Desktop shell | Tauri 2 |
| Frontend | React 18 + TypeScript + Vite |
| Backend helper | Python |
| Styling | Plain CSS |
| Platform | Windows |

* * * * *

Project Structure
-----------------

```
sortly/├── src-tauri/│   ├── src/│   │   ├── main.rs│   │   └── lib.rs│   ├── capabilities/│   │   └── default.json│   ├── icons/│   ├── Cargo.toml│   ├── build.rs│   └── tauri.conf.json├── src/│   ├── App.tsx│   ├── main.tsx│   └── index.css├── python/│   ├── sorter.py│   └── requirements.txt├── package.json├── tsconfig.json├── vite.config.ts└── index.html
```

* * * * *

How It Works
------------

Sortly uses a Tauri desktop shell with a React frontend.

The React UI sends commands to Rust through Tauri commands. Rust starts and communicates with the Python sorter process using newline-delimited JSON.

```
React UI  ↓ invoke(...)Tauri / Rust  ↓ stdin JSONPython sorter  ↓ stdout JSON eventsTauri / Rust  ↓ emit(...)React UI
```

Python handles:

-   Scanning the selected folder
-   Categorizing files by extension
-   Previewing move plans
-   Moving files and folders
-   Handling duplicate filenames safely
-   Writing undo/history logs
-   Restoring previous sort sessions

* * * * *

Requirements
------------

Before running the app in development mode, install:

-   Node.js 18+
-   Rust
-   Python 3.10+
-   Microsoft C++ Build Tools
-   Microsoft Edge WebView2 Runtime

* * * * *

Development Setup
-----------------

Install dependencies:

```
npm installpip install -r python/requirements.txt
```

Run the app in development mode:

```
npm run tauri dev
```

* * * * *

Build for Windows
-----------------

To build the Windows installer:

```
npm run tauri build
```

The generated installer will be inside:

```
src-tauri/target/release/bundle/
```

Depending on the configured bundle format, it may be under:

```
src-tauri/target/release/bundle/nsis/
```

or:

```
src-tauri/target/release/bundle/msi/
```

* * * * *

Development vs Installed App
----------------------------

During development, use:

```
npm run tauri dev
```

For normal use, build and install the app:

```
npm run tauri build
```

After installation, Sortly can be opened like a regular Windows desktop app.

* * * * *

Notes
-----

Sortly does not upload files anywhere.

All file scanning, sorting, moving, undo, and restore operations happen locally on your computer.

* * * * *

Current Status
--------------

Sortly is a working Windows desktop MVP with:

-   File-type sorting
-   Settings
-   Category override
-   Move preview
-   Conflict-safe moves
-   Undo
-   Sort history
-   Restore
-   Open in File Explorer

* * * * *

License
-------

This project is currently for personal and educational use.
