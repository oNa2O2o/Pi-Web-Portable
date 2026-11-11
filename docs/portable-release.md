# Portable release (Windows and macOS)

Every build must preserve [the local upgrade requirements](upgrade-requirements.md),
including Claude continuation with OpenAI-origin tool history and keeping the
selected model when editing/resending a failed prompt. `build` and
`build:portable` run the required SDK/session regression checks before compiling.

The portable version and Pi Web application version are separate. Portable
1.9.1 moves the automatic model checks into the existing Models settings
pages, so they apply when editing as well as adding: opening a provider page
lists every upstream model and really calls each added model, opening a model
page tests it, failures show the specific cause, a wrong API type or URL form
is corrected and saved automatically (with undo), and only ticked models that
pass a real call can be added. The separate quick-add dialog is removed. Portable
1.9.0 adds a macOS (Apple silicon) package and the model quick-add/health
plugins: filling in a Base URL and API key lists every model, the checked ones
are tested with a real call and the API type and URL form are matched
automatically, and a background service checks every enabled provider every
10 minutes (model list) and every 6 hours (a few-token call), shows dots in
the Models panel, a small alert that stays until closed when one fails, and
offers new upstream models to add. The voice input "no speech" notice is now a
small pill at the top. Portable
1.8.1 adds sidebar folder drag-reordering, a "+" on a folder row that files
the new session into it, and archiving a folder with its sessions. Portable
1.8.0 bundles Pi Web 0.15.0 (pi 1.5.0, Next 16.4.4): side chats, quoting a
selection, switching models during a run, draggable right-panel tabs, ordered
custom provider models, a Git change tree, PowerShell as the default Windows
terminal and the HTML export/ChatGPT login fixes, on top of all local
additions. `lib/anthropic-system-docs.ts` accepts the pi 1.5.0 docs wording.
Portable
1.7.1 fixes MCP being off in every portable build: `next build` links server
externals as `.next\node_modules\<name>-<hash>` junctions, copying the build
turned them into a second copy of the SDK, and Pi Web refuses MCP then.
`scripts/link-next-externals.mjs` now replaces them with re-export stubs.
Portable
1.7.0 bundles Pi Web 0.13.0 (pi 1.4.0): the Debug panel, line-by-line tool
arguments, svg and audio/video previews, copyable LaTeX, prompts queued during
compaction, per-model Base URL and image size limit, original-size image
attachments, and idle connections released by background tabs, on top of all
local additions. The update test can take several minutes on slow disks.
Portable 1.6.0 merges upstream Pi Web main (models Base URL override, Claude adaptive
thinking switch, subagent Agents badge, inline markdown audio/video, session
search, unread sync) with the local additions: session folders in the sidebar,
restart and portable-update buttons, the floating clipboard (Alt+Shift+C/V),
and the fix for emphasis markers between an autolink and CJK punctuation.
Portable 1.5.0 added long-press voice input. Portable 1.4.1 bundles Pi Web 0.12.2 and Node.js 24.20.0. It fixes legacy budget-based
thinking requests for custom Claude Opus 5.5 and Sonnet 5.5 models on api.chiyi.cc
by sending adaptive thinking and the selected effort, without changing saved
configuration or conversation history. Version 1.4.0 added the single-file
executable. Like 1.3.3, it includes native Claude
tool-history compatibility with billion-context and persistent model selection
when resending after errors or timeouts. It also replaces the affected Claude
endpoint's rejected system documentation index with on-demand references.

Build from a checkout with the required Node.js runtime:

```powershell
.\scripts\build-portable.ps1 -PortableVersion 1.9.1 -RuntimeDir C:\path\to\node
.\scripts\build-portable-exe.ps1
```

`build-portable-exe.ps1` compiles `portable/bootstrap/SingleExe.cs` and appends
the ZIP to it, producing `portable/dist/Pi-Web-Portable-win-x64.exe` plus a
SHA256 file. Layout: `[bootstrap][zip][header JSON {portableVersion, sha256}]
[int64 zip length][int64 header length]["PIWEBPK1"]`. When it runs, the exe:

- installs to `%LOCALAPPDATA%\Pi-Web-Portable` (override with `--install-dir`
  or `PI_WEB_PORTABLE_HOME`). On first run it verifies the embedded checksum,
  extracts to a sibling staging directory, runs `--self-test`, then moves it in;
- upgrades an older install through the regular `--apply-update` path, so the
  running-session check, `data/` preservation and rollback still apply;
- otherwise launches the installed `Pi-Web-Portable.exe` and forwards arguments.
  The installed launcher keeps updating from the ZIP release asset.

Extra flags: `--install-only`, `--wait` (return the launcher's exit code),
`--print-install-dir`, `--payload-version`, `--non-interactive`. The log is
`%LOCALAPPDATA%\Pi-Web-Portable.bootstrap.log`.

The build verifies `engines.node`, builds the application, installs production
dependencies from the lockfile, and produces the ZIP plus SHA256 file. When
using `-ReuseStage`, a changed lockfile triggers dependency installation;
`-SkipInstall` refuses mismatched dependencies. Existing packages and ZIPs are
kept as timestamped backups. ZIP creation includes dotfiles and writes to a
temporary archive before replacing the previous release.

Before publishing, run:

```powershell
.\scripts\test-portable.ps1 -PackageDir .\portable\dist\Pi-web-portable -Port 30142
.\scripts\test-portable-update.ps1 `
  -PackageDir .\portable\dist\Pi-web-portable `
  -ArchivePath .\portable\dist\pi-web-portable-win-x64.zip `
  -ChecksumPath .\portable\dist\pi-web-portable-win-x64.zip.sha256 `
  -PreviousArchive C:\path\to\previous-release.zip
node scripts/test-session-titles.mjs .\portable\dist\Pi-web-portable
node scripts/verify-billion-context.mjs --app-dir .\portable\dist\Pi-web-portable\app
node scripts/verify-resend-model.mjs .\portable\dist\Pi-web-portable\app
```

Use free ports. The update test installs into its own short temporary directory,
preserves a user-data marker, removes an obsolete application file, runs the
launcher rollback tests, and starts the upgraded HTTP server. The naming test
uses an isolated configuration and local mock provider.

After publication, test the real online upgrade from an older release:

```powershell
powershell.exe -NoProfile -File .\scripts\test-published-portable-update.ps1 `
  -PreviousArchive C:\path\to\previous-release.zip `
  -ExpectedVersion 1.9.1 `
  -ResultPath C:\path\to\online-upgrade-result.json
```

This test uses the original released updater's discovery, download, checksum,
and installation code. It bypasses the confirmation dialog for automation,
runs the old and upgraded servers on a free test port, and checks that the
installed executable matches the published archive and user data survives.
It requires Windows PowerShell 5.1 to load the original .NET Framework
executable. A failed run retains its isolated directory and logs for diagnosis.
The result records the original updater hash, downloaded release hash, old
server shutdown, installed versions, and the upgraded application's HTTP status.

The launcher checks `portable-v*` GitHub releases with both the configured ZIP
and its `.sha256` asset. It validates checksums, package completeness, and runtime
compatibility; waits for the original launcher to exit; and backs up only the
managed application files. Failed installation restores the saved files.
Running conversations defer installation.

For a verified local ZIP, the updated launcher supports:

```powershell
.\Pi-Web-Portable.exe --apply-local-update --archive C:\path\to\release.zip --checksum C:\path\to\release.zip.sha256 --relaunch
```

The original ZIP is retained. User configuration and conversations under the Pi
user directory, and the portable `data` directory, are not replaced.
For an older launcher that cannot complete automatic updates, extract the new
ZIP to a new directory and use its launcher; existing Pi user data remains
available.

The `Windows portable release` workflow runs packaging, launch, upgrade, and
naming checks. Only a `portable-v*` tag publishes release assets; a manual
workflow run produces a downloadable workflow artifact.

## Voice input plugin

`portable/plugins` is copied to `appplugins`. When `apppluginspiweb-plugin-loader.cjs`
exists, the launcher adds `--require <loader>` to `NODE_OPTIONS` and sets
`PIWEB_PLUGIN_LOG_DIR` to `logs`. The loader only activates inside the `next start`
process and removes itself from `NODE_OPTIONS` there, so agent tools and terminals
do not inherit it. It:

- injects `apppluginsweb*.js` into HTML pages (served from `/__piweb-plugins/`);
- starts `apppluginsserveroice-asrserver.cjs` (sherpa-onnx, Apache-2.0) on a
  random loopback port and proxies `/__piweb-plugins/ws/voice-asr` to it; only
  loopback origins are accepted;
- writes diagnostics to `logsoice-input.log`.

The build installs the service dependencies with `npm ci` and downloads the
X-ASR zh/en streaming model (~160 MB) into `portable.voice-cache`, verifying each
file by SHA256. The Pi Web application source is not modified.

## macOS (Apple silicon)

Built on macOS arm64 (the release workflow's `build-mac` job on `macos-15`):

```bash
scripts/build-portable-mac.sh --version 1.9.1
scripts/test-portable-mac.sh portable/dist/mac/Pi-Web-Portable
```

The zip `pi-web-portable-mac-arm64.zip` holds one folder `Pi-Web-Portable` with
`Pi Web.command` (`portable/mac/Pi Web.command`, double-click to start; `--stop`,
`--restart`, `--no-open`, `PI_WEB_PORT`), `app/` and `runtime/node`. The launcher
clears the download quarantine flag once so the sherpa-onnx native module loads,
starts Node in its own session so closing Terminal keeps it running, and sets
`PI_WEB_INSTALL_ROOT` and `PI_WEB_RESTART_COMMAND` so the restart button works.
The manifest's `assetName` is the mac zip, so update notices compare against mac
assets; applying an update is manual (replace the folder; data stays in
`~/.pi/agent`). The package is not signed or notarized.

The release is published by the `publish` job only after both the Windows and the
macOS jobs pass, with all six assets.
