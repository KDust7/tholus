import { createEngine, type Engine } from "@tholus/core";
import { attachPyodide, type PyodideLike, type PyodideRuntime } from "@tholus/pyodide";
import { attachTerminal, type TerminalSession } from "@tholus/xterm";
import { Terminal } from "@xterm/xterm";
import terminalStyles from "@xterm/xterm/css/xterm.css";

const MOTD = [
  "uv is compiled to WebAssembly and running in this tab.",
  "Try `uv --version`, `uv venv .venv`, `uv pip install idna`, then `python`.",
  "",
].join("\r\n");

const VENV = "/work/.venv";
const SITE_PACKAGES = `${VENV}/lib/python3.14/site-packages`;
const USER_AGENT = "uv/0.12.3 (+https://github.com/astral-sh/uv)";
const PLATFORM = { kind: "platform" } as const;

const BOOT_WORDS: Record<string, string> = {
  "compile-start": "compiling uv…",
  "compile-done": "compiled",
  "init-start": "starting the engine…",
  ready: "ready",
};

type Transport = typeof PLATFORM | ReturnType<typeof relayTransport>;

export interface DemoHandle {
  run(line: string): Promise<number>;
  mountPython(): void;
  useRelay(relayUrl: string): Promise<void>;
}

const el = <T extends Element>(selector: string): T => {
  const found = document.querySelector<T>(selector);
  if (!found) {
    throw new Error(`the demo page has no ${selector}`);
  }
  return found;
};

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const status = (text: string): void => {
  el("#status").textContent = text;
};

function relayTransport(relayUrl: string) {
  return {
    kind: "libcurl",
    moduleUrl: "/libcurl/libcurl.mjs",
    wasmUrl: "/libcurl/libcurl.wasm",
    relayUrl,
    userAgent: USER_AGENT,
  } as const;
}

async function loadPyodide(): Promise<PyodideLike> {
  const specifier = "/pyodide/pyodide.mjs";
  const module = (await import(specifier)) as {
    loadPyodide: (options: { indexURL: string }) => Promise<PyodideLike>;
  };
  return module.loadPyodide({ indexURL: "/pyodide/" });
}

async function main(): Promise<void> {
  const styles = document.createElement("style");
  styles.textContent = terminalStyles;
  document.head.append(styles);

  const terminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: 'ui-monospace, "Cascadia Code", "SF Mono", Menlo, monospace',
    fontSize: 13,
    theme: { background: "#101010", foreground: "#e6e6e6", cursor: "#7dd3a0" },
  });
  terminal.open(el("#terminal"));

  const build = el("#build");

  const start = async (transport: Transport): Promise<Engine> =>
    createEngine({
      config: { cwd: "/work", cache: { kind: "opfs" }, transport },
      onBootProgress: ({ phase, ms }) => {
        const said = BOOT_WORDS[phase] ?? phase;
        build.textContent = ms === undefined ? said : `${said} in ${Math.round(ms)} ms`;
      },
    });

  let engine: Engine;
  try {
    engine = await start(PLATFORM);
  } catch (error) {
    terminal.write(`\r\nuv could not start: ${describe(error)}\r\n`);
    build.textContent = "failed to boot";
    return;
  }

  build.textContent = `uv ${engine.build.uv} · engine ${engine.build.engine}`;

  let runtime: PyodideRuntime | undefined;

  const python = async (argv: string[], write: (text: string) => void): Promise<number> => {
    if (!runtime) {
      write("Python is not loaded yet, press the button below first.\r\n");
      return 1;
    }
    const source = argv[1] === "-c" ? argv.slice(2).join(" ") : undefined;
    if (source === undefined) {
      write("This demo only runs `python -c <source>`.\r\n");
      return 2;
    }
    try {
      const outcome = await runtime.hook({
        script: source,
        cwd: "/",
        env: {},
        sitePackages: [],
        trees: [],
      });
      for (const line of [...outcome.stdout, ...outcome.stderr]) {
        write(`${line}\r\n`);
      }
      return outcome.code;
    } catch (error) {
      write(`${describe(error)}\r\n`);
      return 1;
    }
  };

  const attach = (to: Engine): TerminalSession =>
    attachTerminal(terminal, to, {
      motd: MOTD,
      cwd: "/work",
      commands: {
        python: ({ argv, write }) => python(argv, write),
        clear: () => {
          terminal.clear();
          return 0;
        },
      },
    });

  let session = attach(engine);

  const mount = el<HTMLButtonElement>("#mount");
  mount.disabled = false;
  mount.addEventListener("click", () => {
    void (async () => {
      mount.disabled = true;
      try {
        status("loading Python…");
        const pyodide = await loadPyodide();
        runtime = attachPyodide(engine, pyodide);
        status("mounting the environment…");
        const mounted = await runtime.mount(SITE_PACKAGES);
        status(`mounted ${mounted.files} file(s) at ${mounted.path}`);
        terminal.write(
          `\r\nPython is ready. Try \`python -c "import idna; idna.__version__"\`.\r\n`,
        );
      } catch (error) {
        status(describe(error));
        mount.disabled = false;
      }
    })();
  });

  const relay = el<HTMLInputElement>("#relay");
  const connect = el<HTMLButtonElement>("#connect");

  const useRelay = async (relayUrl: string): Promise<void> => {
    const wanted = relayUrl.trim();
    connect.disabled = true;
    relay.disabled = true;
    status(wanted === "" ? "reconnecting through this tab…" : `reconnecting through ${wanted}…`);
    let replacement: Engine;
    try {
      replacement = await start(wanted === "" ? PLATFORM : relayTransport(wanted));
    } catch (error) {
      status(describe(error));
      terminal.write(`\r\nThe relay was refused: ${describe(error)}\r\n`);
      connect.disabled = false;
      relay.disabled = false;
      return;
    }

    session.dispose();
    runtime = undefined;
    void engine.dispose();
    engine = replacement;
    session = attach(engine);
    build.textContent = `uv ${engine.build.uv} · engine ${engine.build.engine}`;
    mount.disabled = false;
    status(wanted === "" ? "using this tab's own fetch" : `routing through ${wanted}`);
    connect.disabled = false;
    relay.disabled = false;
  };

  connect.addEventListener("click", () => {
    void useRelay(relay.value);
  });

  (globalThis as unknown as { __demo: DemoHandle }).__demo = {
    run: (line) => session.executeLine(line),
    mountPython: () => {
      mount.click();
    },
    useRelay,
  };
}

void main();
