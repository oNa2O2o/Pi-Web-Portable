// Single-file Pi Web Portable executable.
//
// The release build appends the regular portable ZIP to this small program:
//   [PE image][portable ZIP][header JSON][int64 zipLength][int64 headerLength]["PIWEBPK1"]
// On start it installs the embedded package into a fixed local directory (first
// run), upgrades that installation through the regular portable updater when the
// embedded package is newer, and then hands over to the installed launcher. The
// installed launcher keeps checking GitHub releases and updates itself in place.
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

internal static class SingleExe
{
    private const string Magic = "PIWEBPK1";
    private const string LauncherName = "Pi-Web-Portable.exe";
    private const string ManifestName = "portable-manifest.json";
    private static bool NonInteractive;
    private static string LogPath;

    [STAThread]
    private static int Main(string[] args)
    {
        NonInteractive = HasArg(args, "--non-interactive");
        string installDir = null;
        try
        {
            installDir = ResolveInstallDir(args);
            LogPath = Path.Combine(installDir + ".bootstrap.log");
            var self = Process.GetCurrentProcess().MainModule.FileName;
            var payload = Payload.Read(self);

            if (HasArg(args, "--print-install-dir"))
            {
                Console.WriteLine(installDir);
                return 0;
            }
            if (HasArg(args, "--payload-version"))
            {
                Console.WriteLine(payload.PortableVersion);
                return 0;
            }

            var forwarded = ForwardedArguments(args);
            using (var mutex = new Mutex(false, "Local\\PiWebPortable.SingleExe"))
            {
                bool owns;
                try { owns = mutex.WaitOne(TimeSpan.FromMinutes(10)); }
                catch (AbandonedMutexException) { owns = true; }
                if (!owns) throw new TimeoutException("Another Pi Web installation step did not finish.");
                try
                {
                    var installed = ReadInstalledVersion(installDir);
                    if (installed == null)
                    {
                        RunWithProgress("正在安装 Pi Web 便携版 " + payload.PortableVersion + "…", report => FreshInstall(payload, installDir, report), null);
                    }
                    else if (CompareVersions(payload.PortableVersion, installed) > 0)
                    {
                        Log("Upgrading " + installDir + " from " + installed + " to " + payload.PortableVersion + ".");
                        return UpgradeInstalled(payload, installDir, args);
                    }
                }
                finally { mutex.ReleaseMutex(); }
            }

            var launcher = Path.Combine(installDir, LauncherName);
            if (HasArg(args, "--install-only")) return 0;
            var start = new ProcessStartInfo { FileName = launcher, Arguments = forwarded, UseShellExecute = false, WorkingDirectory = installDir };
            using (var child = Process.Start(start))
            {
                // Commands such as --self-test report through the exit code.
                if (HasArg(args, "--wait")) { child.WaitForExit(); return child.ExitCode; }
            }
            return 0;
        }
        catch (Exception error)
        {
            Log("Fatal: " + error);
            if (NonInteractive) Console.Error.WriteLine(error.Message);
            else MessageBox.Show("Pi Web 便携版启动失败：" + error.Message + (LogPath != null ? "\n\n日志：" + LogPath : ""), "Pi Web", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static string ResolveInstallDir(string[] args)
    {
        var dir = GetArg(args, "--install-dir");
        if (string.IsNullOrEmpty(dir)) dir = Environment.GetEnvironmentVariable("PI_WEB_PORTABLE_HOME");
        if (string.IsNullOrEmpty(dir))
            dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Pi-Web-Portable");
        dir = Path.GetFullPath(dir).TrimEnd(Path.DirectorySeparatorChar);
        if (dir.Length <= Path.GetPathRoot(dir).TrimEnd(Path.DirectorySeparatorChar).Length)
            throw new ArgumentException("Install directory cannot be a drive root.");
        return dir;
    }

    private static string ForwardedArguments(string[] args)
    {
        var parts = new StringBuilder();
        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            if (arg == "--install-dir") { i++; continue; }
            if (arg == "--install-only" || arg == "--wait") continue;
            if (parts.Length > 0) parts.Append(' ');
            parts.Append(Quote(arg));
        }
        return parts.ToString();
    }

    private static string ReadInstalledVersion(string installDir)
    {
        var manifest = Path.Combine(installDir, ManifestName);
        if (!File.Exists(manifest) || !File.Exists(Path.Combine(installDir, LauncherName))) return null;
        var match = Regex.Match(File.ReadAllText(manifest), "\"portableVersion\"\\s*:\\s*\"([^\"]+)\"");
        return match.Success ? match.Groups[1].Value : null;
    }

    private static void RunWithProgress(string title, Action<Action<int>> work, Action plainWork)
    {
        if (work == null) work = delegate { plainWork(); };
        if (NonInteractive) { work(delegate { }); return; }
        Exception failure = null;
        using (var form = new Form())
        {
            form.Text = "Pi Web";
            form.FormBorderStyle = FormBorderStyle.FixedDialog;
            form.MaximizeBox = false;
            form.MinimizeBox = false;
            form.ControlBox = false;
            form.StartPosition = FormStartPosition.CenterScreen;
            form.ClientSize = new System.Drawing.Size(420, 96);
            try { form.Icon = System.Drawing.Icon.ExtractAssociatedIcon(Process.GetCurrentProcess().MainModule.FileName); } catch { }
            var label = new Label { Text = title + "\n首次运行需要解压约 3 万个文件，请稍候。", Left = 16, Top = 12, Width = 388, Height = 40 };
            var bar = new ProgressBar { Left = 16, Top = 58, Width = 388, Height = 20, Minimum = 0, Maximum = 100 };
            if (plainWork != null) { bar.Style = ProgressBarStyle.Marquee; label.Text = title + "\n会保留 data 目录中的数据，请稍候。"; }
            form.Controls.Add(label);
            form.Controls.Add(bar);
            form.Shown += delegate
            {
                var thread = new Thread(() =>
                {
                    try
                    {
                        work(percent =>
                        {
                            try { form.BeginInvoke((Action)(() => bar.Value = Math.Max(0, Math.Min(100, percent)))); } catch { }
                        });
                    }
                    catch (Exception error) { failure = error; }
                    try { form.BeginInvoke((Action)form.Close); } catch { }
                });
                thread.IsBackground = true;
                thread.Start();
            };
            Application.EnableVisualStyles();
            Application.Run(form);
        }
        if (failure != null) throw new Exception(failure.Message, failure);
    }

    private static void FreshInstall(Payload payload, string installDir, Action<int> report)
    {
        Log("Installing portable " + payload.PortableVersion + " into " + installDir + ".");
        payload.VerifyHash();
        Log("Checksum verified.");
        var parent = Path.GetDirectoryName(installDir);
        Directory.CreateDirectory(parent);
        var staging = Path.Combine(parent, "PWP-" + Guid.NewGuid().ToString("N").Substring(0, 8));
        try
        {
            payload.ExtractTo(staging, report);
            Log("Extracted to " + staging + ".");
            if (!File.Exists(Path.Combine(staging, LauncherName)) || !File.Exists(Path.Combine(staging, ManifestName)))
                throw new InvalidDataException("Embedded package is incomplete.");
            var selfTest = RunAndWait(Path.Combine(staging, LauncherName), "--self-test --non-interactive", staging);
            if (selfTest != 0) throw new InvalidDataException("Embedded package self-test failed: " + selfTest);
            var logs = Path.Combine(staging, "logs");
            if (Directory.Exists(logs)) Directory.Delete(logs, true);

            if (Directory.Exists(installDir))
            {
                // A partial or broken earlier install. Keep it instead of deleting user files.
                var aside = installDir + ".broken-" + DateTime.Now.ToString("yyyyMMdd-HHmmss");
                Directory.Move(installDir, aside);
                Log("Moved incomplete installation to " + aside + ".");
            }
            Directory.Move(staging, installDir);
            staging = null;
            Log("Installed portable " + payload.PortableVersion + ".");
        }
        finally
        {
            if (staging != null && Directory.Exists(staging))
            {
                try { Directory.Delete(staging, true); } catch { }
            }
        }
    }

    private static int UpgradeInstalled(Payload payload, string installDir, string[] args)
    {
        // Reuse the regular portable updater (session check, server stop, backup and
        // rollback). It runs from a temp copy of the new launcher in the payload.
        payload.VerifyHash();
        var temp = Path.GetTempPath();
        var archive = Path.Combine(temp, "pi-web-portable-" + Guid.NewGuid().ToString("N") + ".zip");
        var updater = Path.Combine(temp, "PiWebPortableUpdater-" + Guid.NewGuid().ToString("N") + ".exe");
        payload.CopyZipTo(archive);
        payload.ExtractEntry(LauncherName, updater);
        var port = GetArg(args, "--port");
        var arguments = "--apply-update --target " + Quote(installDir) + " --archive " + Quote(archive)
            + (HasArg(args, "--install-only") ? "" : " --relaunch")
            + (string.IsNullOrEmpty(port) ? "" : " --port " + Quote(port))
            + (NonInteractive ? " --non-interactive" : "");
        if (HasArg(args, "--wait") || HasArg(args, "--install-only") || !NonInteractive)
        {
            var code = 0;
            RunWithProgress("正在升级 Pi Web 便携版到 " + payload.PortableVersion + "…", null, delegate { code = RunAndWait(updater, arguments, temp); });
            TryDelete(updater);
            TryDelete(archive);
            return code;
        }
        // The updater deletes the archive itself after a successful install.
        Process.Start(new ProcessStartInfo { FileName = updater, Arguments = arguments, UseShellExecute = false, WorkingDirectory = temp });
        return 0;
    }

    private static int RunAndWait(string file, string arguments, string workingDirectory)
    {
        using (var process = Process.Start(new ProcessStartInfo { FileName = file, Arguments = arguments, UseShellExecute = false, WorkingDirectory = workingDirectory, CreateNoWindow = true }))
        {
            process.WaitForExit();
            return process.ExitCode;
        }
    }

    private static int CompareVersions(string a, string b)
    {
        Version left, right;
        if (!Version.TryParse(a, out left)) left = new Version(0, 0);
        if (!Version.TryParse(b, out right)) right = new Version(0, 0);
        return left.CompareTo(right);
    }

    private static bool HasArg(string[] args, string name)
    {
        foreach (var arg in args) if (string.Equals(arg, name, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private static string GetArg(string[] args, string name)
    {
        for (var i = 0; i < args.Length - 1; i++)
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase)) return args[i + 1];
        return null;
    }

    private static string Quote(string value)
    {
        value = value ?? "";
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static void TryDelete(string path)
    {
        for (var attempt = 0; attempt < 10; attempt++)
        {
            try { if (File.Exists(path)) File.Delete(path); return; }
            catch { Thread.Sleep(500); }
        }
    }

    private static void Log(string message)
    {
        if (LogPath == null) return;
        try { File.AppendAllText(LogPath, DateTime.Now.ToString("o") + " " + message + Environment.NewLine); } catch { }
    }

    private sealed class Payload
    {
        public string Path;
        public long ZipOffset;
        public long ZipLength;
        public string PortableVersion;
        public string Sha256;

        public static Payload Read(string exe)
        {
            using (var file = File.OpenRead(exe))
            using (var reader = new BinaryReader(file))
            {
                if (file.Length < 24) throw new InvalidDataException("Embedded package is missing.");
                file.Seek(-24, SeekOrigin.End);
                var zipLength = reader.ReadInt64();
                var headerLength = reader.ReadInt64();
                var magic = Encoding.ASCII.GetString(reader.ReadBytes(8));
                if (magic != Magic || headerLength <= 0 || headerLength > 65536 || zipLength <= 0 || zipLength + headerLength + 24 > file.Length)
                    throw new InvalidDataException("Embedded package is missing or damaged.");
                file.Seek(-24 - headerLength, SeekOrigin.End);
                var header = Encoding.UTF8.GetString(reader.ReadBytes((int)headerLength));
                var version = Regex.Match(header, "\"portableVersion\"\\s*:\\s*\"(\\d+\\.\\d+\\.\\d+)\"");
                var hash = Regex.Match(header, "\"sha256\"\\s*:\\s*\"([0-9a-f]{64})\"");
                if (!version.Success || !hash.Success) throw new InvalidDataException("Embedded package header is invalid.");
                return new Payload
                {
                    Path = exe,
                    ZipLength = zipLength,
                    ZipOffset = file.Length - 24 - headerLength - zipLength,
                    PortableVersion = version.Groups[1].Value,
                    Sha256 = hash.Groups[1].Value,
                };
            }
        }

        private Stream OpenZip()
        {
            return new WindowStream(new FileStream(Path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 16), ZipOffset, ZipLength);
        }

        public void VerifyHash()
        {
            using (var stream = OpenZip())
            using (var sha = SHA256.Create())
            {
                var actual = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                if (actual != Sha256) throw new InvalidDataException("Embedded package checksum mismatch. Download the executable again.");
            }
        }

        public void CopyZipTo(string destination)
        {
            using (var source = OpenZip())
            using (var target = File.Create(destination))
                source.CopyTo(target, 1 << 20);
        }

        public void ExtractTo(string destination, Action<int> report)
        {
            var root = System.IO.Path.GetFullPath(destination).TrimEnd(System.IO.Path.DirectorySeparatorChar) + System.IO.Path.DirectorySeparatorChar;
            Directory.CreateDirectory(root);
            using (var zip = new ZipArchive(OpenZip(), ZipArchiveMode.Read))
            {
                var total = zip.Entries.Count;
                var done = 0;
                var lastPercent = -1;
                foreach (var entry in zip.Entries)
                {
                    var percent = total == 0 ? 100 : (int)(++done * 95L / total);
                    if (percent != lastPercent) { lastPercent = percent; report(percent); }
                    var target = System.IO.Path.GetFullPath(System.IO.Path.Combine(root, entry.FullName));
                    if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("Embedded package contains an unsafe path.");
                    if (entry.FullName.EndsWith("/") || entry.FullName.EndsWith("\\"))
                    {
                        Directory.CreateDirectory(target);
                        continue;
                    }
                    Directory.CreateDirectory(System.IO.Path.GetDirectoryName(target));
                    entry.ExtractToFile(target, true);
                }
            }
        }

        public void ExtractEntry(string name, string destination)
        {
            using (var zip = new ZipArchive(OpenZip(), ZipArchiveMode.Read))
            {
                var entry = zip.GetEntry(name);
                if (entry == null) throw new InvalidDataException("Embedded package has no " + name + ".");
                entry.ExtractToFile(destination, true);
            }
        }
    }

    // Read-only seekable view of a byte range inside another stream.
    private sealed class WindowStream : Stream
    {
        private readonly Stream inner;
        private readonly long offset;
        private readonly long length;
        private long position;

        public WindowStream(Stream inner, long offset, long length)
        {
            this.inner = inner;
            this.offset = offset;
            this.length = length;
        }

        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return true; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return length; } }
        public override long Position
        {
            get { return position; }
            set { if (value < 0) throw new IOException("Negative position."); position = value; }
        }

        public override int Read(byte[] buffer, int index, int count)
        {
            var remaining = length - position;
            if (remaining <= 0) return 0;
            if (count > remaining) count = (int)remaining;
            var absolute = offset + position;
            if (inner.Position != absolute) inner.Position = absolute;
            var read = inner.Read(buffer, index, count);
            position += read;
            return read;
        }

        public override long Seek(long value, SeekOrigin origin)
        {
            var next = origin == SeekOrigin.Begin ? value : origin == SeekOrigin.Current ? position + value : length + value;
            Position = next;
            return position;
        }

        public override void Flush() { }
        public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int index, int count) { throw new NotSupportedException(); }

        protected override void Dispose(bool disposing)
        {
            if (disposing) inner.Dispose();
            base.Dispose(disposing);
        }
    }
}
