import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MARKER = "<!-- uv-wasm:parity -->";

const [bodyPath] = process.argv.slice(2);
if (bodyPath === undefined) {
  throw new Error("usage: sticky-comment.mjs <markdown-file>");
}

const repository = process.env["GITHUB_REPOSITORY"];
const eventPath = process.env["GITHUB_EVENT_PATH"];
if (repository === undefined || eventPath === undefined) {
  throw new Error("GITHUB_REPOSITORY and GITHUB_EVENT_PATH are set by Actions; run this there");
}

const event = JSON.parse(readFileSync(eventPath, "utf8"));
const number = event.pull_request?.number;
if (number === undefined) {
  console.log("not a pull request, so there is nothing to comment on");
  process.exit(0);
}

const body = `${MARKER}\n${readFileSync(bodyPath, "utf8").trimEnd()}\n`;

const gh = (args, input) =>
  execFileSync("gh", args, {
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
  });

const existing = JSON.parse(
  gh(["api", `repos/${repository}/issues/${number}/comments`, "--paginate"]),
).find((comment) => typeof comment.body === "string" && comment.body.startsWith(MARKER));

const payload = JSON.stringify({ body });

if (existing) {
  gh(
    ["api", "--method", "PATCH", `repos/${repository}/issues/comments/${existing.id}`, "--input", "-"],
    payload,
  );
  console.log(`updated comment ${existing.id}`);
} else {
  gh(
    ["api", "--method", "POST", `repos/${repository}/issues/${number}/comments`, "--input", "-"],
    payload,
  );
  console.log(`commented on #${number}`);
}
