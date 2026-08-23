const DURATION = /\bin (?:\d+m \d{2}s|\d+(?:\.\d+)?(?:ms|s))\b/g;
const ENVIRONMENT = /^Using (?:C?Python) .*$/gm;
const LOCATION = /^Location: .*$/gm;

export function normalizeReport(text: string): string {
  return text
    .replace(DURATION, "in <DURATION>")
    .replace(ENVIRONMENT, "Using Python <ENVIRONMENT>")
    .replace(LOCATION, "Location: <LOCATION>");
}
