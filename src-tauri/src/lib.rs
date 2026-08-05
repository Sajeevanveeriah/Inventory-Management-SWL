//! Native capabilities for the SWL Pricing and Inventory Control desktop shell.
//!
//! The frontend is the same local-first web application; the shell adds only
//! two capabilities: a native output-folder picker and safe file writing into
//! that folder. All filenames are sanitised here so a compromised or buggy
//! frontend can never traverse outside the operator-chosen folder.

use std::fs;
use std::path::{Component, PathBuf};

use tauri_plugin_dialog::DialogExt;

/// Windows reserved device names that must not be used as file stems.
const WINDOWS_RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Reduce an arbitrary requested filename to a safe basename:
/// no directory components, no Windows-invalid characters, no reserved device
/// names, no trailing dots or spaces, bounded length, never empty.
pub fn sanitise_filename(requested: &str) -> String {
    // Keep only the final path component regardless of separator style.
    let base = requested
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .trim();

    let mut cleaned: String = base
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();

    // Windows rejects names ending in a dot or space.
    while cleaned.ends_with('.') || cleaned.ends_with(' ') {
        cleaned.pop();
    }

    if cleaned.len() > 180 {
        cleaned.truncate(180);
    }

    let stem = cleaned.split('.').next().unwrap_or_default().to_uppercase();
    if cleaned.is_empty() || WINDOWS_RESERVED.contains(&stem.as_str()) {
        return format!("swl-output-{cleaned}");
    }
    cleaned
}

/// A destination folder is only acceptable when it exists, is a directory and
/// is expressed as an absolute path (as returned by the native picker).
fn validate_folder(folder: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(folder);
    if !path.is_absolute() {
        return Err("The output folder must be an absolute path.".into());
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("The output folder path must not contain '..'.".into());
    }
    if !path.is_dir() {
        return Err("The output folder does not exist or is not a folder.".into());
    }
    Ok(path)
}

#[tauri::command]
async fn choose_output_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    match picked {
        Some(folder) => {
            let path: PathBuf = folder
                .into_path()
                .map_err(|_| "The chosen folder path could not be resolved.".to_string())?;
            Ok(Some(path.to_string_lossy().into_owned()))
        }
        None => Ok(None),
    }
}

#[tauri::command]
async fn write_export_file(
    folder: String,
    filename: String,
    contents: Vec<u8>,
) -> Result<String, String> {
    let dir = validate_folder(&folder)?;
    let safe_name = sanitise_filename(&filename);
    let destination: PathBuf = dir.join(&safe_name);
    // Defence in depth: the joined path must stay inside the chosen folder.
    if destination.parent() != Some(dir.as_path()) {
        return Err("The output filename resolved outside the chosen folder.".into());
    }
    fs::write(&destination, contents)
        .map_err(|err| format!("The file could not be written: {}", err.kind()))?;
    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
fn shell_info() -> serde_json::Value {
    serde_json::json!({
        "shell": "tauri",
        "os": std::env::consts::OS,
        "version": env!("CARGO_PKG_VERSION"),
    })
}

/// Referenced by `main.rs`; also usable as a mobile/library entry point.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            choose_output_folder,
            write_export_file,
            shell_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running the SWL desktop application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn keeps_ordinary_export_names() {
        assert_eq!(
            sanitise_filename("20260805_demo_import_run-abc.xlsx"),
            "20260805_demo_import_run-abc.xlsx"
        );
    }

    #[test]
    fn strips_directory_components_in_both_separator_styles() {
        assert_eq!(sanitise_filename("../../etc/passwd"), "passwd");
        assert_eq!(
            sanitise_filename("C:\\Windows\\system32\\evil.dll"),
            "evil.dll"
        );
        assert_eq!(sanitise_filename("a/b/c/report.xlsx"), "report.xlsx");
    }

    #[test]
    fn replaces_windows_invalid_characters() {
        assert_eq!(
            sanitise_filename("a<b>c:d\"e|f?g*h.txt"),
            "a_b_c_d_e_f_g_h.txt"
        );
        assert_eq!(sanitise_filename("tab\there.txt"), "tab_here.txt");
    }

    #[test]
    fn removes_trailing_dots_and_spaces() {
        assert_eq!(sanitise_filename("report.xlsx. . "), "report.xlsx");
    }

    #[test]
    fn refuses_reserved_device_names_and_empty_names() {
        assert_eq!(sanitise_filename("CON.txt"), "swl-output-CON.txt");
        assert_eq!(sanitise_filename("aux"), "swl-output-aux");
        assert_eq!(sanitise_filename("   "), "swl-output-");
    }

    #[test]
    fn bounds_filename_length() {
        let long = "x".repeat(400) + ".xlsx";
        assert!(sanitise_filename(&long).len() <= 180);
    }

    #[test]
    fn rejects_relative_and_traversal_folders() {
        assert!(validate_folder("relative/path").is_err());
        let root = if cfg!(windows) {
            "C:\\definitely\\missing\\.."
        } else {
            "/definitely/missing/.."
        };
        assert!(validate_folder(root).is_err());
    }

    #[test]
    fn accepts_a_real_absolute_folder() {
        let dir = std::env::temp_dir();
        assert!(validate_folder(&dir.to_string_lossy()).is_ok());
    }

    #[test]
    fn write_stays_inside_the_chosen_folder() {
        let dir = std::env::temp_dir().join("swl-desktop-test");
        fs::create_dir_all(&dir).unwrap();
        let dirs = dir.to_string_lossy().into_owned();
        let safe = sanitise_filename("../escape.txt");
        let destination = Path::new(&dirs).join(&safe);
        assert_eq!(destination.parent().unwrap(), dir.as_path());
        fs::remove_dir_all(&dir).ok();
    }
}
