import { createEngine, type Engine } from "@uv-wasm/core";
import { attachPyodide, type PyodideLike, type PyodideRuntime } from "@uv-wasm/pyodide";
import { attachTerminal } from "@uv-wasm/xterm";
import { Terminal } from "@xterm/xterm";
import terminalStyles from "@xterm/xterm/css/xterm.css";

const MOTD = [
  "uv is compiled to WebAssembly and running in this tab.",
  "Try `uv --version`, `uv venv .venv`, `uv pip install idna`, then `python`.",
  "",
].join("\r\n");

const VENV = "/work/.venv";
const SITE_PACKAGES = `${VENV}/lib/python3.14/site-packages`;

export interface DemoHandle {
  run(line: string): Promise<number>;
  mountPython(): void;
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

  let engine: Engine;
  try {
    engine = await createEngine({
      config: { cwd: "/work", cache: { kind: "opfs" } },
    });
  } catch (error) {
    terminal.write(`\r\nuv could not start: ${describe(error)}\r\n`);
    el("#build").textContent = "failed to boot";
    return;
  }

  el("#build").textContent = `uv ${engine.build.uv} · engine ${engine.build.engine}`;

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

  const session = attachTerminal(terminal, engine, {
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

  (globalThis as unknown as { __demo: DemoHandle }).__demo = {
    run: (line) => session.executeLine(line),
    mountPython: () => {
      mount.click();
    },
  };
}

void main();
