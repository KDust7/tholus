use std::error::Error;
use std::path::{Path, PathBuf};
use std::process::Command;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

const ENGINE_PACKAGE: &str = "uv-wasm-engine";
const ENGINE_WASM_STEM: &str = "uv_wasm_engine";
const WASM_TARGET: &str = "wasm32-unknown-unknown";
const ARTIFACT_NAME: &str = "engine";
const ARTIFACT_DIR: &str = "packages/core/assets";
const WASM_FEATURES: [&str; 7] = [
    "--enable-bulk-memory",
    "--enable-bulk-memory-opt",
    "--enable-multivalue",
    "--enable-mutable-globals",
    "--enable-nontrapping-float-to-int",
    "--enable-reference-types",
    "--enable-sign-ext",
];

fn main() {
    if let Err(err) = run() {
        eprintln!("xtask: {err}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("build") => build(&args.collect::<Vec<_>>()),
        None | Some("help" | "--help" | "-h") => {
            print_help();
            Ok(())
        }
        Some(other) => Err(format!("unknown command {other:?}; try `cargo xtask help`").into()),
    }
}

fn print_help() {
    println!(
        "\
cargo xtask <command>

Commands:
  build [--dev] [--skip-opt] [--converge]   Build the wasm engine artifact into {ARTIFACT_DIR}
  help                                      Show this message

Options:
  --dev        Build the debug profile
  --skip-opt   Skip wasm-opt even when it is available
  --converge   Re-run wasm-opt until it stops shrinking; hours on a module this size"
    );
}

struct BuildOptions {
    release: bool,
    skip_opt: bool,
    converge: bool,
}

fn build(args: &[String]) -> Result<()> {
    let mut opts = BuildOptions {
        release: true,
        skip_opt: false,
        converge: false,
    };
    for arg in args {
        match arg.as_str() {
            "--dev" => opts.release = false,
            "--release" => opts.release = true,
            "--skip-opt" => opts.skip_opt = true,
            "--converge" => opts.converge = true,
            other => return Err(format!("unknown build flag {other:?}").into()),
        }
    }

    let root = workspace_root()?;
    let profile_dir = if opts.release { "release" } else { "debug" };

    step("compiling engine");
    let mut cargo = Command::new(cargo_bin());
    cargo.current_dir(&root).args([
        "build",
        "--package",
        ENGINE_PACKAGE,
        "--target",
        WASM_TARGET,
    ]);
    if opts.release {
        cargo.arg("--release");
    }
    run_command(&mut cargo, "cargo build")?;

    let input = root
        .join("target")
        .join(WASM_TARGET)
        .join(profile_dir)
        .join(format!("{ENGINE_WASM_STEM}.wasm"));
    if !input.exists() {
        return Err(format!("expected wasm artifact at {}", input.display()).into());
    }
    let raw_size = file_size(&input)?;

    step("generating bindings");
    let out_dir = root.join(ARTIFACT_DIR);
    std::fs::create_dir_all(&out_dir)?;
    let bindgen_bin = find_tool(&root, "wasm-bindgen").ok_or(
        "wasm-bindgen not found; install it with `cargo install wasm-bindgen-cli` \
         at the version pinned in the workspace manifest",
    )?;
    let mut bindgen = Command::new(bindgen_bin);
    bindgen.current_dir(&root).args([
        "--target",
        "web",
        "--out-dir",
        &out_dir.to_string_lossy(),
        "--out-name",
        ARTIFACT_NAME,
        &input.to_string_lossy(),
    ]);
    run_command(&mut bindgen, "wasm-bindgen")?;

    let bound = out_dir.join(format!("{ARTIFACT_NAME}_bg.wasm"));
    let bound_size = file_size(&bound)?;

    let optimized_size = if opts.skip_opt {
        note("skipping wasm-opt (--skip-opt)");
        None
    } else if let Some(wasm_opt) = find_tool(&root, "wasm-opt") {
        step("optimizing");
        let optimized = bound.with_extension("opt.wasm");
        let mut cmd = Command::new(wasm_opt);
        cmd.current_dir(&root).args(WASM_FEATURES).arg("-Oz");
        if opts.converge {
            cmd.arg("--converge");
        }
        cmd.args([
            &bound.to_string_lossy(),
            "-o",
            &optimized.to_string_lossy(),
        ]);
        run_command(&mut cmd, "wasm-opt")?;
        std::fs::rename(&optimized, &bound)?;
        Some(file_size(&bound)?)
    } else {
        note("wasm-opt not found; install the `binaryen` npm package or add it to PATH");
        None
    };

    println!();
    println!("  artifact   {}", bound.display());
    println!("  compiled   {}", human_size(raw_size));
    println!("  bindgen    {}", human_size(bound_size));
    match optimized_size {
        Some(size) => println!("  optimized  {}", human_size(size)),
        None => println!("  optimized  (skipped)"),
    }
    println!();
    println!("Run `pnpm size` for the compressed transfer size and budget check.");
    Ok(())
}

fn find_tool(root: &Path, name: &str) -> Option<PathBuf> {
    if which(name).is_some() {
        return Some(PathBuf::from(name));
    }
    let bin_dir = root.join("node_modules").join(".bin");
    for candidate in [format!("{name}.exe"), format!("{name}.cmd"), name.to_string()] {
        let path = bin_dir.join(candidate);
        if path.exists() {
            return Some(path);
        }
    }
    None
}

fn which(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT".into())
            .split(';')
            .map(|e| e.to_ascii_lowercase())
            .collect()
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(&path_var) {
        for ext in &exts {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn cargo_bin() -> String {
    std::env::var("CARGO").unwrap_or_else(|_| "cargo".into())
}

fn workspace_root() -> Result<PathBuf> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or_else(|| "could not locate the workspace root".into())
}

fn run_command(cmd: &mut Command, label: &str) -> Result<()> {
    let status = cmd
        .status()
        .map_err(|e| format!("failed to launch {label}: {e}"))?;
    if !status.success() {
        return Err(format!("{label} failed with {status}").into());
    }
    Ok(())
}

fn file_size(path: &Path) -> Result<u64> {
    Ok(std::fs::metadata(path)?.len())
}

fn human_size(bytes: u64) -> String {
    const MIB: f64 = 1024.0 * 1024.0;
    const KIB: f64 = 1024.0;
    let bytes_f = bytes as f64;
    if bytes_f >= MIB {
        format!("{:.2} MiB ({bytes} bytes)", bytes_f / MIB)
    } else {
        format!("{:.1} KiB ({bytes} bytes)", bytes_f / KIB)
    }
}

fn step(label: &str) {
    println!("xtask: {label}");
}

fn note(label: &str) {
    println!("xtask: note: {label}");
}
