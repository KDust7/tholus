export const BROWSER_PYTHON = "/bin/python3";
export const UNKNOWN_ABI = "unknown";

export interface ProfileReader {
  fsRead(path: string): Uint8Array;
}

export interface InterpreterProfile {
  platform?: { os?: { name?: string; major?: number; minor?: number }; arch?: string };
  markers?: {
    implementation_name?: string;
    python_full_version?: string;
    python_version?: string;
  };
  stdlib?: string;
  extension_suffixes?: string[];
  scheme?: { purelib?: string };
  virtualenv?: { purelib?: string };
}

export class InconsistentInterpreter extends Error {
  readonly disagreements: string[];

  constructor(path: string, disagreements: string[]) {
    super(`${path} disagrees with itself:\n  ${disagreements.join("\n  ")}`);
    this.name = "InconsistentInterpreter";
    this.disagreements = disagreements;
  }
}

const LAYOUT = /python(\d+)\.(\d+)/;
const SUFFIX = /^\.([a-z_]+)-(\d{2,4})[a-z]*-([^.]+)\.(?:so|pyd|dylib)$/;

function shortVersion(full: string): string | undefined {
  const parts = full.split(".");
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : undefined;
}

function checkSuffixes(
  profile: InterpreterProfile,
  short: string,
  arch: string | undefined,
): string[] {
  const packed = short.replace(".", "");
  return (profile.extension_suffixes ?? []).flatMap((suffix) => {
    const parsed = SUFFIX.exec(suffix);
    if (parsed === null) {
      return [];
    }
    const [, , version, rest] = parsed;
    const found: string[] = [];
    if (version !== packed) {
      const claimed = `${version?.slice(0, 1)}.${version?.slice(1)}`;
      found.push(`extension suffix ${suffix} is built for python ${claimed}, not ${short}`);
    }
    const machine = rest?.split("-")[0];
    if (arch !== undefined && machine !== undefined && machine !== arch) {
      found.push(`extension suffix ${suffix} is built for ${machine}, not ${arch}`);
    }
    return found;
  });
}

function checkLayout(label: string, path: string | undefined, short: string): string[] {
  if (path === undefined) {
    return [];
  }
  const laid = LAYOUT.exec(path);
  if (laid === null || `${laid[1]}.${laid[2]}` === short) {
    return [];
  }
  return [`${label} ${path} is laid out for python ${laid[1]}.${laid[2]}, not ${short}`];
}

export function checkInterpreter(profile: InterpreterProfile): string[] {
  const full = profile.markers?.python_full_version;
  if (full === undefined) {
    return [];
  }
  const short = shortVersion(full);
  if (short === undefined) {
    return [`python_full_version ${full} does not name a major and a minor version`];
  }

  const declared = profile.markers?.python_version;
  const mismatch =
    declared !== undefined && declared !== short
      ? [`python_version ${declared} does not match python_full_version ${full}`]
      : [];

  return [
    ...mismatch,
    ...checkSuffixes(profile, short, profile.platform?.arch),
    ...checkLayout("stdlib", profile.stdlib, short),
    ...checkLayout("scheme.purelib", profile.scheme?.purelib, short),
    ...checkLayout("virtualenv.purelib", profile.virtualenv?.purelib, short),
  ];
}

function readProfile(vfs: ProfileReader, path: string): InterpreterProfile | undefined {
  try {
    return JSON.parse(new TextDecoder().decode(vfs.fsRead(path))) as InterpreterProfile;
  } catch {
    return undefined;
  }
}

export function assertInterpreter(vfs: ProfileReader, path: string = BROWSER_PYTHON): void {
  const profile = readProfile(vfs, path);
  if (profile === undefined) {
    return;
  }
  const disagreements = checkInterpreter(profile);
  if (disagreements.length > 0) {
    throw new InconsistentInterpreter(path, disagreements);
  }
}

export function interpreterAbiTag(vfs: ProfileReader, path: string = BROWSER_PYTHON): string {
  const profile = readProfile(vfs, path);
  if (profile === undefined) {
    return UNKNOWN_ABI;
  }

  const disagreements = checkInterpreter(profile);
  if (disagreements.length > 0) {
    throw new InconsistentInterpreter(path, disagreements);
  }

  const os = profile.platform?.os;
  const arch = profile.platform?.arch;
  const implementation = profile.markers?.implementation_name;
  const version = profile.markers?.python_full_version;
  if (
    os?.name === undefined ||
    os.major === undefined ||
    os.minor === undefined ||
    arch === undefined ||
    implementation === undefined ||
    version === undefined
  ) {
    return UNKNOWN_ABI;
  }
  return `${implementation}-${version}-${os.name}_${os.major}_${os.minor}_${arch}`;
}
