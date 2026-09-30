# A verified goal version runs: the skeleton package, the smoke gate and the verifier's leads

Date: 2026-09-29. Status: design approved in conversation, awaiting the operator's read of this file.
Builds on the conductor spec (`2026-09-27-conductor-supervisor-design.md`, Plans 1–5 on main). First of
the follow-ups from the first real conducted project; the Supervisor-as-conductor (routing hand-offs) and
the human cards (closing questions, actions) are separate specs that come after this one.

## 1. Why

On 2026-09-29 a real goal ("self-hosted SSH key and TLS certificate management platform", 18
requirements) was conducted from scratch and watched without intervention
(`/home/meren/slaveofai-logs/observations.md`). It was partitioned into six packages, every package
passed review, the verifier passed 18/18 in one round, and the version was merged into `main`
(≈ 77 minutes, ≈ $30). Then the product was started exactly as its README says:

- `docker compose up --build` builds, but the app crash-loops: `Missing script: "start"` (the start
  script belongs in `backend/package.json`, owned by another package; the integration worker reported
  "the production Docker image cannot start" and nobody acted).
- Started by hand, it serves the API only: the image has no frontend build stage.
- Every write returns `403 license_locked`; no licence can ever be issued (placeholder vendor key).

The per-task gate checked nothing until the last package (`scripts/verify.sh` was empty: the intake's
template tells every task to extend it, the conductor gave it to the integration package, which runs
last). The verifier checked "self-hosted" with `grep` and `docker compose config -q`, never starting the
image. The conductor split `backend/package.json` from its lockfile (a guaranteed ownership violation;
the worker dropped the lockfile to pass the audit), gave one package the migrations directory, and left
the HTTP server and all wiring to the package with no requirements that runs last and receives none of
the hand-offs.

"Verified" must mean "it runs". This spec makes that true for both delivery shapes.

## 2. Operator rulings (2026-09-29)

1. Scope of this spec: verification and the skeleton first; the Supervisor as conductor and the human
   cards follow in their own specs.
2. "It runs" means: the product starts through its **documented path** (Docker if the README says
   Docker) **and one basic user flow works end to end** (for example: sign in, add a record, see it in
   a list).
3. The run check is written by the project **and** checked independently: a skeleton package writes
   `scripts/smoke.sh`, the orchestrator runs it deterministically before verification (no model), and
   the verifier also tries the documented path itself and does not take `smoke.sh` on trust.
4. Approach: a **skeleton package first** in every partitioned goal; shared registration points use a
   **file-per-package** layout; the integration package still runs last.

## 3. Requirements

**S1 — The skeleton package.** `skeleton` is a reserved package key (like `integration`). A partitioned
conduct answer is valid only with a `skeleton` package; if the conductor names none, the validator
creates it (its requirements: none of the goal's; its paths: the ones S2 lists that no package claims),
with the first package's persona, the way it creates `integration`. Every other package, `integration`
included, depends on `skeleton`; `skeleton` depends on nothing. `skeleton` owns the application entry
point and server bootstrap, every dependency manifest **with** its lockfile (S2), build/start/deploy
files, `scripts/verify.sh`, `scripts/verify.d/skeleton.sh`, `scripts/smoke.sh`, and the loader files of
the shared registration points (S3). Its job, stated in its prompt: a runnable empty product that
`smoke.sh` proves runs, with every dependency the goal needs already declared.

**S2 — A manifest and its lockfile have one owner.** The package validator refuses a plan that puts a
manifest and its lockfile in different packages: `package.json` with `package-lock.json`,
`npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`/`bun.lock`; `pyproject.toml` with
`uv.lock`, `poetry.lock`, `pdm.lock`; `Pipfile` with `Pipfile.lock`; `Cargo.toml` with `Cargo.lock`;
`go.mod` with `go.sum`; `Gemfile` with `Gemfile.lock`; `composer.json` with `composer.lock` — in the same
directory, whether the lockfile exists yet or not (a path matched by a glob counts). The refusal names the
pair and counts toward the existing conduct retry cap.

**S3 — Shared registration points are file-per-package.** The conductor prompt and each package's
contract state the layout, and the validator checks the part it can:
- verification: `scripts/verify.sh` runs every `scripts/verify.d/*.sh` in name order and fails on the
  first failure; each package owns exactly its own `scripts/verify.d/<package-key>.sh` (the validator
  adds that glob to every package's owned paths and refuses a plan that gives it to another package);
- database migrations and similar ordered directories: a package owns only files whose names start with
  its own prefix (the conductor names the directory and the prefix in the package's interface), never
  the whole directory;
- route, plugin and job registration: each package adds its own registration file under a directory the
  skeleton loads; the skeleton owns the loader, not the entries.
A plan that gives a whole shared directory to one package while another package's interface says it
writes there is refused with that reason.

**S4 — The intake's gate scripts.** The intake's first commit writes `scripts/verify.sh` as the S3 runner
(empty `verify.d/` → prints "no checks yet" and exits 0) and a `scripts/smoke.sh` stub that exits 2 with
"smoke not written yet". The template header no longer says "a task extends this script"; it says "add
your own `scripts/verify.d/<package>.sh`" (partitioned) or "add your checks to `scripts/verify.d/`"
(single). The smoke contract (S5) is written into the template.

**S5 — The smoke contract.** `bash scripts/smoke.sh` from the repository root: starts the product through
the path the README documents, runs one basic user flow end to end against it, stops everything it
started, and exits 0 only if the flow worked. It receives `SLAVEOFAI_SMOKE_PROJECT` (a unique name to use
for any compose project / container name prefix) and must not publish on fixed host ports it did not
check are free. It prints what it did. The skeleton's prompt (or the single worker's) carries this
contract; in single mode the one package owns and writes it.

**S6 — The RUN requirement.** Every requirement set gains one requirement after extraction, key `RUN`,
text "The product starts through the path its README documents and one basic user flow works end to
end.", source "added by Slave: a verified version must run". It is never merged away by key stability
across versions. Owner: the `integration` package when partitioned, the single package otherwise. The
verifier checks it like any other requirement (S8).

**S7 — The smoke gate.** When every package of a goal version is integrated and before the verification
run is dispatched, the orchestrator runs `bash scripts/smoke.sh` in a fresh detached worktree of the
integration branch tip, without a model:
- bounded by `Workspace.smokeTimeoutMs` (default 15 minutes); the process group is killed on timeout
  and the worktree is removed afterwards, pass or fail;
- the same constrained environment a run gets (allow-listed env, own process group), plus
  `SLAVEOFAI_SMOKE_PROJECT`;
- recorded as one event per attempt (`workspace.smoke_run` with exit code, duration and trimmed
  output), shown on the report page;
- pass → the verification run is dispatched as today, and the smoke output is handed to the verifier as
  evidence (S8);
- the script missing, not executable, or exiting 2 with the stub's message → the `skeleton` package's
  task goes back to rework (single: the single task) with the output;
- any other non-zero exit or a timeout → the `integration` package's task (single: the single task)
  goes back to rework with the trimmed output;
- each failed smoke attempt counts as a verification round against the same round cap; at the cap the
  version ends `needs_human` with the smoke output in the reason. A smoke that cannot even start (the
  orchestrator's own failure: worktree, spawn) is retried like an unusable verification (Plan 4b D7),
  not charged to a package.
- user ruling 2026-09-30: when the integration package's smoke rework ends with a report whose
  `handOff` names a file the ownership rule gives to the `skeleton` package (e.g. `Missing script:
  "start"` in a skeleton-owned `package.json`), the same smoke failure is routed to the skeleton for
  rework — checked against the skeleton's owned paths, never taken on the worker's claim; it spends no
  further verification round; at most one hand-off per smoke attempt (no ping-pong); recorded as
  `workspace.smoke_handed_off` and shown on the report page and in the Markdown export. No hand-off in
  single mode; a path owned by another package, an unowned path, or no path behaves as before.

**S8 — The verifier's leads.** The verification prompt gains a section "Reported by the workers" with, per
package, the trimmed `questions` and notes of its latest `<slave-report>` (sanitised, capped), framed as
leads to check, never as evidence. It also carries the passing smoke output. The protocol gains one rule:
"For RUN, start the product through the documented path yourself and run a basic flow; `smoke.sh`
passing is not enough on its own."

**S9 — A denied tool call does not fail a finished run.** A run that concluded with its report and passed
its verify command is not marked failed because one of its tool calls was denied; the denial stays
recorded (the `run.tool_denied` / guardrail event) and is listed on the report page.

## 4. What changes for existing behaviour

- Partitioned plans gain a package and a dependency on it; the first ~minutes of a partitioned version
  build a runnable skeleton before any feature package starts.
- The requirement count grows by one (`RUN`) for every new goal version; existing versions are not
  rewritten.
- A version is accepted only after a passing smoke and a verifier `pass` on `RUN`.
- Projects created before this spec keep their `scripts/verify.sh`; their next goal version still gets
  `RUN` and the smoke gate. A missing `scripts/smoke.sh` there sends the skeleton (or single) task back to
  write it — stated in the rework reason so the worker knows why.
- Planned (non-conducted) delivery is unchanged.

## 5. Data and interfaces

- Domain: `SKELETON_PACKAGE_KEY`; `validatePackages` gains S1/S2/S3 checks and the skeleton fallback;
  `MANIFEST_LOCK_PAIRS`; the `RUN` requirement builder; verification prompt sections (leads, RUN rule);
  smoke outcome classification (stub / failed / timed out / passed).
- Intake: the new bootstrap `verify.sh` runner, the `smoke.sh` stub, the template text.
- Orchestrator: the smoke gate between "every package integrated" and verification dispatch
  (`apps/orchestrator/src/verification.ts` / `goal.ts`), its worktree and process handling (reusing the
  verification worktree helpers), the rework routing, the run-conclusion change (S9).
- Prisma: `Workspace.smokeTimeoutMs Int @default(900000)`; the `workspace.smoke_run` event type (+ lane,
  activity card, timeline title, m56a counts). Hand-written additive migration.
- Web: the smoke attempts and denied tool calls on the goal report page and in the Markdown export.

## 6. Test plan (headline cases)

- S1: a partitioned answer with no `skeleton` gets one; every other package depends on it; a plan where
  `skeleton` depends on something is refused.
- S2: `backend/package.json` in one package and `backend/package-lock.json` in another → refused naming
  the pair; both in one package → accepted; a glob that covers both counts.
- S3: a plan that gives `backend/migrations/**` to one package while another's interface writes a
  migration → refused; each package owns its own `scripts/verify.d/<key>.sh`.
- S4: a new intake's first commit has the runner and the stub; the runner passes with an empty
  `verify.d/` and fails on the first failing script.
- S7: with the fake CLI and a scripted `smoke.sh` — pass → verification dispatched; stub → skeleton
  reworked; exit 1 → integration reworked with the output; timeout → integration reworked, process group
  gone; cap → `needs_human` with the smoke output. The real project's class pinned: a Docker-style smoke
  that fails with `Missing script: "start"` reworks integration.
- S6/S8: `RUN` is in every new set and survives a goal change; the verifier prompt carries the leads
  section and the RUN rule; a report's "the Docker image cannot start" appears in it.
- S9: a run with a denied tool call, a valid report and a passing verify concludes succeeded; the denial
  is on the report page.
- End to end (fake CLI): a partitioned goal whose smoke fails once and then passes is accepted with `RUN`
  pass; a single goal with a passing smoke is accepted.

## 7. Risks

- **Smoke scripts are worker-written code run by the orchestrator.** Mitigated by the run's constrained
  environment, its own process group, the timeout and a unique project name; they are still arbitrary
  code on the host, as verify commands already are.
- **Docker-based smoke is slow** (image builds). The 15-minute default and per-workspace setting bound
  it; a failed smoke costs a round.
- **A skeleton that must declare every dependency up front** can guess wrong; a feature package that
  needs a new dependency still has no remedy here — that is the shared-file / Supervisor spec's problem,
  and the rework reason says so plainly.
- **A worker can write a trivial smoke.** The verifier's own RUN check (ruling 3) exists for that.
