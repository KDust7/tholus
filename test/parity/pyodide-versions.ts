const PRERELEASE = /-(alpha|beta|rc)\.(\d+)$/;

const LETTER: Readonly<Record<string, string>> = {
  alpha: "a",
  beta: "b",
  rc: "rc",
};

export function asPythonVersion(published: string): string {
  return published.replace(PRERELEASE, (_match, word: string, number: string) => {
    const letter = LETTER[word];
    return letter === undefined ? `-${word}.${number}` : `${letter}${number}`;
  });
}
