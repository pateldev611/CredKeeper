# CredKeeper
### Local-only secret leak detection for data teams

**Track:** Build, Break, Fix — Track B (Developer Productivity)
**Version:** 0.1.0 · **Publisher:** tredence-csw-hackathon

---

## The problem

Data and analytics teams handle client credentials every day — Snowflake, Databricks,
Azure, AWS, database passwords. These secrets leak into Git through paths standard
scanners don't look at: **notebook outputs**, **error tracebacks**, and copies of `.env`
values pasted somewhere else. A single leaked client credential means emergency key
rotation, a security incident, and a client trust conversation.

**The "clean" notebook, in five steps:** a developer stores a password correctly in
`.env` → debugs a connection failure with `print(config)` → fixes the bug and deletes the
`print` line → the notebook *file* still holds the saved cell output, password included →
commits it. The code looks clean. The password is in Git history anyway.

## What CredKeeper does

- **Warns while you type** — red/yellow squiggles within ~300ms, in code, config files,
  and notebook cells.
- **Reads notebook outputs** — a password printed by a cell is flagged even after the
  `print` line is deleted, because the saved output still holds it.
- **Verifies `.env` discipline** — env-aware mode flags your own `.env` values wherever
  else they appear, even custom tokens with no recognizable format at all.
- **Fixes, not just flags** — one-click quick fixes move a secret to an environment
  variable (now in **10 languages**, not just Python — see below), clear a leaking cell
  output, blank a template value, or add a file to `.gitignore`.
- **Blocks the commit** — a Git pre-commit hook stops any commit that still contains a
  secret, checking *every* severity including ones the editor hides by default.
- **Stays on the laptop** — no account, no API key, no network calls, ever. Values are
  masked (max 4 visible characters) in every output, including JSON reports.

## Why it's needed

Every existing tool solves one piece of this:

| Tool | Strength | Gap for data teams |
|---|---|---|
| GitGuardian (ggshield) | 450+ detectors, live-key validation | needs an account, code leaves the laptop |
| gitleaks / TruffleHog | free, fast, good for CI/history | manual, no editor warnings, no fixes |
| GitHub push protection | server-side, zero setup | GitHub-only, last line of defense only |
| NB Defense (Protect AI) | scans notebook code + outputs | separate tool, run by hand, no live warnings |
| **CredKeeper** | live warnings + notebook outputs + env-aware matching + one-click fixes + commit gate, **all local** | fewer pattern rules than commercial tools; no live key-validity check |

**The gap only CredKeeper closes:** pattern-based tools recognize a secret by its shape
(AWS keys start with `AKIA`). A client password like `Blue#Tiger2026` has no shape — they
can't tell it's a secret. CredKeeper knows, because it's sitting in your `.env`, and flags
it anywhere else it shows up.

## By the numbers

- **23** detection rules (20 pattern-based + 3 env-aware/file rules)
- **77** automated tests, **73 passing** (4 skipped — Unix-only specs, this run was on Windows)
- **8/8** security-harness threat categories passing (regex DoS, config poisoning, command
  injection, path traversal, secret leakage by the tool itself, malformed notebooks, and more)
- **Zero** runtime dependencies in the shipped extension
- **~47 KB** `.vsix` size
- **12** file types + notebooks + extensionless `Dockerfile`/`Makefile`/`Jenkinsfile`

## Multi-language auto-fix

The "move this secret to an environment variable" one-click fix used to only work in
Python. It now works in **Python, TypeScript, JavaScript, Java, C#, Go, Scala, R, Shell,
and PowerShell** — each gets the idiomatic syntax for that language (`process.env.NAME` in
TS/JS, `os.Getenv("NAME")` in Go, `Sys.getenv("NAME")` in R, `$env:NAME` in PowerShell,
etc.), with the right import inserted automatically where the language needs one — Go's
`package` clause rules even required special handling so the fix doesn't break the file
by inserting an import before `package`.

## Setup

### Use it (VS Code extension only — fastest path)

```bash
code --install-extension credkeeper.vsix
```

Open a folder, click **Trust** when VS Code asks. That's it — live squiggles, quick fixes,
and the **CredKeeper Findings** view all work immediately. (The `credkeeper` terminal
command needs the steps below.)

### Full setup (editor + commit hook + CLI)

Requires Node.js 18+ and Git 2.30+.

```bash
npm install
npm run build
npm link                         # makes the `credkeeper` command available everywhere

cd your-repo
credkeeper install-hook          # blocks any commit that still contains a secret
credkeeper scan                  # scan the whole repo right now
```

### CI (any pipeline)

```bash
npx credkeeper scan --json > credkeeper-report.json   # exit code 1 fails the build on findings
```

## How to test it (2 minutes)

Each of these is self-contained and takes under a minute — pick any.

**1. Live detection, in any language**
Paste into a new `.py`, `.ts`, or `.go` file and save:
```python
aws_key = "AKIAIOSFODNN7EXAMPLE"   # AWS's own public example key — safe to paste
```
→ Red squiggle within ~300ms: **Critical, R02 — AWS access key ID**.

**2. Multi-language quick fix (this build's new feature)**
On that same line, press `Ctrl+.` → **CredKeeper: Move to environment variable**.
→ The literal is replaced with the language's native env-read call (`os.environ[...]` in
Python, `process.env.AWS_KEY` in TS/JS, `os.Getenv("AWS_KEY")` in Go, `Sys.getenv(...)` in
R, …), the value moves into `.env`, and `.env` is added to `.gitignore` — one undo-able
edit. Try the same paste in a `.ts` and a `.go` file to see the fix adapt per language.

**3. The headline feature — notebook outputs survive deletion**
In a notebook cell: `print({"password": "Test123!"})` → run it → a squiggle appears on the
*cell*, not just the source line. Delete the `print(...)` line and save.
→ The squiggle **stays** — the saved output still holds the password. Only
**Clear this cell's outputs** (Quick Fix) removes it. This is the exact "clean notebook"
scenario from the problem statement above, reproduced in real time.

**4. CLI + CI gate**
```bash
mkdir demo && cd demo
echo 'password = "SuperSecret123!"' > app.py
credkeeper scan
echo "exit code: $?"
```
→ Prints the masked finding (`SuperSecret123!` → `Supe************`) and exits `1`.

**5. The commit gate**
```bash
credkeeper install-hook
git init -q && git add app.py
git commit -m "test"
```
→ Commit is **blocked**, listing file, line, rule and fix, values masked. Fix the secret
(or apply the quick fix) and commit again — it goes through.

**6. Prove it's hardened (relevant for Day 2 — Break)**
```bash
npm run harness
```
→ Prints the 8-threat security harness table (regex denial-of-service, poisoned config,
command injection, path traversal, secret leakage by the tool itself, malformed notebooks,
and more) — every row should read `PASS`.

## Known limits (by design, not oversights)

- Git **history** is not scanned — only the working tree / staged index. A secret already
  pushed must be rotated, not just deleted.
- Values are matched as whole tokens — a secret split across lines or base64-encoded won't
  be caught (yet — see roadmap).
- `.env` values under 8 characters aren't tracked, so the salted hashes used for env-aware
  matching can never be brute-forced back to the original value.

## Roadmap

One-click **Install Commit Protection** (no terminal needed) → npm package + CI templates
for Databricks/browser-Jupyter → JupyterLab extension → Git history scanning → opt-in
(off-by-default) live key-validity checks.
