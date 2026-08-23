import ts from "typescript";

export interface ApiEntry {
  name: string;
  kind: string;
  signature: string;
}

const KINDS: readonly (readonly [ts.SymbolFlags, string])[] = [
  [ts.SymbolFlags.Class, "class"],
  [ts.SymbolFlags.Interface, "interface"],
  [ts.SymbolFlags.TypeAlias, "type"],
  [ts.SymbolFlags.Enum, "enum"],
  [ts.SymbolFlags.Function, "function"],
  [ts.SymbolFlags.Variable, "const"],
  [ts.SymbolFlags.Module, "namespace"],
];

export function kindOf(flags: ts.SymbolFlags): string {
  for (const [flag, name] of KINDS) {
    if ((flags & flag) !== 0) {
      return name;
    }
  }
  return "unknown";
}

export function stripLeadingComment(text: string): string {
  let rest = text;
  for (;;) {
    const trimmed = rest.replace(/^\s+/, "");
    if (trimmed.startsWith("/*")) {
      const close = trimmed.indexOf("*/");
      if (close === -1) {
        return trimmed;
      }
      rest = trimmed.slice(close + 2);
      continue;
    }
    if (trimmed.startsWith("//")) {
      const line = trimmed.indexOf("\n");
      if (line === -1) {
        return "";
      }
      rest = trimmed.slice(line + 1);
      continue;
    }
    return trimmed.trimEnd();
  }
}

export function declarationText(symbol: ts.Symbol): string {
  const declaration = symbol.declarations?.[0];
  if (!declaration) {
    return "";
  }
  const source = declaration.getSourceFile().text;
  return stripLeadingComment(source.slice(declaration.getStart(), declaration.getEnd()));
}

export function surfaceOf(entryPoint: string): ApiEntry[] {
  const program = ts.createProgram([entryPoint], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entryPoint);
  if (!source) {
    throw new Error(`${entryPoint} could not be read; build the package first`);
  }
  const module = checker.getSymbolAtLocation(source);
  if (!module) {
    return [];
  }

  return checker
    .getExportsOfModule(module)
    .map((symbol) => {
      const resolved =
        (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
      return {
        name: symbol.getName(),
        kind: kindOf(resolved.flags),
        signature: declarationText(resolved),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function renderReport(packageName: string, entries: readonly ApiEntry[]): string {
  const body = entries.map((entry) =>
    entry.signature === "" ? `${entry.kind} ${entry.name};` : entry.signature,
  );
  return [
    `# ${packageName}`,
    "",
    `${entries.length} public export${entries.length === 1 ? "" : "s"}.`,
    "",
    "```ts",
    body.join("\n\n"),
    "```",
    "",
  ].join("\n");
}
