#![cfg(target_family = "wasm")]

use wasm_bindgen_test::{wasm_bindgen_test, wasm_bindgen_test_configure};

wasm_bindgen_test_configure!(run_in_browser);

#[wasm_bindgen_test]
fn web_time_instant_is_usable() {
    let start = web_time::Instant::now();
    let elapsed = start.elapsed();
    assert!(
        elapsed.as_secs() < 60,
        "implausible elapsed time: {elapsed:?}"
    );
}

#[wasm_bindgen_test]
fn web_time_system_time_is_after_epoch() {
    let now = web_time::SystemTime::now();
    let since_epoch = now
        .duration_since(web_time::SystemTime::UNIX_EPOCH)
        .expect("system time should be after the Unix epoch");
    assert!(
        since_epoch.as_secs() > 1_577_836_800,
        "clock looks unset: {since_epoch:?}"
    );
}

#[wasm_bindgen_test]
fn std_fs_returns_errors_rather_than_panicking() {
    let result = std::fs::read("/definitely/not/here");
    assert!(
        result.is_err(),
        "std::fs::read unexpectedly succeeded on wasm"
    );
}

#[wasm_bindgen_test]
fn std_env_vars_are_absent() {
    assert!(
        std::env::var("PATH").is_err(),
        "expected no ambient environment on wasm"
    );
    assert_eq!(
        std::env::vars().count(),
        0,
        "expected an empty environment on wasm"
    );
}

#[wasm_bindgen_test]
fn engine_reports_its_identity() {
    let info = uv_wasm_engine::build_info();
    assert!(
        info.contains("\"protocol\""),
        "build info missing protocol field: {info}"
    );
    assert!(uv_wasm_engine::version().starts_with("tholus "));
}
