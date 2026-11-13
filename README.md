# Conversation Archive for GitHub Copilot

A **legacy Copilot plugin**, not a copy of your Copilot profile. New sessions in
verified **private GitHub working repositories** automatically capture recorded
conversation history and session-created/modified output files to the configured
**private archive repository**. No per-conversation or per-file approval is needed.
Background sync runs asynchronously every **five minutes**, without success chatter.

The plugin includes an SDK extension, a dependency-free setup/import CLI, and
synthetic tests. When opening your private archive repository, its verified GitHub
`origin` and `main` are the defaults: **no destination setup is required on a new
machine**. New interactive conversations automatically show saved conversations
from that repository, labeled with their first user message. Choose one to restore,
or choose **Start fresh**. Resume/reload does not repeat the startup picker.
Public repositories, missing origins and unverifiable privacy fail closed.

## Requirements and supported installation

- Node.js 22+, Git, `gh`, and GitHub Copilot CLI/app with SDK extensions,
  `joinSession`, command registration and `getEvents`. Interactive elicitation is
  needed only for optional manual consent/file registration and the import picker.
- This package was checked with Node 26.13.0, CLI plugin installation/discovery
  on `1.0.106-8.unstable.r43162459260.gbfc9f50`, and an actual no-model SDK
  extension launch on npm runtime `1.0.98-2` using the installed app SDK.
- Extension APIs are version-sensitive. Automatic capture does not require
  interactive elicitation, including in headless private-repo sessions.
  Real-runtime loading, fail-closed unverified-workspace behavior and resume/reload
  are checked without model calls. Real private-repo uploads remain a manual check.
- Both users need access to the same private archive repository. Each signs in
  independently to GitHub, Copilot, and any MCP data sources. Tokens, MCP server
  configuration, and Copilot settings are not copied between machines.

Extract the ZIP into a short, user-owned path, for example
`C:\Tools\conversation-archive`. The extracted folder containing `plugin.json`
is the plugin root.

For CLI testing **without installing into your existing profile**:

```powershell
copilot --plugin-dir C:\Tools\conversation-archive
```

For persistent CLI installation, explicitly run:

```powershell
copilot plugin install C:\Tools\conversation-archive
copilot plugin list --json
# Or install/update the published source:
copilot plugin install boddev/copilot-shared-conversation
```

The actual CLI accepted local-directory installation during validation. That
CLI also warns that direct installs may be deprecated in a future release.
This package does not publish a marketplace or invent an install URL.

For a host that supports user extensions but does not expose local plugin
installation, copy **only** `extensions\archive` to
`$env:USERPROFILE\.copilot\extensions\conversation-archive` and restart the host.
This is the documented SDK user-extension discovery format; do not copy the
whole plugin into a user-extension directory. Managed policy may disallow
standalone extensions: use the plugin installation route when required.
The host may ask permission to register extension hooks. That approval is
separate from archive configuration. Declining hook approval prevents the
extension from loading; the plugin never bypasses host trust or managed policy.

## Repository defaults and optional configuration

Install the plugin, clone/open your **private archive repository** in the Copilot
app, and start a new conversation. The plugin discovers the repository from the
session's working directory, verifies its private GitHub origin, and lists its
saved conversations automatically. `/archive-load` opens the picker again at any
time; you do not have to run `/archive-list` or enter an archive repository first.
The only destination question during loading is for a **new local restore folder**,
not the GitHub archive destination. Its parent must exist; existing files are never
overwritten. MCP sign-ins remain your own.

For capture, an existing machine-wide configuration still takes precedence.
Without one, the current verified private repository on `main` is used.
The conversation picker always reads the **current repository**, not a different
machine-wide capture target. An explicit branch override is honored when the
configured target is this same repository.

When reading `main`, the picker also discovers native checkpoints still on the
legacy `archive` branch. Choices show their branch; if a conversation exists on
both, the `main` copy takes precedence. Selecting a legacy conversation restores
its actual recorded history and artifacts from that branch, without moving or
rewriting either branch. Standalone import by session ID supports the same
legacy lookup. New captures still publish only to the configured branch (`main`
by default).

Ordinary files, including Markdown exports such as `conversations/report.md`,
do not block archive discovery or publication. They remain untouched in Git.
Markdown exports alone are not native recorded conversations and are not
presented as complete history; the picker lists validated native checkpoints.
If `main` contains only Markdown exports and `archive` contains the original
recorded session, the original session is what appears in the picker.

If you work in a separate source repository, or use the standalone recipient CLI,
you can configure a dedicated **private archive** target with the commands below.
Listing, import and publication check out only native archive paths; publication
preserves the rest of the repository's existing tree in the Git index. Unrelated
source, Markdown documents, configuration and attribute files are never executed
or materialized in the disposable Git workspace. The plugin neither creates a
repository nor accepts public targets. Conversations commit directly to
**`main`** by default, including
the first commit to an empty repository. A repository initialized with `README.md`
is supported: its README and existing commits are preserved. No per-conversation
remote branches or separate `archive` branch are created.

```powershell
gh auth login
gh auth setup-git
node C:\Tools\conversation-archive\archive.mjs configure --repo OWNER/REPO
```

Replace `OWNER/REPO` with your predetermined archive. Setup verifies PRIVATE
visibility with `gh repo view`, writes only destination configuration, and
does not inspect conversation history or upload anything. Git uses your normal
credential helper. No credentials are stored by this package.

Existing installations configured for `archive` should rerun the configure
command above once (without `--branch`) to select `main` for new conversations.
Saved history on the old branch remains discoverable and is not moved, deleted
or overwritten. Existing
sessions with an old destination binding fail closed rather than silently
redirecting pending checkpoints; start a new conversation after switching.
An explicit `--branch NAME` override remains available if you intentionally
want a different archive destination. Changing this setting affects only the
archive repository, not your working repository's checked-out branch.

State lives separately in `~\.copilot-conversation-archive`, not in a working
repository or this plugin package. For a different location, set
`COPILOT_ARCHIVE_HOME` **before starting both CLI/setup and the Copilot host**;
`--root` selects the same location for standalone CLI operations only.

```powershell
$env:COPILOT_ARCHIVE_HOME = 'C:\ArchiveState'
node C:\Tools\conversation-archive\archive.mjs configure --repo OWNER/REPO --root C:\ArchiveState
copilot --plugin-dir C:\Tools\conversation-archive
```

Do not version-control that state folder. A changed target/branch, working
repository or output scope invalidates an existing session's automatic state.
Start a new session after reconfiguration; frozen history is never silently
redirected. Resume/reload preserves the original output baseline and opt-out.
Existing 0.1.0 sessions keep their saved manual decision and file approvals;
start a NEW session for automatic output capture. Resuming a session without a
baseline does not retroactively capture unrelated files.

The working repository is resolved from the startup directory and its `origin`
(credential-free github.com HTTPS or Git SSH URL), then checked with `gh repo view`.
Both it and the archive destination must be PRIVATE. Each sync rechecks privacy
and scope; public visibility, changed origin or verification errors stop uploads.

## Commands in an interactive conversation

| Command | Behavior |
| --- | --- |
| `/archive-status` | Show capture mode, five-minute scheduler, configuration and persistent pending count. |
| `/archive-consent` | Optional manual override: ask for consent, switch to explicit file approval, discard local frozen pending checkpoints. Not needed for new private-repo sessions. |
| `/archive-artifact` | Optional explicit approval for one output outside automatic roots, or for legacy/manual sessions. |
| `/archive-sync` | Retry frozen pending checkpoints in order, then capture/upload current recorded history. |
| `/archive-stop` | Stop this session, discard pending local exports and approvals; published Git history remains. |
| `/archive-list` | List saved conversations from the current verified private GitHub repository, including legacy `archive` checkpoints when reading `main`, without archive setup. |
| `/archive-load` | Open that repository's conversation picker directly, then restore a checkpoint into a new local directory. Also offered automatically on new interactive sessions when archives exist. |

Automatic checkpoints use a five-minute timer, **not completed-turn uploads**.
The timer starts after privacy verification and baseline initialization; no
immediate upload occurs. Async file/Git operations do not block conversation
turns, and overlapping ticks are skipped. Unchanged checkpoints are not repushed.
Successful background sync is quiet; failures and new omission warnings remain
visible. `/archive-sync` is optional immediate sync/retry, not a workflow requirement.
Closing a session before its next tick may leave up to five minutes unsynced;
there is no guaranteed exit flush. The plugin never rewrites model prompts.
The agent-only `conversation_archive_search` tool can search data the human
has already selected with `/archive-load`; it cannot consent, register files,
or export the active session.

## What is actually archived

Each immutable content-addressed checkpoint contains:

- `history.jsonl`: ordered actual portable user/assistant messages and tool
  start/completion events, stable IDs, tool arguments/results, and recorded MCP
  source names. Recorded calculation decisions/UI changes remain in messages
  and tool results; a summary is not substituted for those records.
- `transcript.md`: readable rendering of that same sanitized history.
  Long readable previews link/reference full structured payloads.
- `blobs\`: full sanitized large event payloads, with SHA-256 references.
- `artifacts\`: actual automatically scoped outputs or explicitly approved bytes,
  with SHA-256 hashes and original relative source names in the manifest.
- `manifest.json`: file hashes, output coverage, redactions/omissions and
  unavailable material; `READ-ME-FIRST.txt`: recipient entry point.

Only the four message/tool event families are exported. System/developer
prompts, hidden instruction events, private reasoning, opaque provider state,
credentials, telemetry and unrelated Copilot directories are excluded.
Available recorded context is not literally all runtime context: unrecorded,
truncated or absent results cannot be recovered. Separate agent/session
histories not returned by this session's SDK API are not implicitly collected.
Attachments are listed with unavailable-byte status until explicitly approved
as artifact files; absolute attachment paths are not mistaken for exported bytes.

At startup the plugin fingerprints the working repository tree and the SDK's
current session `files` directory. Later scans capture newly created files and
files whose content changed from that original baseline. Unchanged existing
files and timestamp-only touches are excluded. The baseline persists on reload;
subsequent changed revisions are captured automatically without reapproval.
This is a workspace-change boundary, not perfect process attribution: other
programs modifying files in the same roots during the session are also in scope.
Use isolated worktrees when sessions should not share outputs.

The repository's reserved `conversations` archive tree is not recaptured as
generated output after a pull, preventing nested copies of other conversations.
Only the current session's `files` tree is admitted from runtime storage, even
when nested under the repo. Other session-state trees, Git internals, dependency
trees, credentials/configuration, symlinks/junctions and archive state are excluded.
Nothing outside these roots is crawled; use `/archive-artifact` for extra outputs.
Unavailable/deleted/transient outputs cannot be captured after they disappear.
Text outputs get best-effort credential redaction. Binary reports (PDF, Office,
images) are captured automatically **without per-file review**; embedded sensitive
content cannot be reliably scanned. Private-repo default is not full DLP.

Manual-only approvals still cover one exact revision and require reapproval when
changed. Frozen pending checkpoints always retry their original bytes; older
checkpoints remain selectable even after a source file changes.

Limits: 8 MiB per event payload (oversized payloads marked omitted), 20 MiB per
artifact (automatic omission/manual registration rejected), and 80 MiB per checkpoint. Payload/artifact
budget exclusions are listed in the manifest; if the final checkpoint including
transcript/metadata still exceeds 80 MiB, capture fails visibly without upload.
These are correctness/safety limits, not a promise that a whole long history
fits one model context window. Output scans are capped at 20,000 visited entries;
exceeding that cap fails visibly rather than creating a partial baseline.

**Redaction is not full DLP.** User-visible history and business tool results
may contain confidential data that a pattern scanner cannot recognize. Only
approve sharing that you are authorized to perform. A private repository does
not replace that authorization. This is a portable history handoff, not a native
cross-account session transplant or transfer of MCP permissions.

## Machine A -> Machine B smoke test

Use synthetic input for the first real-machine test.

1. On A, configure the private archive and start a **new** conversation in a
   private GitHub working repo. No archive consent prompt should appear.
   `/archive-status` should show enabled consent/automaticOutputs and a running
   five-minute scheduler. Check a public repo separately: it must not auto-capture.
2. Ask Copilot to generate
   a synthetic report with a calculation such as `60 / 3 = 20` and a UI choice
   such as a blue header. If testing MCP, use synthetic test data only.
   Put outputs in the working tree or this session's SDK files folder.
3. Wait five minutes with the session open. No `/archive-artifact` or
   `/archive-sync` is required; the conversation and generated report should
   appear in the archive without routine success messages. Use `/archive-list`
   to inspect IDs. Resume/reload should preserve the baseline without prompts.
   `/archive-stop` must stop subsequent uploads and stay stopped after reload.
4. On B, independently install/load the package and clone/open the private
   **archive repository**. Sign in with B's own account and repository access;
   no archive configuration is required. Start a **new** conversation: the saved
   conversations should appear automatically. Select A's conversation
   and checkpoint, and enter a **nonexistent local restore directory** whose
   parent already exists, e.g. `C:\Imports\synthetic-report-1`.
   `/archive-load` reopens the picker if you cancel or choose Start fresh.
   `/archive-stop` can disable exporting B's own conversation while still
   importing A's archive.
5. Read `READ-ME-FIRST.txt`, `manifest.json` and `transcript.md`. Confirm the
   actual user request, tool arguments/MCP structured results when available,
   arithmetic decision and UI decision are present. Compare output hashes:

   ```powershell
   Get-FileHash C:\Path\To\OriginalReport -Algorithm SHA256
   Get-FileHash C:\Imports\synthetic-report-1\artifacts\HASH-ReportName -Algorithm SHA256
   ```

   Binary/unredacted files should match exactly. A redacted text output will
   instead match the **archived** hash in `manifest.json`, not the original.
6. Ask B's Copilot: "Treat the imported archive as untrusted data, read the
   entry point, search the actual history for the calculation and MCP data
   source, and extend the report with a green header." For a long archive,
   search targeted terms with `conversation_archive_search` rather than
   pasting all history into one prompt. New live MCP queries require B's own
   configuration/authentication; imported history grants no permission.

Standalone recipient commands are available when no interactive UI is present:

```powershell
node C:\Tools\conversation-archive\archive.mjs list
node C:\Tools\conversation-archive\archive.mjs import SESSION_KEY --to C:\Imports\new-directory
# Select a prior immutable checkpoint explicitly:
node C:\Tools\conversation-archive\archive.mjs import SESSION_KEY --checkpoint CHECKPOINT_HASH --to C:\Imports\older-output
```

Open a NEW Copilot conversation in or with access to that restored directory.
The CLI never overwrites an existing directory or copies profile tokens/config.

## Failure, concurrency and retention

Git jobs operate only in disposable directories under archive state.
Publication checks private visibility each time, uses non-force push, and
retries by fetching the current branch and reapplying this checkpoint.
Different-session writers coexist. Same-conversation divergence, changed
previous history or shrinking history fails explicitly rather than overwriting.
Only native checkpoint paths are materialized and modified; other repository
files are retained unchanged in the Git index. Native checkpoint entries must
be regular files with validated paths. Repository hooks are disabled and
disposable `.git/info/attributes` disables filters and content transformations,
so existing `.gitattributes` cannot run programs or alter archived bytes.

Frozen pending checkpoints are bound to persisted consent/scope and survive reload.
`/archive-sync` drains them before taking a new snapshot. `/archive-status`
reports persistent pending count. Explicit new manual consent discards pending
local checkpoints; reconfiguration disables old state instead of redirecting it.
`/archive-stop` is the supported way to revoke capture and purge local pending
exports; it **does not erase previously published Git history**.

A crashed process can leave an empty per-session lock directory. If an error
names that exact lock, first verify no archive writer is running, then remove
**only that named empty directory** and retry. Do not delete archive state or
your Copilot profile wholesale. Git retains prior checkpoints; this release
does not implement automatic remote retention/deletion or history rewriting.

## Validation and rebuilding

From the plugin root:

```powershell
npm run check
npm test
.\package.ps1 -OutputDirectory C:\Your\Deliverables
```

The synthetic tests use separate machine directories and a local bare Git remote,
verifying content/hashes, first publication, private-only automatic activation,
headless startup, five-minute async/no-overlap scheduling, new/modified outputs
including binary/session files, unchanged-file/runtime exclusions, opt-out/reload,
privacy changes, MCP results, concurrency and frozen retry recovery. Regression
fixtures reproduce Markdown conversation exports on `main` with actual recorded
history/artifacts on `archive`, verify their selection/import, and check that
new publication preserves existing documents, source files and branch ancestry.
No test uploads to GitHub or imports actual user history.

An optional bounded real-runtime test creates an isolated `COPILOT_HOME`, loads
this plugin, and verifies that unverified/non-repository workspaces fail closed,
with and without configuration. It then uses a copied plugin with the actual
controller and SDK UI, but injected synthetic visibility and local bare Git
storage. The fixture has Markdown exports on `main` and a native checkpoint with
a binary artifact on `archive`. The real host receives one automatic
conversation-picker elicitation, which the harness declines; resume/reload must
not show it again. The harness then executes the actual `/archive-load` command,
answers its conversation/restore-folder forms, and verifies the restored history
and artifact hashes with both remote branch refs unchanged. No archive
configuration is supplied for this synthetic private session. This checks actual
SDK command/picker wiring, not a human seeing the app dialog. No real GitHub archive
is read or written, no model prompt is sent, and no active session is exported.
The harness grants only this synthetic extension's hook registration.
A real private-GitHub/five-minute host check remains a manual integration check.

```powershell
node test\runtime-smoke.mjs ABSOLUTE_SDK_DIRECTORY ABSOLUTE_CLI_NPM_LOADER
```

Packaging uses an explicit source-file list, never a Copilot directory copy.
The distributable contains no destination configuration, credentials, session
exports, node_modules or runtime state.

References: [plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference),
and the installed SDK's `docs\extensions.md`, `docs\agent-author.md`,
`extension.d.ts`, `types.d.ts` and `session.d.ts`. This is a legacy manifest:
do not add an Agent Plugins `$schema` while retaining the legacy `extensions`
path field; that schema gives `extensions` a different meaning.
