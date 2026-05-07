import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import "./index.css";

// ── Types ────────────────────────────────────────────────────────────────────

type Category =
  | "Images"
  | "PDFs"
  | "Documents"
  | "Spreadsheets"
  | "Presentations"
  | "Videos"
  | "Audio"
  | "Archives"
  | "Code"
  | "Folders"
  | "Other"
  | "_unsorted";

interface FileResult {
  id: number;
  name: string;
  path: string;
  category: Category;
  confidence: number;
  size: string;
  ext: string;
  type?: "file" | "folder";
}

type Status = "idle" | "scanning" | "review" | "applying" | "done";
type Decision = "approved" | "rejected" | null;
type CategoryFilter = "All" | Category;
type MoveError = { name: string; error: string };
type View = "organize" | "history" | "settings";
type DefaultAction = "ask" | "auto";
type SortingMode = "files" | "filesAndFolders";
type UnknownFilesMode = "other" | "unsorted";
type SortHistoryEntry = {
  id: number;
  timestamp: string;
  folder: string;
  moved: number;
};
type MovePreview = {
  id: number;
  name: string;
  category: Category;
  from: string;
  to: string;
  type?: "file" | "folder";
};

interface SortlySettings {
  defaultAction: DefaultAction;
  sortingMode: SortingMode;
  unknownFiles: UnknownFilesMode;
}

function dedupeFiles(files: FileResult[]) {
  const seen = new Map<string, FileResult>();

  for (const file of files) {
    const key = file.path || `${file.id}-${file.name}`;
    seen.set(key, file);
  }

  return Array.from(seen.values());
}

const DEFAULT_SETTINGS: SortlySettings = {
  defaultAction: "ask",
  sortingMode: "filesAndFolders",
  unknownFiles: "other",
};

function loadSettings(): SortlySettings {
  try {
    const saved = window.localStorage.getItem("sortly-settings");
    if (!saved) return DEFAULT_SETTINGS;

    return {
      ...DEFAULT_SETTINGS,
      ...JSON.parse(saved),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// ── Constants ────────────────────────────────────────────────────────────────

const CATEGORIES = [
  "All",
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
] as const;

const CAT_COLORS: Record<Category, { bg: string; text: string }> = {
  Images: { bg: "#EAF3FF", text: "#0B4A7A" },
  PDFs: { bg: "#FCEBEB", text: "#7A1E1E" },
  Documents: { bg: "#EEF2FF", text: "#3730A3" },
  Spreadsheets: { bg: "#EAF7E8", text: "#1F5C2E" },
  Presentations: { bg: "#FFF1E6", text: "#8A3A00" },
  Videos: { bg: "#FBEAF0", text: "#72243E" },
  Audio: { bg: "#EEEDFE", text: "#3C3489" },
  Archives: { bg: "#E1F5EE", text: "#085041" },
  Code: { bg: "#F1EFE8", text: "#444441" },
  Folders: { bg: "#FFF7D6", text: "#6B4E00" },
  Other: { bg: "#F1EFE8", text: "#5F5E5A" },
  _unsorted: { bg: "#F8FAFC", text: "#475569" },
};

const CAT_ICONS: Record<Category, string> = {
  Images: "🖼️",
  PDFs: "📕",
  Documents: "📄",
  Spreadsheets: "📊",
  Presentations: "📽️",
  Videos: "🎬",
  Audio: "🎵",
  Archives: "📦",
  Code: "💻",
  Folders: "📁",
  Other: "📄",
  _unsorted: "📥",
};

const PREVIEW_DISPLAY_LIMIT = 100;

// ── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [view, setView] = useState<View>("organize");
  const [settings, setSettings] = useState<SortlySettings>(() => loadSettings());
  const [folder, setFolder] = useState<string>("");
  const [status, setStatus] = useState<Status>("idle");
  const [files, setFiles] = useState<FileResult[]>([]);
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [progress, setProgress] = useState(0);
  const [scanTotal, setScanTotal] = useState(0);
  const [activeFilter, setActiveFilter] = useState<CategoryFilter>("All");
  const [movedCount, setMovedCount] = useState(0);
  const [moveErrors, setMoveErrors] = useState<MoveError[]>([]);
  const [movePreviews, setMovePreviews] = useState<MovePreview[]>([]);
  const [showMovePreview, setShowMovePreview] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<SortHistoryEntry[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const expectedMoveCount = useRef(0);
  const settingsRef = useRef(settings);

  useEffect(() => {
    settingsRef.current = settings;
    window.localStorage.setItem("sortly-settings", JSON.stringify(settings));
  }, [settings]);

  // Listen to Python events
  useEffect(() => {
    let disposed = false;
    const unlistenFns: Array<() => void> = [];

    const track = (unlisten: () => void) => {
      if (disposed) {
        unlisten();
      } else {
        unlistenFns.push(unlisten);
      }
    };

    async function setupListeners() {
      track(await listen("scan_start", (event) => {
        const payload = event.payload as {
          total: number;
          folder: string;
        };

        expectedMoveCount.current = 0;
        setScanTotal(payload.total);
        setFiles([]);
        setDecisions({});
        setMovedCount(0);
        setMoveErrors([]);
        setProgress(0);
        setStatus("scanning");
      }));

      track(await listen("file_classified", (event) => {
        const payload = event.payload as {
          file: FileResult;
          progress: number;
        };

        setFiles((prev) => {
          const next = [...prev.filter((f) => f.path !== payload.file.path), payload.file];
          return dedupeFiles(next);
        });
        setProgress(payload.progress);
      }));

      track(await listen("scan_complete", (event) => {
        const payload = event.payload as {
          files: FileResult[];
        };
        const nextFiles = dedupeFiles(payload.files);

        setFiles(nextFiles);
        if (settingsRef.current.defaultAction === "auto") {
          const nextDecisions: Record<number, Decision> = {};
          for (const file of nextFiles) {
            nextDecisions[file.id] = "approved";
          }
          setDecisions(nextDecisions);
        }
        setStatus("review");
        setProgress(100);
      }));

      track(await listen("file_moved", () => {
        setMovedCount((prev) => {
          const next = prev + 1;
          return expectedMoveCount.current > 0
            ? Math.min(next, expectedMoveCount.current)
            : next;
        });
      }));

      track(await listen("moves_complete", (event) => {
        const payload = event.payload as {
          moved: number;
          errors?: MoveError[];
        };

        setMovedCount(payload.moved);
        setMoveErrors(payload.errors ?? []);
        setMovePreviews([]);
        setShowMovePreview(false);
        setPreviewLoading(false);
        setStatus("done");
        showToast(`${payload.moved} items moved successfully`);
        void loadSortHistory();
      }));

      track(await listen("undo_complete", (event) => {
        const payload = event.payload as {
          restored: number;
        };

        expectedMoveCount.current = 0;
        showToast(`↩️ ${payload.restored} items restored`);
        setStatus("idle");
        setFiles([]);
        setDecisions({});
        setMovedCount(0);
        setMoveErrors([]);
        setProgress(0);
        void loadSortHistory();
      }));

      track(await listen("history_loaded", (event) => {
        const payload = event.payload as {
          entries: SortHistoryEntry[];
        };

        setHistoryEntries(payload.entries);
      }));

      track(await listen("move_preview", (event) => {
        const payload = event.payload as {
          previews: MovePreview[];
        };

        setMovePreviews(payload.previews);
        setPreviewLoading(false);
        setShowMovePreview(payload.previews.length > 0);
        if (payload.previews.length === 0) {
          showToast("No approved items to move");
        }
      }));

      track(await listen("history_restored", (event) => {
        const payload = event.payload as {
          restored: number;
        };

        showToast(`${payload.restored} items restored`);
      }));

      track(await listen("error", (event) => {
        const payload = event.payload as {
          message: string;
        };

        showToast(`⚠️ ${payload.message}`);
      }));
    }

    setupListeners();

    return () => {
      disposed = true;
      unlistenFns.forEach((unlisten) => unlisten());
    };
  }, []);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  };

  const pickFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected) setFolder(selected as string);
  };

  const loadSortHistory = async () => {
    try {
      await invoke("get_sort_history");
    } catch (e: any) {
      showToast(`Error: ${e}`);
    }
  };

  const openHistory = () => {
    setView("history");
    void loadSortHistory();
  };

  const openSortedFolder = async () => {
    if (!folder) {
      showToast("No folder selected.");
      return;
    }

    try {
      await invoke("open_in_explorer", { folder });
    } catch (error) {
      console.error(error);
      showToast(String(error));
    }
  };

  const startScan = async () => {
    if (!folder) return;
    setView("organize");
    setStatus("scanning");
    setActiveFilter("All");
    try {
      await invoke("scan_folder", {
        folder,
        includeFolders: settings.sortingMode === "filesAndFolders",
        unknownTarget: settings.unknownFiles === "unsorted" ? "_unsorted" : "Other",
      });
    } catch (e: any) {
      showToast(`Error: ${e}`);
      setStatus("idle");
    }
  };

  const acceptAll = () => {
    setDecisions(() => {
      const next: Record<number, Decision> = {};

      for (const file of files) {
        next[file.id] = "approved";
      }

      return next;
    });
  };

  const skipAll = () => {
    setDecisions(() => {
      const next: Record<number, Decision> = {};

      for (const file of files) {
        next[file.id] = "rejected";
      }

      return next;
    });
  };

  const updateFileCategory = (id: number, category: Category) => {
    setFiles((prev) =>
      prev.map((file) =>
        file.id === id
          ? { ...file, category }
          : file
      )
    );
  };

  const getApprovedIds = () =>
    files
      .filter((f) => decisions[f.id] === "approved")
      .map((f) => f.id);

  const previewMoves = async () => {
    const approvedIds = getApprovedIds();

    if (!folder || approvedIds.length === 0) {
      showToast("No approved items to move.");
      return;
    }

    setShowMovePreview(true);
    setPreviewLoading(true);
    setMovePreviews([]);

    try {
      await invoke("preview_moves", { folder, approvedIds, files });
    } catch (e: any) {
      setPreviewLoading(false);
      setShowMovePreview(false);
      showToast(`Error: ${e}`);
    }
  };

  const applyMoves = async () => {
    const approvedIds = getApprovedIds();

    if (!folder || approvedIds.length === 0) return;

    expectedMoveCount.current = approvedIds.length;
    setStatus("applying");
    setMovedCount(0);
    setMoveErrors([]);
    setPreviewLoading(false);
    setShowMovePreview(false);

    try {
      await invoke("apply_moves", { folder, approvedIds, files });
    } catch (e: any) {
      expectedMoveCount.current = 0;
      showToast(`Error: ${e}`);
      setStatus("review");
    }
  };

  const undoLast = async () => {
    try {
      await invoke("undo_last");
    } catch (e: any) {
      showToast(`Error: ${e}`);
    }
  };

  const restoreHistoryEntry = async (entry: SortHistoryEntry) => {
    try {
      await invoke("restore_sort_history", { index: entry.id });
    } catch (e: any) {
      showToast(`Error: ${e}`);
    }
  };

  const resetForNewFolder = () => {
    setView("organize");
    setFolder("");
    setFiles([]);
    setDecisions({});
    setProgress(0);
    setScanTotal(0);
    setMovedCount(0);
    setMoveErrors([]);
    setMovePreviews([]);
    setShowMovePreview(false);
    setPreviewLoading(false);
    expectedMoveCount.current = 0;
    setActiveFilter("All");
    setStatus("idle");
  };

  // Derived state
  const filteredFiles = useCallback(() => {
    return activeFilter === "All" ? files : files.filter((f) => f.category === activeFilter);
  }, [files, activeFilter]);

  const approvedCount = files.filter((f) => decisions[f.id] === "approved").length;
  const rejectedCount = files.filter((f) => decisions[f.id] === "rejected").length;
  const pendingCount = files.length - approvedCount - rejectedCount;
  const visibleFiles = filteredFiles();
  const displayFiles = status === "done"
    ? visibleFiles.filter((file) => decisions[file.id] === "approved")
    : visibleFiles;

  return (
    <div style={{ display: "grid", gridTemplateRows: "auto 1fr", height: "100vh" }}>

      {/* Titlebar */}
      <div style={{
        background: "var(--surface)", borderBottom: "1px solid var(--border)",
        padding: "10px 20px", display: "flex", alignItems: "center", gap: 12,
        }}>
        <span style={{ fontSize: 16, fontWeight: 600 }}>🗂 Sortly</span>
        <span style={{ flex: 1 }} />
        <button
          onClick={() => setView("organize")}
          className={view === "organize" ? "top-nav-active" : ""}
        >
          Organize
        </button>
        <button
          onClick={openHistory}
          className={view === "history" ? "top-nav-active" : ""}
        >
          History
        </button>
        <button
          onClick={() => setView("settings")}
          className={view === "settings" ? "top-nav-active" : ""}
        >
          Settings
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", overflow: "hidden" }}>

        {/* Sidebar */}
        <div style={{
          background: "var(--surface)", borderRight: "1px solid var(--border)",
          display: "flex", flexDirection: "column", padding: "16px 0", overflowY: "auto",
        }}>
          {/* Folder picker */}
          <div style={{ padding: "0 12px 16px" }}>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-3)", padding: "0 8px", marginBottom: 8 }}>
              Pick folder
            </div>
            <div
              onClick={pickFolder}
              style={{
                fontSize: 11, color: "var(--text-2)", padding: "7px 10px",
                background: "var(--surface2)", borderRadius: "var(--radius)",
                border: "1px solid var(--border)", cursor: "pointer",
                fontFamily: "monospace", wordBreak: "break-all", marginBottom: 8,
                minHeight: 32,
              }}
            >
              {folder || "Click to pick folder…"}
            </div>
            <button
              className="primary"
              style={{ width: "100%", justifyContent: "center" }}
              onClick={startScan}
              disabled={!folder || status === "scanning" || status === "applying"}
            >
              {status === "scanning" ? "Scanning…" : "↺  Scan items"}
            </button>
          </div>

          {/* Category filters */}
          {files.length > 0 && (
            <div style={{ padding: "0 12px 16px" }}>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-3)", padding: "0 8px", marginBottom: 6 }}>
                Categories
              </div>
              {CATEGORIES.map((cat) => {
                const count = cat === "All" ? files.length : files.filter((f) => f.category === cat).length;
                const active = activeFilter === cat;
                return (
                  <button
                    key={cat}
                    onClick={() => setActiveFilter(cat)}
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      width: "100%", padding: "7px 8px", border: "none",
                      background: active ? "var(--accent-bg)" : "transparent",
                      color: active ? "var(--accent)" : "var(--text)",
                      borderRadius: "var(--radius)", marginBottom: 2,
                      fontWeight: active ? 500 : 400, justifyContent: "flex-start",
                    }}
                  >
                    <span>{cat === "All" ? "🗂" : CAT_ICONS[cat]}</span>
                    <span style={{ flex: 1, textAlign: "left" }}>{cat === "All" ? "All items" : cat}</span>
                    <span style={{
                      fontSize: 11, padding: "1px 7px", borderRadius: 20,
                      background: active ? "#bfcffd" : "var(--surface2)",
                      color: active ? "var(--accent)" : "var(--text-3)",
                    }}>{count}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Stats */}
          {files.length > 0 && (
            <div style={{ margin: "0 12px 16px", background: "var(--surface2)", borderRadius: "var(--radius-lg)", padding: 12, border: "1px solid var(--border)" }}>
              <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-3)", marginBottom: 10 }}>
                This session
              </div>
              {[
                ["Scanned", files.length, "var(--text)"],
                ["Approved", approvedCount, "var(--green)"],
                ["Skipped", rejectedCount, "var(--amber)"],
                ["Pending", pendingCount, "var(--text)"],
              ].map(([label, val, col]) => (
                <div key={label as string} style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                  <span style={{ fontSize: 12, color: "var(--text-2)" }}>{label}</span>
                  <span style={{ fontSize: 12, fontWeight: 500, fontFamily: "monospace", color: col as string }}>{val}</span>
                </div>
              ))}
              <div style={{ height: 4, background: "var(--border)", borderRadius: 2, marginTop: 10, overflow: "hidden" }}>
                <div style={{
                  height: "100%", borderRadius: 2, background: "var(--accent)",
                  width: `${files.length ? Math.round((approvedCount + rejectedCount) / files.length * 100) : 0}%`,
                  transition: "width 0.4s ease",
                }} />
              </div>
            </div>
          )}
        </div>

        {/* Main panel */}
        <div style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {/* Toolbar */}
          <div style={{
            background: "var(--surface)", borderBottom: "1px solid var(--border)",
            padding: "10px 20px", display: "flex", alignItems: "center", gap: 10, flexShrink: 0,
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>
                {view === "settings" && "Settings"}
                {view === "history" && "Sort History"}
                {view === "organize" && status === "idle" && "Pick a folder to get started"}
                {view === "organize" && status === "scanning" && `Scanning… ${files.length} of ${scanTotal} items`}
                {view === "organize" && status === "review" && "Review Items"}
                {view === "organize" && status === "applying" && `Moving items… ${movedCount} done`}
                {view === "organize" && status === "done" && "Sorted Successfully"}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-3)" }}>
                {view === "organize" && status === "scanning" && `${progress}% complete`}
              </div>
            </div>
          </div>

          {/* Scanning progress bar */}
          {status === "scanning" && (
            <div style={{ height: 3, background: "var(--border)" }}>
              <div style={{ height: "100%", background: "var(--accent)", width: `${progress}%`, transition: "width 0.3s ease" }} />
            </div>
          )}

          {/* File list */}
          <div style={{ flex: 1, overflowY: "auto", padding: "14px 20px" }}>
            {view === "settings" && (
              <SettingsPage
                settings={settings}
                onChange={setSettings}
              />
            )}

            {view === "history" && (
              <HistoryPage
                entries={historyEntries}
                onRefresh={loadSortHistory}
                onRestore={restoreHistoryEntry}
              />
            )}

            {view === "organize" && status === "idle" && (
              <div style={{ textAlign: "center", marginTop: 80, color: "var(--text-3)" }}>
                <div style={{ fontSize: 48, marginBottom: 16 }}>🗂️</div>
                <div style={{ fontSize: 15, fontWeight: 500, color: "var(--text-2)", marginBottom: 6 }}>Ready to organize</div>
                <div style={{ fontSize: 13 }}>Pick a folder, then scan items</div>
              </div>
            )}

            {view === "organize" && (status === "review" || status === "applying" || status === "done") && (
              <section className="review-panel">
                {status === "done" ? (
                  <div className="done-banner">
                    <div>
                      <h1>Sorted Successfully</h1>
                      <p>
                        {movedCount} items moved into category folders.
                        {moveErrors.length > 0 ? ` ${moveErrors.length} items could not be moved.` : ""}
                      </p>
                    </div>

                    <div className="review-actions">
                      <button onClick={undoLast}>Undo last sort</button>
                      <button onClick={openSortedFolder}>Open in File Explorer</button>
                      <button onClick={resetForNewFolder}>Sort another folder</button>
                    </div>
                  </div>
                ) : (
                  <div className="review-header">
                    <div>
                      {status === "applying" ? (
                        <>
                          <h2>Moving Items</h2>
                          <p>{movedCount} items moved so far. Please wait.</p>
                        </>
                      ) : (
                        <>
                          <h2>Review Items</h2>
                          <p>Sortly found {files.length} items. Approve the items you want to move.</p>
                        </>
                      )}
                    </div>

                    {status === "review" && (
                      <div className="review-actions">
                        <button onClick={acceptAll}>Accept all</button>
                        <button onClick={skipAll}>Skip all</button>
                        <button
                          className="primary"
                          onClick={previewMoves}
                          disabled={approvedCount === 0}
                        >
                          Apply moves
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <div className="list-title">
                  {status === "done" ? "Moved Items" : status === "applying" ? "Moving Items" : "Sorting Suggestions"}
                </div>

                <div className="file-list">
                  {displayFiles.map((file) => (
                    <FileRow
                      key={file.path}
                      file={file}
                      decision={decisions[file.id]}
                      status={status}
                      onCategoryChange={(category) => updateFileCategory(file.id, category)}
                      onApprove={() =>
                        setDecisions((prev) => ({
                          ...prev,
                          [file.id]: "approved",
                        }))
                      }
                      onReject={() =>
                        setDecisions((prev) => ({
                          ...prev,
                          [file.id]: "rejected",
                        }))
                      }
                    />
                  ))}
                </div>
              </section>
            )}

            {view === "organize" && status === "scanning" && files.length > 0 && (
              <div className="file-list">
                {visibleFiles.map((file) => (
                  <FileRow
                    key={file.path}
                    file={file}
                    decision={decisions[file.id]}
                    status={status}
                    onCategoryChange={(category) => updateFileCategory(file.id, category)}
                    onApprove={() =>
                      setDecisions((prev) => ({
                        ...prev,
                        [file.id]: "approved",
                      }))
                    }
                    onReject={() =>
                      setDecisions((prev) => ({
                        ...prev,
                        [file.id]: "rejected",
                      }))
                    }
                  />
                ))}
              </div>
            )}
          </div>

          {/* Bottom bar */}
          {view === "organize" && status === "review" && (
            <div style={{
              background: "var(--surface)", borderTop: "1px solid var(--border)",
              padding: "10px 20px", display: "flex", alignItems: "center", gap: 8, flexShrink: 0,
              fontSize: 13, color: "var(--text-2)",
            }}>
              <span><b style={{ color: "var(--green)" }}>{approvedCount}</b> approved</span>
              <span style={{ color: "var(--text-3)" }}>·</span>
              <span><b style={{ color: "var(--amber)" }}>{rejectedCount}</b> skipped</span>
              <span style={{ color: "var(--text-3)" }}>·</span>
              <span><b>{pendingCount}</b> pending</span>
            </div>
          )}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div style={{
          position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)",
          background: "var(--text)", color: "#fff", padding: "10px 20px",
          borderRadius: "var(--radius-lg)", fontSize: 13, fontWeight: 500,
          boxShadow: "0 4px 12px rgba(0,0,0,0.15)", zIndex: 999,
          animation: "fadeUp 0.2s ease",
        }}>
          {toast}
        </div>
      )}

      {showMovePreview && (
        <MovePreviewDialog
          previews={movePreviews}
          loading={previewLoading}
          onCancel={() => setShowMovePreview(false)}
          onConfirm={applyMoves}
        />
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function FileRow({
  file,
  decision,
  status,
  onCategoryChange,
  onApprove,
  onReject,
}: {
  file: FileResult;
  decision: "approved" | "rejected" | null | undefined;
  status: Status;
  onCategoryChange: (category: Category) => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const colors = CAT_COLORS[file.category];
  const showActions = status === "review";

  return (
    <div
      className={[
        "file-row",
        status === "done" ? "is-moved" : "",
        decision === "approved" && status !== "done" ? "is-approved" : "",
        decision === "rejected" && status !== "done" ? "is-rejected" : "",
      ].join(" ")}
    >
      <div className="file-row-main">
        <div className="file-row-name">{file.name}</div>
        <div className="file-row-path">{file.path}</div>
      </div>

      <div className="file-row-meta">
        <span className="file-type">
          {file.type === "folder" ? "Folder" : file.ext?.toUpperCase() || "FILE"}
        </span>

        {showActions ? (
          <select
            className="category-select"
            value={file.category}
            onChange={(event) => onCategoryChange(event.target.value as Category)}
            style={{ background: colors.bg, color: colors.text }}
            title="Change destination category"
          >
            {CATEGORIES.filter((category) => category !== "All").map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        ) : (
          <span
            className="category-badge"
            style={{ background: colors.bg, color: colors.text }}
          >
            {file.category}
          </span>
        )}

        <span
          className={
            file.confidence >= 85
              ? "confidence good"
              : "confidence low"
          }
        >
          {file.confidence}%
        </span>

        <span className="file-size">{file.size}</span>
      </div>

      {showActions && (
        <div className="file-row-actions">
          <button
            className="icon-btn approve"
            onClick={onApprove}
            title="Approve"
          >
            ✓
          </button>

          <button
            className="icon-btn reject"
            onClick={onReject}
            title="Skip"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

function MovePreviewDialog({
  previews,
  loading,
  onCancel,
  onConfirm,
}: {
  previews: MovePreview[];
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const visiblePreviewItems = previews.slice(0, PREVIEW_DISPLAY_LIMIT);
  const hiddenPreviewCount = Math.max(0, previews.length - PREVIEW_DISPLAY_LIMIT);
  const previewCategoryCounts = previews.reduce<Record<string, number>>(
    (acc, item) => {
      acc[item.category] = (acc[item.category] ?? 0) + 1;
      return acc;
    },
    {}
  );

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="move-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="move-preview-title">
        <div className="move-preview-header">
          <div>
            <h2 id="move-preview-title">Confirm Moves</h2>
            <p>
              {loading
                ? "Preparing move preview..."
                : `${previews.length} items will be moved.`}
            </p>
          </div>
          <button onClick={onCancel}>Cancel</button>
        </div>

        <div className="modal-body">
          {loading ? (
            <div className="modal-loading">
              Preparing move preview...
            </div>
          ) : (
            <>
              <p className="modal-summary">
                {previews.length} items will be moved.
              </p>

              <div className="preview-summary-grid">
                {Object.entries(previewCategoryCounts).map(([category, count]) => (
                  <div className="preview-summary-card" key={category}>
                    <span>{category}</span>
                    <strong>{count}</strong>
                  </div>
                ))}
              </div>

              {hiddenPreviewCount > 0 && (
                <p className="modal-note">
                  Showing the first {PREVIEW_DISPLAY_LIMIT} items. {hiddenPreviewCount} more items will also be moved.
                </p>
              )}

              <div className="move-preview-list">
                {visiblePreviewItems.map((preview) => (
                  <div className="move-preview-row" key={`${preview.from}-${preview.to}`}>
                    <div className="move-preview-name">{preview.name}</div>
                    <div className="move-preview-path">
                      <span>From:</span>
                      <code>{preview.from}</code>
                    </div>
                    <div className="move-preview-path">
                      <span>To:</span>
                      <code>{preview.to}</code>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="move-preview-footer">
          <button onClick={onCancel}>Back to review</button>
          <button
            className="primary"
            disabled={loading || previews.length === 0}
            onClick={onConfirm}
          >
            Move {previews.length} items
          </button>
        </div>
      </section>
    </div>
  );
}

function SettingsPage({
  settings,
  onChange,
}: {
  settings: SortlySettings;
  onChange: React.Dispatch<React.SetStateAction<SortlySettings>>;
}) {
  return (
    <section className="settings-panel">
      <div className="settings-header">
        <h2>Settings</h2>
        <p>Choose how Sortly prepares items before you review and move them.</p>
      </div>

      <SettingGroup
        title="Default action"
        description="Choose whether scanned items wait for review or start approved."
      >
        <label className="setting-option">
          <input
            type="radio"
            name="default-action"
            checked={settings.defaultAction === "ask"}
            onChange={() =>
              onChange((prev) => ({
                ...prev,
                defaultAction: "ask",
              }))
            }
          />
          <span>
            <strong>Ask before moving</strong>
            <small>Review each scan before any move is applied.</small>
          </span>
        </label>

        <label className="setting-option">
          <input
            type="radio"
            name="default-action"
            checked={settings.defaultAction === "auto"}
            onChange={() =>
              onChange((prev) => ({
                ...prev,
                defaultAction: "auto",
              }))
            }
          />
          <span>
            <strong>Auto-approve all after scan</strong>
            <small>All scanned items start approved, but you can still skip individual rows.</small>
          </span>
        </label>
      </SettingGroup>

      <SettingGroup
        title="Sorting mode"
        description="Choose whether folders should be included in scans."
      >
        <label className="setting-option">
          <input
            type="radio"
            name="sorting-mode"
            checked={settings.sortingMode === "files"}
            onChange={() =>
              onChange((prev) => ({
                ...prev,
                sortingMode: "files",
              }))
            }
          />
          <span>
            <strong>Sort files only</strong>
            <small>Folders stay where they are.</small>
          </span>
        </label>

        <label className="setting-option">
          <input
            type="radio"
            name="sorting-mode"
            checked={settings.sortingMode === "filesAndFolders"}
            onChange={() =>
              onChange((prev) => ({
                ...prev,
                sortingMode: "filesAndFolders",
              }))
            }
          />
          <span>
            <strong>Sort files and folders</strong>
            <small>Top-level folders are included and moved into Folders.</small>
          </span>
        </label>
      </SettingGroup>

      <SettingGroup
        title="Unknown files"
        description="Choose the destination for extensions Sortly does not recognize."
      >
        <label className="setting-option">
          <input
            type="radio"
            name="unknown-files"
            checked={settings.unknownFiles === "other"}
            onChange={() =>
              onChange((prev) => ({
                ...prev,
                unknownFiles: "other",
              }))
            }
          />
          <span>
            <strong>Move to Other</strong>
            <small>Unknown files use the normal Other category.</small>
          </span>
        </label>

        <label className="setting-option">
          <input
            type="radio"
            name="unknown-files"
            checked={settings.unknownFiles === "unsorted"}
            onChange={() =>
              onChange((prev) => ({
                ...prev,
                unknownFiles: "unsorted",
              }))
            }
          />
          <span>
            <strong>Move to _unsorted</strong>
            <small>Unknown files go to a separate _unsorted folder.</small>
          </span>
        </label>
      </SettingGroup>
    </section>
  );
}

function HistoryPage({
  entries,
  onRefresh,
  onRestore,
}: {
  entries: SortHistoryEntry[];
  onRefresh: () => void;
  onRestore: (entry: SortHistoryEntry) => void;
}) {
  return (
    <section className="history-panel">
      <div className="history-header">
        <div>
          <h2>Sort History</h2>
          <p>Restore any previous sort batch.</p>
        </div>
        <button onClick={onRefresh}>Refresh</button>
      </div>

      {entries.length === 0 ? (
        <div className="empty-state">
          <div>No sort history yet</div>
          <p>Completed sorts will appear here after you apply moves.</p>
        </div>
      ) : (
        <div className="history-list">
          {entries.map((entry) => (
            <div className="history-row" key={entry.id}>
              <div className="history-row-main">
                <div className="history-date">{formatHistoryDate(entry.timestamp)}</div>
                <div className="history-folder">{entry.folder || "Unknown folder"}</div>
                <div className="history-count">{entry.moved} items moved</div>
              </div>
              <button onClick={() => onRestore(entry)}>Restore</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function formatHistoryDate(timestamp: string) {
  if (!timestamp) return "Unknown date";

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function SettingGroup({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-group">
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <div className="settings-options">{children}</div>
    </section>
  );
}
