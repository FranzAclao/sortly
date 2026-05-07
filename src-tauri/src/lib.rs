use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

struct PythonProcess(Arc<Mutex<Option<Child>>>);

#[derive(Serialize, Deserialize, Clone)]
struct PythonEvent {
    event: String,
    data: Value,
}

#[tauri::command]
fn scan_folder(folder: String, app: AppHandle, state: State<PythonProcess>) -> Result<(), String> {
    send_command(
        &state,
        &app,
        serde_json::json!({
            "action": "scan",
            "folder": folder,
        }),
    )
}

#[tauri::command]
fn apply_moves(
    folder: String,
    approved_ids: Vec<u32>,
    files: Value,
    app: AppHandle,
    state: State<PythonProcess>,
) -> Result<(), String> {
    send_command(
        &state,
        &app,
        serde_json::json!({
            "action": "apply",
            "folder": folder,
            "approved_ids": approved_ids,
            "files": files,
        }),
    )
}

#[tauri::command]
fn undo_last(app: AppHandle, state: State<PythonProcess>) -> Result<(), String> {
    send_command(&state, &app, serde_json::json!({"action": "undo"}))
}

fn send_command(state: &State<PythonProcess>, _app: &AppHandle, cmd: Value) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(child) = guard.as_mut() {
        if let Some(stdin) = child.stdin.as_mut() {
            let line = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
            writeln!(stdin, "{}", line).map_err(|e| e.to_string())?;
            return Ok(());
        }
    }
    Err("Python process not running".into())
}

fn spawn_python(app: AppHandle) -> Child {
    // In dev: run python directly. In production: use bundled sidecar.
    let python_script = app.path().resource_dir().unwrap().join("python/sorter.py");

    let child = Command::new("python")
        .arg(&python_script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Failed to start Python process. Make sure Python is installed.");

    child
}

fn start_stdout_listener(app: AppHandle, stdout: std::process::ChildStdout) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            if let Ok(line) = line {
                if let Ok(evt) = serde_json::from_str::<PythonEvent>(&line) {
                    let _ = app.emit(&evt.event, &evt.data);
                }
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(PythonProcess(Arc::new(Mutex::new(None))))
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            apply_moves,
            undo_last,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            let state: State<PythonProcess> = app.state();

            let mut child = spawn_python(handle.clone());
            let stdout = child.stdout.take().unwrap();
            start_stdout_listener(handle, stdout);

            *state.0.lock().unwrap() = Some(child);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
