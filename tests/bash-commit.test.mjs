import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { extractCommitTargets } from "../hooks/lib/bash-commit.mjs";
import { autofixOrBlock, loadToneRules } from "../hooks/lib/artifact.mjs";

function autofixCommand(command) {
  const targets = extractCommitTargets(command).map((t) => ({
    label: "커밋 메시지",
    text: t.text,
    field: "command",
    span: { start: t.start, end: t.end },
    quote: t.quote,
    replaceable: t.replaceable,
    escapeOnWrite: t.escapeOnWrite,
  }));
  const result = autofixOrBlock("Bash", { command }, targets, loadToneRules());
  return result?.hookSpecificOutput?.updatedInput?.command ?? command;
}

function bashAccepts(command) {
  const result = spawnSync("bash", ["-n", "-c", command]);
  if (result.error) return null; // bash를 쓸 수 없으면 건너뛴다는 뜻으로 null
  return result.status === 0;
}

function texts(command) {
  return extractCommitTargets(command).map((t) => t.text);
}

// F1: 다른 명령이 쓰는 heredoc이나 문자열은 커밋 메시지가 아니다.
test("F1: cat 명령의 heredoc은 커밋 메시지로 잡히지 않는다", () => {
  const command = [
    "cat > app.py <<'EOF'",
    "# 컨텐츠 메세지를 처리하는 모듈",
    'print("메세지")',
    "EOF",
    'git add app.py && git commit -m "Add app"',
  ].join("\n");
  assert.deepEqual(texts(command), ["Add app"]);
});

test("F1: 다른 명령의 -m 인자는 커밋 메시지로 잡히지 않는다", () => {
  const command = `python -m "컨텐츠" && git commit -m "Fix"`;
  assert.deepEqual(texts(command), ["Fix"]);
});

test("F1: 커밋하지 않는 echo는 아예 대상이 아니다", () => {
  const command = `echo "예: git commit -m '컨텐츠 메세지 정리'" >> NOTES`;
  assert.deepEqual(texts(command), []);
});

// F2: 같은 문자열이 명령의 다른 자리(예: 경로)에도 나타나면 그 자리는 건드리지 않는다.
test("F2: 경로에 나타난 같은 문자열은 치환 대상이 아니다", () => {
  const targets = extractCommitTargets('git add docs/리팩토링.md && git commit -m "리팩토링"');
  assert.equal(targets.length, 1);
  const command = 'git add docs/리팩토링.md && git commit -m "리팩토링"';
  assert.equal(command.slice(targets[0].start, targets[0].end), "리팩토링");
  // 메시지 자리의 위치가 경로 안의 "리팩토링"이 아니라 -m 값 안에 있어야 한다.
  assert.ok(targets[0].start > command.indexOf('-m "') );
});

// F3: 놓치던 형태들.
test("F3: -am 형태를 잡는다", () => {
  assert.deepEqual(texts(`git commit -am "리팩토링"`), ["리팩토링"]);
});

test("F3: -m\"값\" 처럼 공백 없는 형태를 잡는다", () => {
  assert.deepEqual(texts(`git commit -m"리팩토링"`), ["리팩토링"]);
});

test("F3: -sm 처럼 짧은 옵션을 합친 형태를 잡는다", () => {
  assert.deepEqual(texts(`git commit -sm "리팩토링"`), ["리팩토링"]);
});

test("F3: <<-EOF 와 탭으로 들여쓴 종료 표시를 잡는다", () => {
  const command = ["git commit -F - <<-EOF", "\t리팩토링", "\tEOF"].join("\n");
  // <<- 는 종료 표시 앞의 탭만 인정하는 표시일 뿐, 본문 자체의 탭까지 지워야 할 이유는 없다 —
  // 어차피 검사는 앞뒤 공백에 무관하다.
  assert.deepEqual(texts(command), ["\t리팩토링"]);
});

test("F3: 이스케이프된 따옴표가 있는 메시지를 뽑는다", () => {
  const targets = extractCommitTargets(`git commit -m "\\"컨텐츠\\" 항목의 메세지"`);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].text, '"컨텐츠" 항목의 메세지');
});

// F4: 부분 문자열이라는 이유로 진짜 메시지를 누락하지 않는다.
test("F4: 두 -m 모두 따로 검사한다", () => {
  assert.deepEqual(texts(`git commit -m "컨텐츠" -m "컨텐츠 메세지"`), ["컨텐츠", "컨텐츠 메세지"]);
});

// 양성 시험들.
test("git -C dir commit -m 형태를 잡는다", () => {
  assert.deepEqual(texts(`git -C repo commit -m "리팩토링"`), ["리팩토링"]);
});

test("-F - 로 받는 heredoc 메시지를 잡는다", () => {
  const command = ["git commit -F - <<EOF", "리팩토링", "EOF"].join("\n");
  assert.deepEqual(texts(command), ["리팩토링"]);
});

test("$(cat <<'EOF' ...) 형태에서 Co-Authored-By 트레일러가 있어도 본문만 잡는다", () => {
  const command = [
    `git commit -m "$(cat <<'EOF'`,
    "제목입니다",
    "",
    "본문입니다",
    "",
    "Co-Authored-By: Claude <noreply@anthropic.com>",
    "EOF",
    ')"',
  ].join("\n");
  const targets = extractCommitTargets(command);
  assert.equal(targets.length, 1);
  assert.match(targets[0].text, /제목입니다[\s\S]*Co-Authored-By/);
});

test("커밋하지 않는 heredoc은 건드리지 않는다", () => {
  const command = ["cat > NOTES.md <<'EOF'", "리팩토링과 컨텐츠", "EOF"].join("\n");
  assert.deepEqual(texts(command), []);
});

// 라운드 2, 항목 2: heredoc은 그것을 요청한 명령에만 붙어야 한다.
test("항목2: 같은 줄에서 다른 명령이 먼저 요청한 heredoc과 섞이지 않는다", () => {
  const command = [
    "cat <<A > notes.md; git commit -F - <<B",
    "리팩토링 노트",
    "A",
    "리팩토링 커밋",
    "B",
  ].join("\n");
  assert.deepEqual(texts(command), ["리팩토링 커밋"]);
});

test("항목2: git commit -F - <<EOF && git push 에서도 본문이 git commit에 붙는다", () => {
  const command = ["git commit -F - <<'EOF' && git push", "리팩토링 커밋", "EOF"].join("\n");
  assert.deepEqual(texts(command), ["리팩토링 커밋"]);
});

// 항목 7: -- 뒤는 더 이상 플래그로 읽지 않는다.
test("항목7: -- 뒤의 -m은 플래그가 아니다", () => {
  assert.deepEqual(texts(`git commit -- -m "리팩토링"`), []);
});

// 항목 C: <<-'EOF' 처럼 탭이 종료 표시 앞에 오는 cat heredoc 값도 인식한다.
test("항목C: $(cat <<-'EOF' ...\\tEOF) 에서도 본문만 잡는다", () => {
  const command = [
    `git commit -m "$(cat <<-'EOF'`,
    "리팩토링 커밋",
    "\tEOF",
    ')"',
  ].join("\n");
  const targets = extractCommitTargets(command);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].text, "리팩토링 커밋");
  assert.equal(targets[0].replaceable, true);
});

// 항목 D: 이스케이프가 없는 $VAR/백틱은 원문 그대로 손댈 수 있어야 한다.
test("항목D: 이스케이프 없는 $VAR가 있는 메시지도 자동 교정 대상이다", () => {
  const targets = extractCommitTargets(`git commit -m "리팩토링 $BRANCH 정리"`);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].text, "리팩토링 $BRANCH 정리");
  assert.equal(targets[0].replaceable, true);
  assert.equal(targets[0].escapeOnWrite, false);
});

test("항목D: 이스케이프된 따옴표가 섞인 메시지는 여전히 이스케이프를 다시 씌운다", () => {
  const targets = extractCommitTargets(`git commit -m "\\"컨텐츠\\" 정리"`);
  assert.equal(targets[0].escapeOnWrite, true);
});

// T6: 이스케이프된 문자(\")와 이스케이프되지 않은 $VAR가 한 메시지에 섞여 있으면,
// 되짚어 다시 이스케이프를 씌울 때 $VAR까지 함께 이스케이프되어 원문과 달라진다.
// 이런 뒤섞인 경우는 의도적으로 경고만 하고 자동 교정하지 않는다(위 주석 참고).
test("T6: 이스케이프와 이스케이프 없는 $VAR가 뒤섞이면 자동 교정하지 않는다", () => {
  const command = `git commit -m "\\"컨텐츠\\" $BRANCH 정리"`;
  const targets = extractCommitTargets(command);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].replaceable, false);
  const fixed = autofixCommand(command);
  assert.equal(fixed, command);
});

// 항목 6/B: git commit 앞에 흔히 붙는 것들.
test("항목B: VAR=값이 앞에 붙어도 잡는다", () => {
  assert.deepEqual(texts(`GIT_AUTHOR_NAME=me git commit -m "리팩토링"`), ["리팩토링"]);
});

test("항목B: sudo/env/time/command/nohup 뒤에서도 잡는다", () => {
  assert.deepEqual(texts(`sudo git commit -m "리팩토링"`), ["리팩토링"]);
  assert.deepEqual(texts(`env FOO=bar git commit -m "리팩토링"`), ["리팩토링"]);
  assert.deepEqual(texts(`time git commit -m "리팩토링"`), ["리팩토링"]);
  assert.deepEqual(texts(`command git commit -m "리팩토링"`), ["리팩토링"]);
  assert.deepEqual(texts(`nohup git commit -m "리팩토링"`), ["리팩토링"]);
});

test("항목B: 괄호로 묶은 서브셸 전체 명령도 잡는다", () => {
  assert.deepEqual(texts(`(cd . && GIT_AUTHOR_NAME=x git commit -m "리팩토링")`), ["리팩토링"]);
});

test("항목B: { git commit …; } 도 잡는다", () => {
  assert.deepEqual(texts(`{ git commit -m "리팩토링"; }`), ["리팩토링"]);
});

test("항목B: if …; then git commit …; fi 도 잡는다", () => {
  assert.deepEqual(texts(`if true; then git commit -m "리팩토링"; fi`), ["리팩토링"]);
});

test("항목B: 기본 이름이 git인 경로(/usr/bin/git)도 잡는다", () => {
  assert.deepEqual(texts(`/usr/bin/git commit -m "리팩토링"`), ["리팩토링"]);
});

test("항목B: 백슬래시 줄바꿈으로 이어진 git commit도 잡는다", () => {
  const command = ["git add . && \\", 'git commit -m "리팩토링"'].join("\n");
  assert.deepEqual(texts(command), ["리팩토링"]);
});

test("항목B: out=$(git commit …) 형태의 명령 대입 안도 잡는다", () => {
  assert.deepEqual(texts(`out=$(git commit -m "리팩토링")`), ["리팩토링"]);
});

test("항목B: bash -c '…' 안의 커밋도 잡는다", () => {
  assert.deepEqual(texts(`bash -c 'git commit -m "리팩토링"'`), ["리팩토링"]);
});

test("항목B: sh -c '…' 안의 커밋도 잡는다", () => {
  assert.deepEqual(texts(`sh -c 'git commit -m "리팩토링"'`), ["리팩토링"]);
});

test("100KB 명령도 선형 시간 근처에서 끝난다", () => {
  const filler = "echo hi && ".repeat(5000);
  const command = `${filler}git commit -m "리팩토링 컨텐츠"`;
  const start = Date.now();
  const targets = extractCommitTargets(command);
  const ms = Date.now() - start;
  assert.deepEqual(targets.map((t) => t.text), ["리팩토링 컨텐츠"]);
  console.log(`    100KB 명령 파싱: ${ms}ms (명령 길이 ${command.length})`);
  assert.ok(ms < 500, `100KB 명령 파싱이 ${ms}ms 걸렸다`);
});

test("메시지 안의 $(…)와 ${…}는 명령이라 자동 교정하지 않는다", () => {
  // "$(grep 리팩토링 a.txt)"를 원문 그대로 고치자 grep 의 검색어까지 바뀌었다.
  for (const command of [
    'git commit -m "리팩토링 $(grep 리팩토링 a.txt)"',
    'git commit -m "$(echo 리팩토링)"',
    'git commit -m "${X:-컨텐츠} 정리"',
  ]) {
    const [target] = extractCommitTargets(command);
    assert.ok(target, command);
    assert.equal(target.replaceable, false, command);
  }
  // 이스케이프도 명령 치환도 없는 $VAR 는 여전히 원문 그대로 고칠 수 있다.
  const [plain] = extractCommitTargets('git commit -m "리팩토링 on $BRANCH"');
  assert.equal(plain.replaceable, true);
});

// 라운드3 항목1: -c 탐지를 sh/bash/zsh/dash 의 다양한 옵션 형태로 넓힌다.
test("항목1: sh -c \"'…'\" 이중 밖·작은따옴표 안 스크립트도 잡는다", () => {
  const command = `sh -c "git commit -m '컨텐츠 메세지 정리'"`;
  assert.deepEqual(texts(command), ["컨텐츠 메세지 정리"]);
});

test("항목1: bash -lc '…' 결합 옵션도 잡는다", () => {
  assert.deepEqual(texts(`bash -lc 'git commit -m "리팩토링"'`), ["리팩토링"]);
});

test("항목1: bash -ec '…' 도 잡는다", () => {
  assert.deepEqual(texts(`bash -ec 'git commit -m "리팩토링"'`), ["리팩토링"]);
});

test("항목1: bash -l -c '…' 처럼 옵션이 따로 떨어져 있어도 잡는다", () => {
  assert.deepEqual(texts(`bash -l -c 'git commit -m "리팩토링"'`), ["리팩토링"]);
});

test("항목1: bash -c \"git commit -m \\\"…\\\"\" 이중따옴표 스크립트도 잡는다", () => {
  const command = `bash -c "git commit -m \\"컨텐츠\\""`;
  const targets = extractCommitTargets(command);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].text, "컨텐츠");
  // 이스케이프(\\")는 값을 감싼 따옴표 자리에만 있고, 실제로 바뀔 구간("컨텐츠") 자체에는
  // 없다 — 그 구간의 바깥 글자와 안쪽 글자가 정확히 같으므로 안전하게 자동 교정할 수 있다.
  assert.equal(targets[0].replaceable, true);
  assert.equal(command.slice(targets[0].start, targets[0].end), "컨텐츠");
});

test("항목1: bash -c 이중따옴표 스크립트에서 안쪽 값이 이미 위험하면(명령 치환) 경고만 한다", () => {
  // 안쪽에서 뽑은 -m 값 자체가 $(...) 를 품고 있어 원래도 자동 교정하지 않는 대상이다.
  // 바깥 매핑이 안전해도 안쪽이 위험하면 전체가 위험하다 — replaceable 은 두 조건의 AND다.
  const command = `bash -c "git commit -m \\"$(grep 컨텐츠 a.txt)\\""`;
  const targets = extractCommitTargets(command);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].replaceable, false);
});

test("항목1: 자동 교정 결과가 sh -c 경우 메시지만 바뀌고 bash -n 으로도 유효하다", () => {
  const command = `sh -c "git commit -m '컨텐츠 메세지 정리'"`;
  const fixed = autofixCommand(command);
  assert.equal(fixed, `sh -c "git commit -m '콘텐츠 메시지 정리'"`);
  const ok = bashAccepts(fixed);
  if (ok !== null) assert.equal(ok, true, fixed);
});

test("항목1: 자동 교정 결과가 bash -lc 경우 메시지만 바뀌고 bash -n 으로도 유효하다", () => {
  const command = `bash -lc 'git commit -m "컨텐츠"'`;
  const fixed = autofixCommand(command);
  assert.equal(fixed, `bash -lc 'git commit -m "콘텐츠"'`);
  const ok = bashAccepts(fixed);
  if (ok !== null) assert.equal(ok, true, fixed);
});

test("항목1: 안쪽 값에 명령 치환이 있으면 bash -c 이중따옴표 경우에도 원문을 그대로 둔다", () => {
  const command = `bash -c "git commit -m \\"$(grep 컨텐츠 a.txt)\\""`;
  const fixed = autofixCommand(command);
  assert.equal(fixed, command);
});
