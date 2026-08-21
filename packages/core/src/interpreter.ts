export const BROWSER_PYTHON = "/bin/python3";
export const UNKNOWN_ABI = "unknown";

export interface ProfileReader {
  fsRead(path: string): Uint8Array;
}

interface InterpreterProfile {
  platform?: { os?: { name?: string; major?: number; minor?: number }; arch?: string };
  markers?: { implementation_name?: string; python_full_version?: string };
}

export function interpreterAbiTag(vfs: ProfileReader, path: string = BROWSER_PYTHON): string {
  let profile: InterpreterProfile;
  try {
    profile = JSON.parse(new TextDecoder().decode(vfs.fsRead(path))) as InterpreterProfile;
  } catch {
    return UNKNOWN_ABI;
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
