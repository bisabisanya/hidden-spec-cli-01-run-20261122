[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bisabisanya/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bisabisanya/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats,
and this one tool reads them all: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the
V4A patch format, and text-editor tool calls as JSON. Each format is read as `SPEC.md` says, and every file
is changed or nothing is.

Run it as:

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is the patch file, or standard input when absent or `-`. `--format` picks one format
(`unified`, `search-replace`, `v4a`, `json`); `auto`, the default, detects it. `--check` does everything
but write. `--strict` matches lines exactly. Node 22 and its standard library alone; no network, no
dependencies, deterministic.

## The files

- `main.ts`: the CLI. The command line, output and exit codes, safe paths, format detection, the three
  line-matching tiers (exact, trailing whitespace, both ends), unified diffs, SEARCH/REPLACE blocks, V4A
  patches, JSON edits and the all-or-nothing write.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env, runs `node main.ts` on each
  one in a fresh directory, and posts what main.ts did.
- `check.ts`: the practice set on your own machine:

      node check.ts ../kit-mend/hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json

  It prints every check main.ts gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification. It is the whole contract.
- `LICENSE`: MIT.

## Practice score

100 of 100 passed: practice score 1000 (kit's `program/generator/practice.json`).
