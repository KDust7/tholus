use std::cell::Cell;
use std::rc::Rc;

use uv::GlobalInitialization;
use uv_wasm_compat::term::{self, TermConfig};
use wasm_bindgen::prelude::*;

use crate::dispatch::dispatch;
use crate::fs;

const ALREADY_RUNNING: &str =
    "uv-wasm: an invocation is already running; invocations must be serialized";

#[wasm_bindgen]
pub struct Engine {
    initialized: Cell<bool>,
    running: Rc<Cell<bool>>,
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            initialized: Cell::new(false),
            running: Rc::new(Cell::new(false)),
        }
    }

    #[wasm_bindgen(js_name = setTermSize)]
    pub fn set_term_size(&self, columns: u16, rows: u16) {
        term::set(TermConfig::tty(columns, rows));
    }

    #[wasm_bindgen(js_name = clearTerm)]
    pub fn clear_term(&self) {
        term::reset();
    }

    #[wasm_bindgen(js_name = isRunning)]
    pub fn is_running(&self) -> bool {
        self.running.get()
    }

    #[wasm_bindgen(js_name = fsRead)]
    pub fn fs_read(&self, path: &str) -> Result<Vec<u8>, JsError> {
        fs::read(path)
    }

    #[wasm_bindgen(js_name = fsWrite)]
    pub fn fs_write(&self, path: &str, contents: &[u8]) -> Result<(), JsError> {
        fs::write(path, contents)
    }

    #[wasm_bindgen(js_name = fsReadDir)]
    pub fn fs_read_dir(&self, path: &str) -> Result<Vec<String>, JsError> {
        fs::read_dir(path)
    }

    #[wasm_bindgen(js_name = fsMkdirp)]
    pub fn fs_mkdirp(&self, path: &str) -> Result<(), JsError> {
        fs::create_dir_all(path)
    }

    #[wasm_bindgen(js_name = fsExists)]
    pub fn fs_exists(&self, path: &str) -> bool {
        fs::exists(path)
    }

    #[wasm_bindgen(js_name = fsKind)]
    pub fn fs_kind(&self, path: &str) -> Option<String> {
        fs::kind(path)
    }

    #[wasm_bindgen(js_name = fsRemove)]
    pub fn fs_remove(&self, path: &str) -> Result<(), JsError> {
        fs::remove_file(path)
    }

    #[wasm_bindgen(js_name = fsRemoveDir)]
    pub fn fs_remove_dir(&self, path: &str) -> Result<(), JsError> {
        fs::remove_dir_all(path)
    }

    pub fn invoke(&self, argv: Vec<String>, on_output: js_sys::Function) -> js_sys::Promise {
        if self.running.replace(true) {
            return js_sys::Promise::reject(&JsValue::from_str(ALREADY_RUNNING));
        }
        let initialization = self.next_initialization();
        let running = Rc::clone(&self.running);
        wasm_bindgen_futures::future_to_promise(async move {
            let code = dispatch(argv, on_output, initialization).await;
            running.set(false);
            Ok(JsValue::from(code))
        })
    }
}

impl Engine {
    fn next_initialization(&self) -> GlobalInitialization {
        if self.initialized.replace(true) {
            GlobalInitialization::Reuse
        } else {
            GlobalInitialization::Initialize
        }
    }
}
