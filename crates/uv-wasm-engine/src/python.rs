use uv_python::BROWSER_PYTHON_EXECUTABLE;
use wasm_bindgen::JsError;

use crate::fs;

const DEFAULT_PROFILE: &str = include_str!("../assets/browser-python.json");

pub fn seed_default_runtime() -> Result<(), JsError> {
    if fs::exists(BROWSER_PYTHON_EXECUTABLE) {
        return Ok(());
    }
    fs::write(BROWSER_PYTHON_EXECUTABLE, DEFAULT_PROFILE.as_bytes())
}
