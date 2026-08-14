use uv_version::version as vendored_uv_version;
use wasm_bindgen::prelude::*;

#[cfg(target_family = "wasm")]
mod dispatch;
#[cfg(target_family = "wasm")]
mod engine;
#[cfg(target_family = "wasm")]
mod fs;
#[cfg(target_family = "wasm")]
mod python;
#[cfg(target_family = "wasm")]
mod sink;

#[cfg(target_family = "wasm")]
pub use engine::Engine;

pub const PROTOCOL_VERSION: &str = "0";
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");

#[wasm_bindgen(start)]
pub fn start() {
    #[cfg(target_family = "wasm")]
    console_error_panic_hook::set_once();
}

pub fn uv_version() -> &'static str {
    vendored_uv_version()
}

#[wasm_bindgen]
pub fn version() -> String {
    format!("uv-wasm {ENGINE_VERSION} (uv {})", uv_version())
}

#[wasm_bindgen(js_name = buildInfo)]
pub fn build_info() -> String {
    format!(
        r#"{{"engine":"{ENGINE_VERSION}","uv":"{}","protocol":"{PROTOCOL_VERSION}"}}"#,
        uv_version()
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
        assert!(v.contains(uv_version()), "uv version missing from {v:?}");
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

    #[test]
    fn the_uv_version_comes_from_the_vendored_fork() {
        let reported = uv_version();
        assert_ne!(reported, "unvendored");
        assert!(
            reported.split('.').count() >= 3,
            "not a release version: {reported:?}"
        );
        assert!(
            reported.split('.').all(|part| part
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_digit())),
            "not a release version: {reported:?}"
        );
    }
}
