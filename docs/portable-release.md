# Windows portable release

Every build must preserve [the local upgrade requirements](upgrade-requirements.md),
including Claude continuation with OpenAI-origin tool history and keeping the
selected model when editing/resending a failed prompt. `build` and
`build:portable` run the required SDK/session regression checks before compiling.

The portable version and Pi Web application version are separate. Portable
1.3.3 bundles Pi Web 0.12.2 and Node.js 24.20.0, including native Claude
tool-history compatibility with billion-context and persistent model selection
when resending after errors or timeouts. It also replaces the affected Claude
endpoint's rejected system documentation index with on-demand references.

Build from a checkout with the required Node.js runtime:

```powershell
.\scripts\build-portable.ps1 -PortableVersion 1.3.3 -RuntimeDir C:\path\to\node
```

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
  -ExpectedVersion 1.3.3 `
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
