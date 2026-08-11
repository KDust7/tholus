use uv::GlobalInitialization;
use uv::commands::ExitStatus;
use uv_wasm_compat::io;

use crate::sink::JsSink;

pub async fn dispatch(
    argv: Vec<String>,
    on_output: js_sys::Function,
    initialization: GlobalInitialization,
) -> u8 {
    io::set_sink(Box::new(JsSink::new(on_output)));
    let status = execute(argv, initialization).await;
    io::clear_sink();
    status.code()
}

async fn execute(argv: Vec<String>, initialization: GlobalInitialization) -> ExitStatus {
    match uv::parse_cli(argv) {
        Ok(cli) => uv::run_and_report(cli, initialization).await,
        Err(err) => uv::report_parse_error(&err),
    }
}
