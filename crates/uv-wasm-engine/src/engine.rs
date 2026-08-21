use std::cell::{Cell, RefCell};
use std::rc::Rc;

use futures::channel::oneshot;
use futures::future::{Either, select};
use uv::GlobalInitialization;
use uv_wasm_compat::term::{self, TermConfig};
use wasm_bindgen::prelude::*;

use crate::dispatch::dispatch;
use crate::fs;
use crate::python;

const ALREADY_RUNNING: &str =
    "uv-wasm: an invocation is already running; invocations must be serialized";

const EXIT_CODE_CANCELLED: u8 = 130;

#[wasm_bindgen]
pub struct Engine {
    running: Rc<Cell<bool>>,
    cancel: Rc<RefCell<Option<oneshot::Sender<()>>>>,
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<Engine, JsError> {
        python::seed_default_runtime()?;
        Ok(Self {
            running: Rc::new(Cell::new(false)),
            cancel: Rc::new(RefCell::new(None)),
        })
    }

    #[wasm_bindgen(js_name = attachRuntime)]
    pub fn attach_runtime(&self, run_hook: js_sys::Function) {
        uv_wasm_compat::pep517::set_runner(Box::new(crate::pep517::JsRunner::new(run_hook)));
    }

    #[wasm_bindgen(js_name = detachRuntime)]
    pub fn detach_runtime(&self) {
        uv_wasm_compat::pep517::clear_runner();
    }

    #[wasm_bindgen(js_name = hasRuntime)]
    pub fn has_runtime(&self) -> bool {
        uv_wasm_compat::pep517::is_attached()
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

    #[wasm_bindgen(js_name = setStdin)]
    pub fn set_stdin(&self, bytes: Vec<u8>) {
        uv_wasm_compat::stdin::set(bytes);
    }

    #[wasm_bindgen(js_name = clearStdin)]
    pub fn clear_stdin(&self) {
        uv_wasm_compat::stdin::reset();
    }

    #[cfg(target_family = "wasm")]
    #[wasm_bindgen(js_name = setCwd)]
    pub fn set_cwd(&self, path: &str) -> Result<(), JsError> {
        uv_vfs::set_current_dir(path)
            .map_err(|error| JsError::new(&format!("uv-wasm: could not enter `{path}`: {error}")))
    }

    #[cfg(target_family = "wasm")]
    #[wasm_bindgen(js_name = cwd)]
    pub fn cwd(&self) -> String {
        uv_vfs::current_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
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

    #[wasm_bindgen(js_name = fsSize)]
    pub fn fs_size(&self, path: &str) -> Result<f64, JsError> {
        fs::size(path)
    }

    #[wasm_bindgen(js_name = fsSymlink)]
    pub fn fs_symlink(&self, target: &str, link: &str) -> Result<(), JsError> {
        fs::symlink(target, link)
    }

    #[wasm_bindgen(js_name = fsReadLink)]
    pub fn fs_read_link(&self, path: &str) -> Result<String, JsError> {
        fs::read_link(path)
    }

    #[wasm_bindgen(js_name = fsRemove)]
    pub fn fs_remove(&self, path: &str) -> Result<(), JsError> {
        fs::remove_file(path)
    }

    #[wasm_bindgen(js_name = fsRemoveDir)]
    pub fn fs_remove_dir(&self, path: &str) -> Result<(), JsError> {
        fs::remove_dir_all(path)
    }

    #[cfg(target_family = "wasm")]
    #[wasm_bindgen(js_name = envSet)]
    pub fn env_set(&self, key: &str, value: &str) {
        uv_vfs::env::set(key, value);
    }

    #[cfg(target_family = "wasm")]
    #[wasm_bindgen(js_name = envGet)]
    pub fn env_get(&self, key: &str) -> Option<String> {
        uv_vfs::var(key).ok()
    }

    #[cfg(target_family = "wasm")]
    #[wasm_bindgen(js_name = envUnset)]
    pub fn env_unset(&self, key: &str) {
        uv_vfs::env::unset(key);
    }

    #[cfg(target_family = "wasm")]
    #[wasm_bindgen(js_name = envReplace)]
    pub fn env_replace(&self, entries: Vec<String>) -> Result<(), JsError> {
        if entries.len() % 2 != 0 {
            return Err(JsError::new(
                "envReplace takes a flat key/value list, so it needs an even number of entries",
            ));
        }
        uv_vfs::env::replace(
            entries
                .chunks_exact(2)
                .map(|pair| (pair[0].clone().into(), pair[1].clone().into())),
        );
        Ok(())
    }

    #[cfg(target_family = "wasm")]
    #[wasm_bindgen(js_name = envKeys)]
    pub fn env_keys(&self) -> Vec<String> {
        uv_vfs::env::snapshot()
            .into_iter()
            .map(|(key, _)| key.to_string_lossy().into_owned())
            .collect()
    }

    pub fn invoke(&self, argv: Vec<String>, on_output: js_sys::Function) -> js_sys::Promise {
        if self.running.replace(true) {
            return js_sys::Promise::reject(&JsValue::from_str(ALREADY_RUNNING));
        }
        let initialization = self.next_initialization();
        let running = Rc::clone(&self.running);
        let cancel = Rc::clone(&self.cancel);
        let (sender, receiver) = oneshot::channel();
        *cancel.borrow_mut() = Some(sender);
        wasm_bindgen_futures::future_to_promise(async move {
            let invocation = Box::pin(dispatch(argv, on_output, initialization));
            let code = match select(invocation, receiver).await {
                Either::Left((code, _)) => code,
                Either::Right((_, _)) => EXIT_CODE_CANCELLED,
            };
            cancel.borrow_mut().take();
            running.set(false);
            Ok(JsValue::from(code))
        })
    }

    pub fn cancel(&self) -> bool {
        match self.cancel.borrow_mut().take() {
            Some(sender) => sender.send(()).is_ok(),
            None => false,
        }
    }
}

impl Engine {
    fn next_initialization(&self) -> GlobalInitialization {
        GlobalInitialization::detect()
    }
}
