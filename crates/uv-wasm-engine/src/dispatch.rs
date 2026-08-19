use uv::GlobalInitialization;
use uv::commands::ExitStatus;
use uv_wasm_compat::io;

use crate::sink::JsSink;

struct InstalledSink;

impl InstalledSink {
    fn install(on_output: js_sys::Function) -> Self {
        io::set_sink(Box::new(JsSink::new(on_output)));
        Self
    }
}

impl Drop for InstalledSink {
    fn drop(&mut self) {
        io::clear_sink();
    }
}

pub async fn dispatch(
    argv: Vec<String>,
    on_output: js_sys::Function,
    initialization: GlobalInitialization,
) -> u8 {
    let _sink = InstalledSink::install(on_output);
    execute(argv, initialization).await.code()
}

async fn execute(argv: Vec<String>, initialization: GlobalInitialization) -> ExitStatus {
    match uv::parse_cli(argv) {
        Ok(cli) => uv::run_and_report(cli, initialization).await,
        Err(err) => uv::report_parse_error(&err),
    }
}
