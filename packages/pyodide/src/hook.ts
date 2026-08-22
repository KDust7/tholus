import type { PyodideLike } from "./facts.js";

export interface HookRequest {
  script: string;
  cwd: string;
  env: Record<string, string>;
}

export interface HookResult {
  stdout: string[];
  stderr: string[];
  code: number;
}

export const RUNNER = `
import contextlib, io, json, os, sys, traceback

def _uvwasm_run_hook(payload):
    request = json.loads(payload)
    out, err = io.StringIO(), io.StringIO()
    saved_path = list(sys.path)
    saved_cwd = os.getcwd()
    saved_env = dict(os.environ)
    code = 0
    try:
        os.environ.update(request["env"])
        sys.path[:0] = [entry for entry in request["sitePackages"] if entry not in sys.path]
        os.chdir(request["cwd"])
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            exec(compile(request["script"], "<pep517>", "exec"), {"__name__": "__main__"})
    except SystemExit as leaving:
        if leaving.code is None:
            code = 0
        elif isinstance(leaving.code, int):
            code = leaving.code
        else:
            print(leaving.code, file=err)
            code = 1
    except BaseException:
        traceback.print_exc(file=err)
        code = 1
    finally:
        try:
            os.chdir(saved_cwd)
        except OSError:
            pass
        sys.path[:] = saved_path
        os.environ.clear()
        os.environ.update(saved_env)
    return json.dumps({
        "stdout": out.getvalue().splitlines(),
        "stderr": err.getvalue().splitlines(),
        "code": code,
    })
`;

export function callOf(request: HookRequest, sitePackages: readonly string[]): string {
  const payload = JSON.stringify({
    script: request.script,
    cwd: request.cwd,
    env: request.env,
    sitePackages,
  });
  return `_uvwasm_run_hook(${JSON.stringify(payload)})`;
}

export function parseResult(raw: string): HookResult {
  const parsed = JSON.parse(raw) as Partial<HookResult>;
  return {
    stdout: parsed.stdout ?? [],
    stderr: parsed.stderr ?? [],
    code: typeof parsed.code === "number" ? parsed.code : 1,
  };
}

export function runHook(
  pyodide: PyodideLike,
  request: HookRequest,
  sitePackages: readonly string[],
): HookResult {
  pyodide.runPython(RUNNER);
  return parseResult(String(pyodide.runPython(callOf(request, sitePackages))));
}
