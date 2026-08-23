import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { type Goldens, goldensPath, root } from "./cli-goldens.js";

const fixtures = resolve(root, "test/fixtures");

const FLOOR = 85;

const CONSUMERS: Readonly<Record<string, string>> = {
  "pure-python": "compile-parity",
  markers: "compile-parity",
  transitive: "compile-parity",
  extras: "compile-parity",
  hashes: "compile-parity",
  universal: "compile-parity",
  stdin: "compile-parity",
  "pyodide-wheel": "compile-parity",
  conflicts: "compile-parity",
  install: "install-parity",
  sync: "install-parity",
  "install-transitive": "install-parity",
  "install-pyodide": "install-parity",
  sdist: "sdist-backends",
  "sdist-setuptools": "sdist-backends",
  "sdist-hatchling": "sdist-backends",
};

interface Snapshot {
  command?: string;
  expected?: string;
  variants?: { name: string }[];
  followUps?: { args: string[]; status: number; stdout: string; stderr: string }[];
}

interface Cell {
  family: string;
  name: string;
}

function census(): Cell[] {
  const cells: Cell[] = [];

  if (existsSync(goldensPath)) {
    const goldens = JSON.parse(readFileSync(goldensPath, "utf8")) as Goldens;
    for (const entry of goldens.cases) {
      cells.push({ family: "cli", name: entry.args.join(" ") });
    }
  }

  for (const name of readdirSync(fixtures)) {
    const path = resolve(fixtures, name, "snapshot.json");
    if (name === "cli" || !existsSync(path)) {
      continue;
    }
    const snapshot = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
    const family = snapshot.command === "install" ? "install" : "compile";
    cells.push({ family, name });
    for (const variant of snapshot.variants ?? []) {
      cells.push({ family, name: `${name} ${variant.name}` });
    }
    (snapshot.followUps ?? []).forEach((followUp, index) => {
      cells.push({ family, name: `${name} #${index} > ${followUp.args.join(" ")}` });
    });
  }

  return cells;
}

describe("the parity grid", () => {
  const cells = census();

  it(`compares at least ${FLOOR} scenarios against native uv`, () => {
    const byFamily = new Map<string, number>();
    for (const cell of cells) {
      byFamily.set(cell.family, (byFamily.get(cell.family) ?? 0) + 1);
    }
    const breakdown = [...byFamily]
      .sort()
      .map(([family, count]) => `${family}=${count}`)
      .join(" ");
    expect(cells.length, `the grid is ${cells.length} cells (${breakdown})`).toBeGreaterThanOrEqual(
      FLOOR,
    );
  });

  it("names every cell exactly once, so a duplicate cannot pad the count", () => {
    const seen = new Set<string>();
    const repeated: string[] = [];
    for (const cell of cells) {
      const key = `${cell.family}/${cell.name}`;
      if (seen.has(key)) {
        repeated.push(key);
      }
      seen.add(key);
    }
    expect(repeated).toEqual([]);
  });

  it("only repeats a follow-up command where the recorded answer changed", () => {
    const idle: string[] = [];
    for (const name of readdirSync(fixtures)) {
      const path = resolve(fixtures, name, "snapshot.json");
      if (name === "cli" || !existsSync(path)) {
        continue;
      }
      const snapshot = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
      const answers = new Map<string, string>();
      for (const followUp of snapshot.followUps ?? []) {
        const command = followUp.args.join(" ");
        const answer = JSON.stringify([followUp.status, followUp.stdout, followUp.stderr]);
        if (answers.get(command) === answer) {
          idle.push(`${name} > ${command}`);
        }
        answers.set(command, answer);
      }
    }
    expect(
      idle,
      "a follow-up repeats a command that answered identically; it pads the grid",
    ).toEqual([]);
  });

  it("has a test consuming every recorded fixture", () => {
    const recorded = readdirSync(fixtures).filter(
      (name) => name !== "cli" && existsSync(resolve(fixtures, name, "snapshot.json")),
    );
    const orphans = recorded.filter((name) => CONSUMERS[name] === undefined);
    expect(orphans, "a fixture is recorded that no test reads; wire it up or delete it").toEqual(
      [],
    );

    for (const [name, consumer] of Object.entries(CONSUMERS)) {
      const suite = resolve(root, "test/parity", `${consumer}.test.ts`);
      expect(existsSync(suite), `${name} names a suite that does not exist`).toBe(true);
      expect(
        readFileSync(suite, "utf8").includes(`"${name}"`),
        `${consumer} does not name the ${name} fixture`,
      ).toBe(true);
    }
  });

  it("carries no empty golden, which would agree with anything", () => {
    for (const name of readdirSync(fixtures)) {
      const path = resolve(fixtures, name, "snapshot.json");
      if (name === "cli" || !existsSync(path)) {
        continue;
      }
      const snapshot = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
      for (const variant of snapshot.variants ?? []) {
        const expected = (variant as { expected?: string }).expected ?? "";
        expect(expected.length, `${name}/${variant.name} recorded an empty golden`).toBeGreaterThan(
          0,
        );
      }
    }
  });
});
