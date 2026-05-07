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
  | "Other";

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

function dedupeFiles(files: FileResult[]) {
  const seen = new Map<string, FileResult>();

  for (const file of files) {
    const key = file.path || `${file.id}-${file.name}`;
    seen.set(key, file);
  }

  return Array.from(seen.values());
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
};

// ── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [folder, setFolder] = useState<string>("");
  const [status, setStatus] = useState<Status>("idle");
  const [files, setFiles] = useState<FileResult[]>([]);
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [progress, setProgress] = useState(0);
  const [scanTotal, setScanTotal] = useState(0);
  const [activeFilter, setActiveFilter] = useState<CategoryFilter>("All");
  const [movedCount, setMovedCount] = useState(0);
  const [moveErrors, setMoveErrors] = useState<MoveError[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const expectedMoveCount = useRef(0);

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

        setFiles(dedupeFiles(payload.files));
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
        setStatus("done");
        showToast(`${payload.moved} items moved successfully`);
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

  const startScan = async () => {
    if (!folder) return;
    setStatus("scanning");
    setActiveFilter("All");
    try {
      await invoke("scan_folder", { folder });
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

  const applyMoves = async () => {
    const approvedIds = files
      .filter((f) => decisions[f.id] === "approved")
      .map((f) => f.id);

    if (!folder || approvedIds.length === 0) return;

    expectedMoveCount.current = approvedIds.length;
    setStatus("applying");
    setMovedCount(0);
    setMoveErrors([]);

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

  const resetForNewFolder = () => {
    setFolder("");
    setFiles([]);
    setDecisions({});
    setProgress(0);
    setScanTotal(0);
    setMovedCount(0);
    setMoveErrors([]);
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
                {status === "idle" && "Pick a folder to get started"}
                {status === "scanning" && `Scanning… ${files.length} of ${scanTotal} items`}
                {status === "review" && "Review Items"}
                {status === "applying" && `Moving items… ${movedCount} done`}
                {status === "done" && "Sorted Successfully"}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-3)" }}>
                {status === "scanning" && `${progress}% complete`}
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

            {status === "idle" && (
              <div style={{ textAlign: "center", marginTop: 80, color: "var(--text-3)" }}>
                <div style={{ fontSize: 48, marginBottom: 16 }}>🗂️</div>
                <div style={{ fontSize: 15, fontWeight: 500, color: "var(--text-2)", marginBottom: 6 }}>Ready to organize</div>
                <div style={{ fontSize: 13 }}>Pick a folder, then scan items</div>
              </div>
            )}

            {(status === "review" || status === "applying" || status === "done") && (
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
                          onClick={applyMoves}
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

            {status === "scanning" && files.length > 0 && (
              <div className="file-list">
                {visibleFiles.map((file) => (
                  <FileRow
                    key={file.path}
                    file={file}
                    decision={decisions[file.id]}
                    status={status}
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
          {status === "review" && (
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
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function FileRow({
  file,
  decision,
  status,
  onApprove,
  onReject,
}: {
  file: FileResult;
  decision: "approved" | "rejected" | null | undefined;
  status: Status;
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

        <span
          className="category-badge"
          style={{ background: colors.bg, color: colors.text }}
        >
          {file.category}
        </span>

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
