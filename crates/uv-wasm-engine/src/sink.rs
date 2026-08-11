use uv_wasm_compat::io::{Sink, Stream};
use wasm_bindgen::JsValue;

pub struct JsSink {
    on_output: js_sys::Function,
}

impl JsSink {
    pub fn new(on_output: js_sys::Function) -> Self {
        Self { on_output }
    }
}

impl Sink for JsSink {
    fn write(&mut self, stream: Stream, bytes: &[u8]) {
        let name = match stream {
            Stream::Stdout => "stdout",
            Stream::Stderr => "stderr",
        };
        let data = js_sys::Uint8Array::from(bytes);
        let _ = self
            .on_output
            .call2(&JsValue::NULL, &JsValue::from_str(name), &data);
    }
}
