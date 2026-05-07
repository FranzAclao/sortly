"""
Sortly - File Sorter Backend
Communicates with the Tauri frontend via JSON over stdout/stdin.
"""

import sys
import json
import os
import shutil
import datetime
from pathlib import Path

UNDO_LOG = Path.home() / ".sortly_undo.json"

CATEGORIES = [
    "Images",
    "PDFs",
    "Documents",
    "Spreadsheets",
    "Presentations",
    "Videos",
    "Audio",
    "Archives",
    "Code",
    "Folders",
    "Other",
    "_unsorted",
]

SORTLY_OUTPUT_FOLDERS = set(CATEGORIES + ["_unsorted"])

EXTENSION_CATEGORY_MAP = {
    # Images
    "jpg": "Images",
    "jpeg": "Images",
    "png": "Images",
    "gif": "Images",
    "webp": "Images",
    "bmp": "Images",
    "tiff": "Images",
    "heic": "Images",
    "svg": "Images",

    # PDFs
    "pdf": "PDFs",

    # Documents
    "doc": "Documents",
    "docx": "Documents",
    "txt": "Documents",
    "rtf": "Documents",
    "md": "Documents",
    "odt": "Documents",

    # Spreadsheets
    "xls": "Spreadsheets",
    "xlsx": "Spreadsheets",
    "csv": "Spreadsheets",
    "ods": "Spreadsheets",

    # Presentations
    "ppt": "Presentations",
    "pptx": "Presentations",
    "odp": "Presentations",

    # Videos
    "mp4": "Videos",
    "mov": "Videos",
    "avi": "Videos",
    "mkv": "Videos",
    "webm": "Videos",
    "wmv": "Videos",

    # Audio
    "mp3": "Audio",
    "wav": "Audio",
    "aac": "Audio",
    "flac": "Audio",
    "m4a": "Audio",
    "ogg": "Audio",

    # Archives
    "zip": "Archives",
    "rar": "Archives",
    "7z": "Archives",
    "tar": "Archives",
    "gz": "Archives",

    # Code
    "py": "Code",
    "js": "Code",
    "jsx": "Code",
    "ts": "Code",
    "tsx": "Code",
    "html": "Code",
    "css": "Code",
    "json": "Code",
    "xml": "Code",
    "rs": "Code",
    "java": "Code",
    "cpp": "Code",
    "c": "Code",
    "cs": "Code",
    "php": "Code",
    "go": "Code",
    "rb": "Code",
    "sql": "Code",
    "sh": "Code",
    "bat": "Code",
    "ps1": "Code",
}

def emit(event: str, data: dict):
    """Send a JSON event to the Tauri frontend via stdout."""
    payload = json.dumps({"event": event, "data": data})
    print(payload, flush=True)

def get_unique_destination(path: Path) -> Path:
    if not path.exists():
        return path

    parent = path.parent
    stem = path.stem
    suffix = path.suffix
    counter = 1

    while True:
        candidate = parent / f"{stem} ({counter}){suffix}"
        if not candidate.exists():
            return candidate
        counter += 1

def read_undo_log():
    if not UNDO_LOG.exists():
        return []
    try:
        log = json.loads(UNDO_LOG.read_text())
        return log if isinstance(log, list) else []
    except Exception:
        return []

def write_undo_log(log):
    UNDO_LOG.write_text(json.dumps(log, indent=2))

def infer_history_folder(entry):
    if entry.get("folder"):
        return entry["folder"]

    moves = entry.get("moves", [])
    parents = []
    for move in moves:
        original = move.get("to")
        if original:
            parents.append(str(Path(original).parent))

    if not parents:
        return ""

    try:
        return os.path.commonpath(parents)
    except Exception:
        return parents[0]

def summarize_history_entry(index, entry):
    moves = entry.get("moves", [])
    return {
        "id": index,
        "timestamp": entry.get("timestamp", ""),
        "folder": infer_history_folder(entry),
        "moved": entry.get("moved", len(moves)),
    }

def emit_history():
    log = read_undo_log()
    entries = [
        summarize_history_entry(index, entry)
        for index, entry in enumerate(log)
        if entry.get("moves")
    ]
    entries.reverse()
    emit("history_loaded", {"entries": entries})

def is_sortable_item(root_folder: Path, name: str, include_folders: bool) -> bool:
    path = root_folder / name

    # Skip Sortly-created category folders.
    if path.is_dir() and name in SORTLY_OUTPUT_FOLDERS:
        return False

    # Skip hidden/system-ish files.
    if name.startswith("."):
        return False

    return path.is_file() or (include_folders and path.is_dir())

def classify_by_file_type(path, item_type, unknown_target="Other"):
    if item_type == "folder":
        return {
            "category": "Folders",
            "confidence": 100,
        }

    ext = os.path.splitext(path)[1].lstrip(".").lower()
    category = EXTENSION_CATEGORY_MAP.get(ext, unknown_target)

    return {
        "category": category,
        "confidence": 100 if category not in {"Other", "_unsorted"} else 60,
    }

def scan_folder(folder: str, include_folders: bool = True, unknown_target: str = "Other"):
    """Scan a folder and classify all top-level files and folders."""
    root = Path(folder)
    if not root.exists() or not root.is_dir():
        emit("error", {"message": f"Folder not found: {folder}"})
        return

    if unknown_target not in {"Other", "_unsorted"}:
        unknown_target = "Other"

    items = []
    for name in os.listdir(root):
        path = root / name
        if not is_sortable_item(root, name, include_folders):
            continue
        items.append(path)

    total = len(items)
    emit("scan_start", {"total": total, "folder": str(root)})

    results = []
    for i, item_path in enumerate(items):
        try:
            if item_path.is_dir():
                ext = "folder"
                item_type = "folder"
            else:
                ext = item_path.suffix.lstrip(".").lower()
                item_type = "file"

            classification = classify_by_file_type(str(item_path), item_type, unknown_target)
            category = classification["category"]
            confidence = classification["confidence"]
            result = {
                "id": i,
                "name": item_path.name,
                "path": str(item_path),
                "category": category,
                "confidence": confidence,
                "size": format_size(get_size(item_path)),
                "ext": ext,
                "type": item_type,
            }
            results.append(result)
            emit("file_classified", {
                "file": result,
                "progress": round((i + 1) / total * 100),
            })
        except Exception as e:
            emit("file_error", {"name": item_path.name, "error": str(e)})

    emit("scan_complete", {"files": results})

def apply_moves(folder: str, approved_ids: list[int], files: list[dict]):
    """Move approved files into category subfolders."""
    root = Path(folder)
    undo_entries = []
    moved = 0
    errors = []

    approved_set = set(approved_ids)
    approved_files = [f for f in files if f["id"] in approved_set]

    for file_info in approved_files:
        src = Path(file_info["path"])
        cat = file_info["category"]
        dest_dir = root / cat
        dest_dir.mkdir(exist_ok=True)
        dest = get_unique_destination(dest_dir / src.name)

        try:
            source_abs = os.path.abspath(src)
            dest_abs = os.path.abspath(dest)

            if os.path.isdir(source_abs):
                common = os.path.commonpath([source_abs, dest_abs])
                if common == source_abs:
                    errors.append({
                        "name": file_info["name"],
                        "error": "Cannot move a folder into itself or one of its own subfolders."
                    })
                    continue

            shutil.move(str(src), str(dest))
            undo_entries.append({"from": str(dest), "to": str(src)})
            moved += 1
            emit("file_moved", {"name": src.name, "destination": str(dest)})
        except Exception as e:
            errors.append({"name": src.name, "error": str(e)})
            emit("move_error", {"name": src.name, "error": str(e)})

    try:
        log = read_undo_log()
        log.append({
            "timestamp": datetime.datetime.now().isoformat(),
            "folder": str(root),
            "moved": moved,
            "moves": undo_entries,
        })
        write_undo_log(log)
    except Exception as e:
        errors.append({
            "name": "Undo log",
            "error": f"Moves completed, but undo history could not be saved: {e}",
        })

    emit("moves_complete", {"moved": moved, "errors": errors})

def undo_last():
    """Reverse the last batch of moves."""
    if not UNDO_LOG.exists():
        emit("error", {"message": "No undo history found."})
        return
    try:
        log = read_undo_log()
        if not log:
            emit("error", {"message": "Undo log is empty."})
            return
        last_index = len(log) - 1
        restored = restore_history_entry(log, last_index)
        write_undo_log(log)
        emit("undo_complete", {"restored": restored})
        emit_history()
    except Exception as e:
        emit("error", {"message": f"Undo failed: {e}"})

def restore_history_entry(log, index):
    entry = log.pop(index)
    restored = 0

    for move in entry.get("moves", []):
        src = Path(move["from"])
        dst = Path(move["to"])
        if src.exists():
            restored_path = get_unique_destination(dst)
            restored_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(restored_path))
            restored += 1

    return restored

def restore_history(index: int):
    try:
        log = read_undo_log()
        if index < 0 or index >= len(log):
            emit("error", {"message": "Sort history entry not found."})
            return

        restored = restore_history_entry(log, index)
        write_undo_log(log)
        emit("history_restored", {"restored": restored})
        emit_history()
    except Exception as e:
        emit("error", {"message": f"Restore failed: {e}"})

def get_size(path: Path):
    if path.is_dir():
        return "Folder"
    return path.stat().st_size

def format_size(size: int) -> str:
    if isinstance(size, str):
        return size

    for unit in ["B", "KB", "MB", "GB"]:
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"

def main():
    """Read JSON commands from stdin, dispatch to handlers."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
            action = cmd.get("action")
            if action == "scan":
                scan_folder(
                    cmd["folder"],
                    bool(cmd.get("include_folders", True)),
                    cmd.get("unknown_target", "Other"),
                )
            elif action == "apply":
                apply_moves(cmd["folder"], cmd["approved_ids"], cmd["files"])
            elif action == "undo":
                undo_last()
            elif action == "history":
                emit_history()
            elif action == "restore_history":
                restore_history(int(cmd["index"]))
            else:
                emit("error", {"message": f"Unknown action: {action}"})
        except json.JSONDecodeError as e:
            emit("error", {"message": f"Invalid JSON command: {e}"})
        except Exception as e:
            emit("error", {"message": str(e)})

if __name__ == "__main__":
    main()
