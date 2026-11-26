# Ponytail review of the committed change

Review the change this run committed like the senior developer who will be paged when it breaks. Order of importance: correct, safe, holds under load, tested, fast, lean. Read-only: never modify files, commit, or post anywhere. Try anything you need in a scratch worktree (`git worktree add --detach "$(mktemp -d)" HEAD`, removed when you are done), and before running anything there, install its dependencies with the project's own package manager in locked mode, never updating a lockfile.

If the `ponytail-review` skill is available, use it for this review. If it is not, apply the checklist below yourself; it is the same review.

The accepted work order (for the loop, followed by the builder's report):

$INPUTS.work_order

If the builder's report has `COMMIT: none` or `PUBLISH: no`, nothing will be published: write "Nothing to review: <the reason>" to `$ARTIFACTS_DIR/ponytail-review.md` and declare `findings`: false.

## What to review

The diff is this branch's commits over its base. When the work order names a pull request this run continues, its base is that pull request's: `gh pr view <url> --repo <owner/repo of origin> --json baseRefName`. Otherwise it is `$BASE_BRANCH`. Fetch `origin <base>` and read `git diff origin/<base>...HEAD`. For a pull request this run continues, judge what this run's commits change. Judge the change against the work order only; do not broaden into unrelated cleanup.

Read the connected code, not only the diff. When `graphify-out/graph.json` exists in the checkout, find it with `graphify affected "<symbol>"` for each changed symbol and `graphify query "<the change in a few words>"` (or the graphify skill), and name the graph results you used in your report; when the file is missing, say so there and go on. Read the callers of every changed function, the functions it calls, the tests. When a signature, a return value or a behavior changes, grep every caller. Find the expected load in the repository (README, deploy config) and judge scale against it.

Look for, in this order:

1. **Bug:** a wrong result, a crash, a missed edge case (empty, zero, last item, rounding, time zones), a caller the change breaks, a fix in one caller while the shared code stays broken.
2. **Risk:** a security hole (injection, weak randomness, secrets, unchecked input from users), data loss (a swallowed error, writes in the wrong order, no transaction).
3. **Scale:** fine for one user, wrong for many: check-then-write races, the same work done by every process, state or lists that only grow, a query per item.
4. **Tests:** new non-trivial logic (a branch, a loop, a parser, money or security) without a test that would fail if it broke.
5. **Speed:** needless work on a hot path.
6. **Lean:** code the outcome does not need: an option, a wrapper, an abstraction or a fallback nobody asked for, a reimplemented helper the repository already has, code that a deletion or the standard library replaces.

Report only what the code proves. Line count alone is not a finding; a smaller shape must keep the behavior and its tests.

## Output

Write `$ARTIFACTS_DIR/ponytail-review.md`: one entry per finding with its kind (bug, risk, scale, tests, speed, lean), `file:line`, what goes wrong in plain words, the input or state that shows it, and the smallest fix. Then a short list of what you checked and found clean. Verify every cited `file:line` is real.

Reply with one line pointing to the report and the findings count. Declare `findings`: true exactly when the report holds at least one finding.

## Processes

Stop only processes this node started, by the process ID it recorded; never kill by name. Give every wait a timeout. Before you finish, stop every process you started that is still running.
