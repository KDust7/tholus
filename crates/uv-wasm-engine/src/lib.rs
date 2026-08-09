use wasm_bindgen::prelude::*;

pub const PROTOCOL_VERSION: &str = "0";
pub const UV_VERSION: &str = "unvendored";
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");

#[wasm_bindgen(start)]
pub fn start() {
    #[cfg(target_family = "wasm")]
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn version() -> String {
    format!("uv-wasm {ENGINE_VERSION} (uv {UV_VERSION})")
}

#[wasm_bindgen(js_name = buildInfo)]
pub fn build_info() -> String {
    format!(
        r#"{{"engine":"{ENGINE_VERSION}","uv":"{UV_VERSION}","protocol":"{PROTOCOL_VERSION}"}}"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_names_both_components() {
        let v = version();
        assert!(
            v.contains(ENGINE_VERSION),
            "engine version missing from {v:?}"
        );
        assert!(v.contains(UV_VERSION), "uv version missing from {v:?}");
    }

    #[test]
    fn build_info_is_valid_json_with_expected_keys() {
        let info = build_info();
        assert!(
            info.starts_with('{') && info.ends_with('}'),
            "not a JSON object: {info:?}"
        );
        for key in ["\"engine\"", "\"uv\"", "\"protocol\""] {
            assert!(info.contains(key), "{key} missing from {info:?}");
        }
    }

    #[test]
    fn protocol_version_is_a_bare_integer() {
        assert!(
            PROTOCOL_VERSION.chars().all(|c| c.is_ascii_digit()),
            "protocol version should be digits only, got {PROTOCOL_VERSION:?}"
        );
    }
}
