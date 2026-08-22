use uv_wasm_compat::pep517::{HookError, HookFuture, HookOutput, HookRequest, Pep517Runner};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;

pub struct JsRunner {
    run_hook: js_sys::Function,
}

impl JsRunner {
    pub fn new(run_hook: js_sys::Function) -> Self {
        Self { run_hook }
    }
}

fn describe(value: &JsValue) -> String {
    value
        .as_string()
        .or_else(|| {
            js_sys::Reflect::get(value, &JsValue::from_str("message"))
                .ok()?
                .as_string()
        })
        .unwrap_or_else(|| format!("{value:?}"))
}

fn to_request(request: &HookRequest) -> Result<JsValue, JsValue> {
    let payload = js_sys::Object::new();
    let set =
        |key: &str, value: JsValue| js_sys::Reflect::set(&payload, &JsValue::from_str(key), &value);
    set("venv", JsValue::from_str(&request.venv))?;
    set("script", JsValue::from_str(&request.script))?;
    set("sourceTree", JsValue::from_str(&request.source_tree))?;
    set("path", JsValue::from_str(&request.path))?;
    if let Some(output_dir) = &request.output_dir {
        set("outputDir", JsValue::from_str(output_dir))?;
    }

    let env = js_sys::Object::new();
    for (key, value) in &request.env {
        js_sys::Reflect::set(&env, &JsValue::from_str(key), &JsValue::from_str(value))?;
    }
    set("env", env.into())?;
    Ok(payload.into())
}

fn lines(value: &JsValue, key: &str) -> Vec<String> {
    let Ok(found) = js_sys::Reflect::get(value, &JsValue::from_str(key)) else {
        return Vec::new();
    };
    let Ok(array) = found.dyn_into::<js_sys::Array>() else {
        return Vec::new();
    };
    array.iter().filter_map(|entry| entry.as_string()).collect()
}

fn to_output(value: &JsValue) -> Result<HookOutput, HookError> {
    let code = js_sys::Reflect::get(value, &JsValue::from_str("code"))
        .ok()
        .and_then(|found| found.as_f64())
        .ok_or_else(|| {
            HookError::Failed("the runtime returned no exit code for the hook".to_string())
        })?;
    Ok(HookOutput {
        stdout: lines(value, "stdout"),
        stderr: lines(value, "stderr"),
        code: code as i32,
    })
}

impl Pep517Runner for JsRunner {
    fn run(&self, request: HookRequest) -> HookFuture {
        let call = to_request(&request)
            .and_then(|payload| self.run_hook.call1(&JsValue::NULL, &payload))
            .map(js_sys::Promise::from);

        Box::pin(async move {
            let promise = call.map_err(|err| HookError::Failed(describe(&err)))?;
            let value = JsFuture::from(promise)
                .await
                .map_err(|err| HookError::Failed(describe(&err)))?;
            to_output(&value)
        })
    }
}
