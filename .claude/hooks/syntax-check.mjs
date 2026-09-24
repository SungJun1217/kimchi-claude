#!/usr/bin/env node
// PostToolUse(Edit|Write): 고친 .mjs/.js 는 node --check 로, .json 은 JSON.parse 로 본다.
//
// 훅 파일의 문법 오류는 시험보다 먼저 사용자 세션에서 드러난다. 훅은 실패하면
// 조용히 넘어가도록 짜여 있어서, 깨진 훅은 오류 없이 검사를 멈출 뿐이다.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

function main() {
  let path;
  try {
    const payload = JSON.parse(readFileSync(0, "utf8"));
    path = payload?.tool_input?.file_path ?? payload?.tool_response?.filePath;
  } catch {
    return 0;
  }
  if (!path) return 0;

  if (/\.(mjs|js)$/.test(path)) {
    const proc = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
    if (proc.status !== 0) {
      process.stderr.write(`Syntax check failed for ${path}:\n${proc.stderr}`);
      return 2;
    }
  } else if (path.endsWith(".json")) {
    try {
      JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      process.stderr.write(`JSON parse failed for ${path}: ${error.message}\n`);
      return 2;
    }
  }
  return 0;
}

process.exit(main());
