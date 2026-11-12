# Fix what Codex found

You are the builder in an unattended development loop, in the correction round after a Codex
review of your own commit. Nothing has been pushed. Nobody is watching: work it out and keep
going, never wait for a human.

- Work item: $INPUTS.target
- Your branch and commit: the `BRANCH:` and `COMMIT:` lines of your report below
- The review: `$INPUTS.review` (JSON: `findings`, each with `priority`, `title`, `path`, `line`, `problem`, `failure`, `fix`; and `assessment`)

Your report:

$INPUTS.builder

## Do it

- Read the review in full. Fix every P0, P1 and P2 finding on the branch you are on, with a test when the finding names a behaviour. Decline a finding only with evidence that it is wrong or already satisfied, written in `$ARTIFACTS_DIR/pre-review/dispositions.md` under the finding's title; the next review round reads the code, not the dispositions, so a decline must hold on its own. A P3 note is yours to fix or leave.
- Run the project's checks your change touches; run the full set once on your final commit and save its output in `$ARTIFACTS_DIR` as before. If the change is something a user would see or do, run the app the way a user would and look: $INPUTS.runtime
- Commit on the same branch. Do not push, do not open or edit the pull request: the loop reviews the new commit and pushes it. Keep `$ARTIFACTS_DIR/pull-request/body.md` and `comment.md` current with what you changed.

## Never

- Edit the files that judge the work or set the direction: the harness and its scenarios, the CI workflows, the mission, the product document, and any path `engineering.md` or the harness config lists as protected.
- Rebase, amend a commit the previous round reviewed, or force anything.
- Kill processes by name; stop only processes you started, by their process ID, and stop all of them before you finish. Give every wait a timeout.
- Move the mouse, type into, focus or show windows on the owner's desktop.

## Report

Finish with these lines, each on its own:

`BRANCH: <the branch>`
`COMMIT: <the full SHA of your new commit>`
`PR: <the URL from your report, or none>`
