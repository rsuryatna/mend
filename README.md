# mend: one patch tool for every AI edit format

[![mend](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/rsuryatna/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/rsuryatna/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats: a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
JSON. `mend` reads all four to one written specification, finds the lines each
edit names even when the model drifted their whitespace or indentation, and
changes every file or none.

Built for the [make.fun bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
"Build mend, one patch tool for every AI edit format". `SPEC.md` is the whole
contract.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the path of the patch file, relative to the working directory. When
  `PATCH` is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without
  it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

Exit codes: 2 on a usage, no-patch, format or parse error; 1 when any edit
failed (nothing is written); 0 when the tree is written.

## Matching

An edit's old lines are found at the first of three tiers at which they occur
at least once: tier 0 (every line equal), tier 1 (trailing spaces and tabs
removed from both), tier 2 (leading and trailing spaces and tabs removed from
both, with the new lines re-indented to the file's indentation). With
`--strict` only tier 0 is tried. A strict applier fails every check that needs
tier 1 or 2; `mend` does not.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone, run as
  `node main.ts [options] [PATCH]`. Its last lines hand a trial over to
  `runner.ts` when `MAKEFUN_ENV_URL` is set: keep them.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env,
  runs `node main.ts` on each one in a fresh directory, and posts what
  `main.ts` did (its exit code, its stdout and the files left in the directory).
- `check.ts`: the practice set on your own machine. The kit carries it at
  `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json

  It prints every check `main.ts` gets wrong, with what differed, and the
  practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## A check

A check is one run: its arguments, its standard input and the files it starts
with. It passes when the exit code, everything written to stdout and every file
afterwards are exactly what SPEC.md says. Standard error is never compared.
Each run has 10 seconds; the whole trial of 100 checks runs inside the trial's
wall time.

## Verification

    node check.ts <practice.json>   # 100 of 100 passed: practice score 1000

plus a hand-built stress suite of edge cases drawn sentence by sentence from
SPEC.md (kinds of check the practice set does not show): ambiguous matches,
empty-O inserts, `\ No newline at end of file`, rename and move, unsafe paths,
CRLF files, JSON array vs JSON Lines, V4A anchors and End of File, path
detection in SEARCH/REPLACE blocks, nearest-position unified hunks, and the
command-line error order.
