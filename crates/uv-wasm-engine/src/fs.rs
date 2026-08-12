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

pub fn remove_file(path: &str) -> Result<(), JsError> {
    vfs().remove_file(Path::new(path)).map_err(fail)
}

pub fn remove_dir_all(path: &str) -> Result<(), JsError> {
    vfs().remove_dir_all(Path::new(path)).map_err(fail)
}
