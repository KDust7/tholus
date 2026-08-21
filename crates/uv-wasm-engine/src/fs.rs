use std::path::Path;

use uv_vfs::{Vfs, VfsKind};
use wasm_bindgen::JsError;

fn vfs() -> std::sync::Arc<dyn Vfs> {
    uv_vfs::global()
}

fn fail(error: std::io::Error) -> JsError {
    JsError::new(&error.to_string())
}

pub fn read(path: &str) -> Result<Vec<u8>, JsError> {
    vfs().read(Path::new(path)).map_err(fail)
}

pub fn write(path: &str, contents: &[u8]) -> Result<(), JsError> {
    let filesystem = vfs();
    let target = Path::new(path);
    if let Some(parent) = target.parent() {
        filesystem.create_dir_all(parent).map_err(fail)?;
    }
    filesystem.write(target, contents).map_err(fail)
}

pub fn read_dir(path: &str) -> Result<Vec<String>, JsError> {
    let entries = vfs().read_dir(Path::new(path)).map_err(fail)?;
    Ok(entries.into_iter().map(|entry| entry.name).collect())
}

pub fn create_dir_all(path: &str) -> Result<(), JsError> {
    vfs().create_dir_all(Path::new(path)).map_err(fail)
}

pub fn exists(path: &str) -> bool {
    vfs().exists(Path::new(path))
}

pub fn kind(path: &str) -> Option<String> {
    let metadata = vfs().symlink_metadata(Path::new(path)).ok()?;
    Some(
        match metadata.kind {
            VfsKind::File => "file",
            VfsKind::Directory => "directory",
            VfsKind::Symlink => "symlink",
        }
        .to_owned(),
    )
}

pub fn size(path: &str) -> Result<f64, JsError> {
    let metadata = vfs().symlink_metadata(Path::new(path)).map_err(fail)?;
    Ok(metadata.len as f64)
}

pub fn symlink(target: &str, link: &str) -> Result<(), JsError> {
    let filesystem = vfs();
    let location = Path::new(link);
    if let Some(parent) = location.parent() {
        filesystem.create_dir_all(parent).map_err(fail)?;
    }
    filesystem
        .symlink(Path::new(target), location)
        .map_err(fail)
}

pub fn read_link(path: &str) -> Result<String, JsError> {
    let target = vfs().read_link(Path::new(path)).map_err(fail)?;
    target.to_str().map(str::to_owned).ok_or_else(|| {
        JsError::new(&format!(
            "{} points somewhere that is not valid UTF-8",
            path
        ))
    })
}

pub fn remove_file(path: &str) -> Result<(), JsError> {
    vfs().remove_file(Path::new(path)).map_err(fail)
}

pub fn remove_dir_all(path: &str) -> Result<(), JsError> {
    vfs().remove_dir_all(Path::new(path)).map_err(fail)
}
