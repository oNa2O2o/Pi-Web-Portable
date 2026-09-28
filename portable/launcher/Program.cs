using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class Program
{
    private const int Port = 30141;
    private const string Host = "127.0.0.1";
    private static readonly string Root = Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName);
    private static readonly string AppRoot = Path.Combine(Root, "app");
    private static readonly string RuntimeRoot = Path.Combine(Root, "runtime");
    private static readonly string DataRoot = Path.Combine(Root, "data");
    private static readonly string LogsRoot = Path.Combine(Root, "logs");
    private static readonly string ManifestPath = Path.Combine(Root, "portable-manifest.json");
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly string[] ManagedEntries =
    {
        "app",
        "runtime",
        "Pi-Web-Portable.exe",
        "portable-manifest.json",
        "README.txt",
        "pi-agent-icon.ico",
    };

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;

            if (HasArg(args, "--self-test")) return SelfTest();
            if (HasArg(args, "--stop")) return StopManagedServer();
            if (HasArg(args, "--apply-update")) return ApplyUpdate(args);
            if (HasArg(args, "--verify-update")) return VerifyLatestRelease(LoadManifest());

            var manifest = LoadManifest();
            if (HasArg(args, "--check-update"))
            {
                TryOfferUpdate(manifest, true);
                return 0;
            }
            if (!HasArg(args, "--no-update") && manifest.AutoUpdate)
            {
                TryOfferUpdate(manifest, false);
            }

            return RunServer(!HasArg(args, "--no-open"));
        }
        catch (Exception error)
        {
            Log("Fatal launcher error: " + error);
            ShowError("Pi Web 启动失败，请查看 logs\\launcher.log。");
            return 1;
        }
    }

    private static int SelfTest()
    {
        var missing = GetMissingPackageFiles(Root);

        if (missing.Count > 0)
        {
            Log("Self-test failed. Missing: " + string.Join("; ", missing));
            return 2;
        }

        try { SelfTestArchiveExtraction(); }
        catch (Exception error)
        {
            Log("Self-test failed. Archive extraction: " + error);
            return 3;
        }

        Log("Self-test passed. Portable version: " + LoadManifest().PortableVersion);
        return 0;
    }

    private static void SelfTestArchiveExtraction()
    {
        var longEntry = "app/" + new string('a', 71) + "/" + new string('b', 70) + "/" + new string('c', 56) + ".txt";
        var testRoot = CreateShortScratchDirectory(longEntry.Length + 5);
        var archive = Path.Combine(testRoot, "self-test.zip");
        var extraction = Path.Combine(testRoot, "out");
        try
        {
            Directory.CreateDirectory(extraction);
            using (var file = File.Create(archive))
            using (var zip = new ZipArchive(file, ZipArchiveMode.Create))
            using (var writer = new StreamWriter(zip.CreateEntry(longEntry).Open()))
            {
                writer.Write("ok");
            }

            ExtractSafely(archive, extraction);
            var extractedFile = Path.Combine(extraction, longEntry.Replace('/', Path.DirectorySeparatorChar));
            if (File.ReadAllText(extractedFile) != "ok")
                throw new InvalidDataException("Long-path archive entry was not extracted correctly.");

            var unsafeArchive = Path.Combine(testRoot, "unsafe.zip");
            using (var file = File.Create(unsafeArchive))
            using (var zip = new ZipArchive(file, ZipArchiveMode.Create))
            using (var writer = new StreamWriter(zip.CreateEntry("../escaped.txt").Open()))
            {
                writer.Write("no");
            }

            var rejected = false;
            try { ExtractSafely(unsafeArchive, Path.Combine(testRoot, "bad")); }
            catch (InvalidDataException) { rejected = true; }
            if (!rejected || File.Exists(Path.Combine(testRoot, "escaped.txt")))
                throw new InvalidDataException("Unsafe archive path was not rejected.");

            var installed = Path.Combine(testRoot, "installed");
            var update = Path.Combine(testRoot, "update");
            Directory.CreateDirectory(Path.Combine(installed, "app"));
            Directory.CreateDirectory(Path.Combine(update, "app"));
            File.WriteAllText(Path.Combine(installed, "app", "marker.txt"), "old");
            File.WriteAllText(Path.Combine(update, "app", "marker.txt"), "new");
            ReplacePackage(update, installed);
            if (File.ReadAllText(Path.Combine(installed, "app", "marker.txt")) != "new")
                throw new InvalidDataException("Package replacement self-test failed.");
        }
        finally { TryDeleteDirectory(testRoot); }
    }

    private static List<string> GetMissingPackageFiles(string root)
    {
        var missing = new List<string>();
        var required = new[]
        {
            Path.Combine(root, "runtime", "node.exe"),
            Path.Combine(root, "app", "bin", "pi-web.js"),
            Path.Combine(root, "app", ".next", "BUILD_ID"),
            Path.Combine(root, "portable-manifest.json"),
            Path.Combine(root, "Pi-Web-Portable.exe"),
        };
        foreach (var path in required) if (!File.Exists(path)) missing.Add(path);
        return missing;
    }

    private static void EnsureCompletePackage(string root)
    {
        var missing = GetMissingPackageFiles(root);
        if (missing.Count > 0) throw new InvalidDataException("Portable package is incomplete: " + string.Join("; ", missing));
    }

    private static int RunServer(bool openBrowser)
    {
        var url = "http://" + Host + ":" + Port + "/";
        if (IsHealthy())
        {
            if (openBrowser) OpenBrowser(url);
            return 0;
        }

        var node = Path.Combine(RuntimeRoot, "node.exe");
        var cli = Path.Combine(AppRoot, "bin", "pi-web.js");
        var build = Path.Combine(AppRoot, ".next", "BUILD_ID");
        if (!File.Exists(node) || !File.Exists(cli) || !File.Exists(build))
        {
            Log("Production package is incomplete.");
            ShowError("便携包文件不完整，请重新下载或重新打包。");
            return 2;
        }

        Directory.CreateDirectory(DataRoot);
        Directory.CreateDirectory(LogsRoot);
        var stdoutPath = Path.Combine(LogsRoot, "pi-web.stdout.log");
        var stderrPath = Path.Combine(LogsRoot, "pi-web.stderr.log");
        var pidPath = Path.Combine(DataRoot, "pi-web.pid");

        var info = new ProcessStartInfo
        {
            FileName = node,
            Arguments = Quote(cli) + " --port " + Port + " --hostname " + Host + " --no-open",
            WorkingDirectory = AppRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };

        var child = Process.Start(info);
        if (child == null) throw new InvalidOperationException("Could not start the bundled Node.js process.");
        File.WriteAllText(pidPath, child.Id.ToString());
        Log("Started Pi Web process " + child.Id + ".");

        var outputTask = PumpAsync(child.StandardOutput, stdoutPath);
        var errorTask = PumpAsync(child.StandardError, stderrPath);
        var ready = WaitForHealth(child, url, 60);
        if (!ready)
        {
            Log("Pi Web did not become ready within 60 seconds.");
            TryKill(child);
            ShowError("Pi Web 在 60 秒内未能启动，请查看 logs\\pi-web.stderr.log。");
            return 3;
        }

        if (openBrowser) OpenBrowser(url);
        child.WaitForExit();
        Task.WaitAll(new[] { outputTask, errorTask }, 5000);
        TryDelete(pidPath);
        Log("Pi Web process exited with code " + child.ExitCode + ".");
        return child.ExitCode;
    }

    private static bool WaitForHealth(Process child, string url, int seconds)
    {
        for (var i = 0; i < seconds * 2; i++)
        {
            if (child.HasExited) return false;
            if (IsHealthy(url)) return true;
            Thread.Sleep(500);
        }
        return false;
    }

    private static bool IsHealthy()
    {
        return IsHealthy("http://" + Host + ":" + Port + "/");
    }

    private static bool IsHealthy(string url)
    {
        try
        {
            using (var client = NewHttpClient(2000))
            using (var response = client.GetAsync(url).Result)
            {
                return response.IsSuccessStatusCode;
            }
        }
        catch
        {
            return false;
        }
    }

    private static void TryOfferUpdate(Manifest manifest, bool force)
    {
        if (!force && !ShouldCheckForUpdate(manifest.UpdateCheckHours)) return;

        string archive = null;
        var notifyOnFailure = force;
        try
        {
            var release = GetLatestRelease(manifest);
            MarkUpdateCheck();
            if (release == null)
            {
                if (force) ShowInfo("没有找到可用的便携版 Release。");
                return;
            }
            if (CompareVersions(release.Version, manifest.PortableVersion) <= 0)
            {
                if (force) ShowInfo("当前已经是最新便携版：" + manifest.PortableVersion);
                return;
            }

            var answer = MessageBox.Show(
                "发现 Pi Web 便携版 " + release.Version + "。\n\n是否立即下载并更新？",
                "Pi Web 便携版更新",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Information);
            if (answer != DialogResult.Yes) return;
            notifyOnFailure = true;

            archive = DownloadVerifiedArchive(release);

            var updater = Path.Combine(Path.GetTempPath(), "PiWebPortableUpdater-" + Guid.NewGuid().ToString("N") + ".exe");
            File.Copy(Process.GetCurrentProcess().MainModule.FileName, updater, true);
            var updaterInfo = new ProcessStartInfo
            {
                FileName = updater,
                Arguments = "--apply-update --parent-pid " + Process.GetCurrentProcess().Id
                    + " --target " + Quote(Root) + " --archive " + Quote(archive) + " --relaunch",
                UseShellExecute = true,
                WindowStyle = ProcessWindowStyle.Hidden,
            };
            Process.Start(updaterInfo);
            archive = null;
            Environment.Exit(0);
        }
        catch (Exception error)
        {
            Log("Update check failed: " + error);
            if (notifyOnFailure) ShowError("自动更新失败，Pi Web 将继续使用当前版本。详情请查看 logs\\launcher.log。");
        }
        finally { TryDelete(archive); }
    }

    private static ReleaseInfo GetLatestRelease(Manifest manifest)
    {
        if (string.IsNullOrEmpty(manifest.Repository)) return null;
        var endpoint = "https://api.github.com/repos/" + manifest.Repository + "/releases?per_page=20";
        using (var client = NewHttpClient(5000))
        using (var response = client.GetAsync(endpoint).Result)
        {
            response.EnsureSuccessStatusCode();
            var json = response.Content.ReadAsStringAsync().Result;
            var releases = Json.DeserializeObject(json) as object[];
            if (releases == null) return null;

            ReleaseInfo best = null;
            foreach (var releaseItem in releases)
            {
                var root = releaseItem as Dictionary<string, object>;
                if (root == null || GetBool(root, "draft", false) || GetBool(root, "prerelease", false)) continue;
                var tag = root.ContainsKey("tag_name") ? root["tag_name"] as string : null;
                if (string.IsNullOrEmpty(tag) || !tag.StartsWith("portable-v", StringComparison.OrdinalIgnoreCase)) continue;

                var result = new ReleaseInfo { Version = ExtractVersion(tag) };
                var assets = root.ContainsKey("assets") ? root["assets"] as object[] : null;
                if (assets == null) continue;
                foreach (var item in assets)
                {
                    var asset = item as Dictionary<string, object>;
                    if (asset == null) continue;
                    var name = asset.ContainsKey("name") ? asset["name"] as string : null;
                    var url = asset.ContainsKey("browser_download_url") ? asset["browser_download_url"] as string : null;
                    if (string.Equals(name, manifest.AssetName, StringComparison.OrdinalIgnoreCase)) result.ArchiveUrl = url;
                    if (string.Equals(name, manifest.AssetName + ".sha256", StringComparison.OrdinalIgnoreCase)) result.ChecksumUrl = url;
                }
                if (string.IsNullOrEmpty(result.ArchiveUrl)) continue;
                if (best == null || CompareVersions(result.Version, best.Version) > 0) best = result;
            }
            return best;
        }
    }

    private static string DownloadVerifiedArchive(ReleaseInfo release)
    {
        if (string.IsNullOrEmpty(release.ArchiveUrl)) throw new InvalidDataException("Release archive is missing.");
        if (string.IsNullOrEmpty(release.ChecksumUrl)) throw new InvalidDataException("Release checksum is missing.");

        var archive = Path.Combine(Path.GetTempPath(), "pi-web-portable-" + Guid.NewGuid().ToString("N") + ".zip");
        var checksum = Path.Combine(Path.GetTempPath(), "pi-web-portable-" + Guid.NewGuid().ToString("N") + ".sha256");
        try
        {
            DownloadFile(release.ArchiveUrl, archive);
            DownloadFile(release.ChecksumUrl, checksum);
            VerifyChecksum(archive, checksum);
            return archive;
        }
        catch
        {
            TryDelete(archive);
            throw;
        }
        finally { TryDelete(checksum); }
    }

    private static int VerifyLatestRelease(Manifest manifest)
    {
        string archive = null;
        string staging = null;
        try
        {
            var release = GetLatestRelease(manifest);
            if (release == null) throw new InvalidDataException("No portable release was found.");
            archive = DownloadVerifiedArchive(release);
            staging = CreateShortStagingDirectory(archive);
            ExtractSafely(archive, staging);
            EnsureCompletePackage(staging);

            var downloaded = LoadManifestAt(Path.Combine(staging, "portable-manifest.json"));
            if (CompareVersions(downloaded.PortableVersion, release.Version) != 0)
                throw new InvalidDataException("Release tag and portable manifest versions do not match.");

            Log("Update verification passed for portable version " + release.Version + ".");
            return 0;
        }
        catch (Exception error)
        {
            Log("Update verification failed: " + error);
            return 6;
        }
        finally
        {
            TryDelete(archive);
            TryDeleteDirectory(staging);
        }
    }

    private static int ApplyUpdate(string[] args)
    {
        var target = GetArg(args, "--target");
        var archive = GetArg(args, "--archive");
        var parentPid = GetIntArg(args, "--parent-pid");
        if (string.IsNullOrEmpty(target) || string.IsNullOrEmpty(archive)) return 4;

        try
        {
            WaitForParent(parentPid);
            var staging = CreateShortStagingDirectory(archive);
            ExtractSafely(archive, staging);
            EnsureCompletePackage(staging);
            StopManagedServerAt(target);
            ReplacePackage(staging, target);
            TryDelete(archive);
            TryDeleteDirectory(staging);

            var exe = Path.Combine(target, "Pi-Web-Portable.exe");
            if (HasArg(args, "--relaunch") && File.Exists(exe))
            {
                Process.Start(new ProcessStartInfo { FileName = exe, UseShellExecute = true });
            }
            return 0;
        }
        catch (Exception error)
        {
            LogTo(Path.Combine(target, "logs", "launcher.log"), "Update failed: " + error);
            ShowError("更新失败，已尝试恢复原有版本。详情请查看 logs\\launcher.log。");
            var exe = Path.Combine(target, "Pi-Web-Portable.exe");
            if (HasArg(args, "--relaunch") && File.Exists(exe))
            {
                try { Process.Start(new ProcessStartInfo { FileName = exe, UseShellExecute = true }); }
                catch { }
            }
            return 5;
        }
    }

    private static void ExtractSafely(string archive, string destination)
    {
        var maxEntryLength = 0;
        using (var zip = ZipFile.OpenRead(archive))
        {
            foreach (var entry in zip.Entries)
            {
                var normalized = entry.FullName.Replace('\\', '/');
                if (IsUnsafeArchiveEntry(normalized))
                    throw new InvalidDataException("Update archive contains an unsafe path.");
                maxEntryLength = Math.Max(maxEntryLength, normalized.Length);
            }
        }

        var fullDestination = Path.GetFullPath(destination).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (fullDestination.Length + 1 + maxEntryLength >= 248)
            throw new PathTooLongException("Update staging path is too long for Windows.");

        ZipFile.ExtractToDirectory(archive, destination);
    }

    private static bool IsUnsafeArchiveEntry(string entryName)
    {
        if (string.IsNullOrEmpty(entryName) || entryName.IndexOf('\0') >= 0 || entryName.StartsWith("/", StringComparison.Ordinal) || entryName.IndexOf(':') >= 0)
            return true;

        var segments = entryName.Split('/');
        foreach (var segment in segments)
            if (segment == "..") return true;
        return false;
    }

    private static string CreateShortStagingDirectory(string archive)
    {
        var maxEntryLength = 0;
        using (var zip = ZipFile.OpenRead(archive))
        {
            foreach (var entry in zip.Entries)
            {
                var normalized = entry.FullName.Replace('\\', '/');
                if (IsUnsafeArchiveEntry(normalized))
                    throw new InvalidDataException("Update archive contains an unsafe path.");
                maxEntryLength = Math.Max(maxEntryLength, normalized.Length);
            }
        }
        return CreateShortScratchDirectory(maxEntryLength);
    }

    private static string CreateShortScratchDirectory(int maxEntryLength)
    {
        var roots = new List<string>();
        AddScratchRoots(roots, Path.GetDirectoryName(Root));
        AddScratchRoots(roots, Path.GetTempPath());
        AddScratchRoots(roots, Root);

        foreach (var root in roots)
        {
            for (var attempt = 0; attempt < 32; attempt++)
            {
                var name = "p" + Guid.NewGuid().ToString("N").Substring(0, 6);
                var path = Path.Combine(root, name);
                if (path.Length + 1 + maxEntryLength >= 248 || Directory.Exists(path) || File.Exists(path)) continue;
                try
                {
                    Directory.CreateDirectory(path);
                    return path;
                }
                catch (UnauthorizedAccessException) { break; }
                catch (IOException) { }
            }
        }

        throw new IOException("Could not create a short writable staging directory for the update.");
    }

    private static void AddScratchRoots(List<string> roots, string path)
    {
        if (string.IsNullOrEmpty(path)) return;
        var current = new DirectoryInfo(path);
        while (current != null)
        {
            var candidate = current.FullName;
            var found = false;
            foreach (var existing in roots)
                if (string.Equals(existing, candidate, StringComparison.OrdinalIgnoreCase)) { found = true; break; }
            if (!found) roots.Add(candidate);
            current = current.Parent;
        }
    }

    private static string CreateShortBackupDirectory(string target)
    {
        for (var attempt = 0; attempt < 32; attempt++)
        {
            var path = Path.Combine(target, "b" + Guid.NewGuid().ToString("N").Substring(0, 6));
            if (Directory.Exists(path) || File.Exists(path)) continue;
            Directory.CreateDirectory(path);
            return path;
        }
        throw new IOException("Could not create a unique update backup directory.");
    }

    private static void ReplacePackage(string staging, string target)
    {
        var backup = CreateShortBackupDirectory(target);
        try
        {
            foreach (var name in ManagedEntries)
            {
                var current = Path.Combine(target, name);
                var saved = Path.Combine(backup, name);
                MoveEntry(current, saved);
            }

            foreach (var name in ManagedEntries)
            {
                var source = Path.Combine(staging, name);
                var destination = Path.Combine(target, name);
                CopyEntry(source, destination);
            }
            TryDeleteDirectory(backup);
        }
        catch
        {
            foreach (var name in ManagedEntries) DeleteEntry(Path.Combine(target, name));
            foreach (var name in ManagedEntries)
            {
                var saved = Path.Combine(backup, name);
                var current = Path.Combine(target, name);
                MoveEntry(saved, current);
            }
            TryDeleteDirectory(backup);
            throw;
        }
    }

    private static void MoveEntry(string source, string destination)
    {
        if (Directory.Exists(source)) Directory.Move(source, destination);
        else if (File.Exists(source)) File.Move(source, destination);
    }

    private static void CopyEntry(string source, string destination)
    {
        if (Directory.Exists(source)) CopyDirectory(source, destination);
        else if (File.Exists(source)) File.Copy(source, destination, true);
    }

    private static void DeleteEntry(string path)
    {
        if (Directory.Exists(path)) TryDeleteDirectory(path);
        else TryDelete(path);
    }

    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (var file in Directory.GetFiles(source)) File.Copy(file, Path.Combine(destination, Path.GetFileName(file)), true);
        foreach (var directory in Directory.GetDirectories(source)) CopyDirectory(directory, Path.Combine(destination, Path.GetFileName(directory)));
    }

    private static int StopManagedServer()
    {
        StopManagedServerAt(Root);
        return 0;
    }

    private static void StopManagedServerAt(string root)
    {
        var pidPath = Path.Combine(root, "data", "pi-web.pid");
        var text = File.Exists(pidPath) ? File.ReadAllText(pidPath).Trim() : "";
        int pid;
        if (int.TryParse(text, out pid))
        {
            try
            {
                using (var taskkill = Process.Start(new ProcessStartInfo
                {
                    FileName = "taskkill.exe",
                    Arguments = "/PID " + pid + " /T /F",
                    CreateNoWindow = true,
                    UseShellExecute = false,
                })) taskkill.WaitForExit(10000);
            }
            catch (Exception error) { LogTo(Path.Combine(root, "logs", "launcher.log"), "Stop failed: " + error); }
        }
        TryDelete(pidPath);
    }

    private static Manifest LoadManifest()
    {
        return LoadManifestAt(ManifestPath);
    }

    private static Manifest LoadManifestAt(string path)
    {
        if (!File.Exists(path)) return new Manifest();
        var values = Json.DeserializeObject(File.ReadAllText(path)) as Dictionary<string, object>;
        if (values == null) return new Manifest();
        return new Manifest
        {
            PortableVersion = GetString(values, "portableVersion", "1.0.0"),
            AppVersion = GetString(values, "appVersion", "unknown"),
            Repository = GetString(values, "repository", ""),
            AssetName = GetString(values, "assetName", "pi-web-portable-win-x64.zip"),
            AutoUpdate = GetBool(values, "autoUpdate", true),
            UpdateCheckHours = GetInt(values, "updateCheckHours", 6),
        };
    }

    private static bool ShouldCheckForUpdate(int hours)
    {
        var marker = Path.Combine(DataRoot, "last-update-check.txt");
        DateTime last;
        if (!File.Exists(marker) || !DateTime.TryParse(File.ReadAllText(marker), out last)) return true;
        return DateTime.UtcNow - last.ToUniversalTime() >= TimeSpan.FromHours(Math.Max(1, hours));
    }

    private static void MarkUpdateCheck()
    {
        try { Directory.CreateDirectory(DataRoot); File.WriteAllText(Path.Combine(DataRoot, "last-update-check.txt"), DateTime.UtcNow.ToString("o")); }
        catch { }
    }

    private static HttpClient NewHttpClient(int timeout)
    {
        var client = new HttpClient { Timeout = TimeSpan.FromMilliseconds(timeout) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("Pi-Web-Portable/1.0");
        client.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        return client;
    }

    private static void DownloadFile(string url, string destination)
    {
        using (var client = NewHttpClient(120000))
        using (var response = client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead).Result)
        {
            response.EnsureSuccessStatusCode();
            using (var input = response.Content.ReadAsStreamAsync().Result)
            using (var output = File.Create(destination)) input.CopyTo(output);
        }
    }

    private static void VerifyChecksum(string archive, string checksumFile)
    {
        var expectedMatch = Regex.Match(File.ReadAllText(checksumFile), "[a-fA-F0-9]{64}");
        if (!expectedMatch.Success) throw new InvalidDataException("Checksum file is invalid.");
        using (var sha = SHA256.Create())
        using (var input = File.OpenRead(archive))
        {
            var actual = BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
            if (!string.Equals(actual, expectedMatch.Value.ToLowerInvariant(), StringComparison.Ordinal)) throw new InvalidDataException("Update checksum mismatch.");
        }
    }

    private static string ExtractVersion(string text)
    {
        var match = Regex.Match(text ?? "", "(\\d+\\.\\d+(?:\\.\\d+){0,2})");
        return match.Success ? match.Groups[1].Value : "0.0.0";
    }

    private static int CompareVersions(string left, string right)
    {
        Version a, b;
        if (!Version.TryParse(NormalizeVersion(left), out a)) a = new Version(0, 0, 0, 0);
        if (!Version.TryParse(NormalizeVersion(right), out b)) b = new Version(0, 0, 0, 0);
        return a.CompareTo(b);
    }

    private static string NormalizeVersion(string value)
    {
        var parts = ExtractVersion(value).Split('.');
        var normalized = new List<string>(parts);
        while (normalized.Count < 4) normalized.Add("0");
        return string.Join(".", normalized.ToArray());
    }

    private static async Task PumpAsync(StreamReader reader, string path)
    {
        try
        {
            using (var writer = new StreamWriter(new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite), Encoding.UTF8))
            {
                string line;
                while ((line = await reader.ReadLineAsync()) != null) { writer.WriteLine(line); writer.Flush(); }
            }
        }
        catch (Exception error) { Log("Log pump failed: " + error); }
    }

    private static void OpenBrowser(string url)
    {
        try { Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true }); }
        catch (Exception error) { Log("Could not open browser: " + error); }
    }

    private static void WaitForParent(int pid)
    {
        if (pid <= 0) return;
        try { using (var parent = Process.GetProcessById(pid)) parent.WaitForExit(60000); }
        catch { }
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                using (var taskkill = Process.Start(new ProcessStartInfo { FileName = "taskkill.exe", Arguments = "/PID " + process.Id + " /T /F", CreateNoWindow = true, UseShellExecute = false })) taskkill.WaitForExit(10000);
            }
        }
        catch { }
    }

    private static bool HasArg(string[] args, string name)
    {
        foreach (var arg in args) if (string.Equals(arg, name, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private static string GetArg(string[] args, string name)
    {
        for (var i = 0; i + 1 < args.Length; i++) if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase)) return args[i + 1];
        return null;
    }

    private static int GetIntArg(string[] args, string name)
    {
        int value;
        return int.TryParse(GetArg(args, name), out value) ? value : 0;
    }

    private static string Quote(string value)
    {
        return "\"" + (value ?? "").Replace("\"", "\\\"") + "\"";
    }

    private static string GetString(Dictionary<string, object> values, string key, string fallback)
    {
        return values.ContainsKey(key) && values[key] != null ? Convert.ToString(values[key]) : fallback;
    }

    private static bool GetBool(Dictionary<string, object> values, string key, bool fallback)
    {
        return values.ContainsKey(key) && values[key] != null ? Convert.ToBoolean(values[key]) : fallback;
    }

    private static int GetInt(Dictionary<string, object> values, string key, int fallback)
    {
        try { return values.ContainsKey(key) && values[key] != null ? Convert.ToInt32(values[key]) : fallback; }
        catch { return fallback; }
    }

    private static void ShowError(string message)
    {
        try { MessageBox.Show(message, "Pi Web 便携版", MessageBoxButtons.OK, MessageBoxIcon.Error); }
        catch { }
    }

    private static void ShowInfo(string message)
    {
        try { MessageBox.Show(message, "Pi Web 便携版", MessageBoxButtons.OK, MessageBoxIcon.Information); }
        catch { }
    }

    private static void Log(string message) { LogTo(Path.Combine(LogsRoot, "launcher.log"), message); }

    private static void LogTo(string path, string message)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.AppendAllText(path, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message + Environment.NewLine, Encoding.UTF8);
        }
        catch { }
    }

    private static void TryDelete(string path) { try { if (!string.IsNullOrEmpty(path) && File.Exists(path)) File.Delete(path); } catch { } }

    private static void TryDeleteDirectory(string path)
    {
        try { if (Directory.Exists(path)) Directory.Delete(path, true); } catch { }
    }

    private sealed class Manifest
    {
        public string PortableVersion;
        public string AppVersion;
        public string Repository;
        public string AssetName;
        public bool AutoUpdate;
        public int UpdateCheckHours;
    }

    private sealed class ReleaseInfo
    {
        public string Version;
        public string ArchiveUrl;
        public string ChecksumUrl;
    }
}
