#!/usr/bin/env node
// PreToolUse(Bash): git commit 직전에 npm test 를 돌리고, 실패하면 막는다(exit 2).
//
// 매 턴이 아니라 커밋 경계에 둔다. npm test 는 생성물 최신 여부까지 보므로
// rules/ 를 고치고 npm run build 를 잊은 커밋도 여기서 걸린다.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const COMMIT = /(^|[;&|\s])git(\s+-C\s+\S+)?\s+commit(\s|$)/;

function main() {
  let command = "";
  try {
    command = JSON.parse(readFileSync(0, "utf8"))?.tool_input?.command ?? "";
  } catch {
    return 0;
  }
  if (!COMMIT.test(command)) return 0;

  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const proc = spawnSync("npm", ["test", "--silent"], { cwd: root, encoding: "utf8" });
  if (proc.status === 0) return 0;

  const tail = `${proc.stdout ?? ""}${proc.stderr ?? ""}`.split("\n").slice(-40).join("\n");
  process.stderr.write(`Commit blocked: npm test failed.\n${tail}\n`);
  return 2;
}

process.exit(main());
