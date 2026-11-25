using System;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Text;
using System.Diagnostics;
using System.Threading;
using System.Drawing;
using System.Drawing.Imaging;
using System.Windows.Forms;
using System.Runtime.InteropServices;

namespace KTerm
{
    class Program
    {
        static string AgentVersion = "2.0.0";
        static string ServerUrl = "https://kotukole.com/lap";
        static string AgentSecret = Environment.GetEnvironmentVariable("KTERM_AGENT_SECRET") ?? "";
        static string CurrentWorkDir = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        static string LogPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "KTerm", "agent.log");
        static int BackoffSec = 1;
        static NotifyIcon TrayIcon = null;
        static Mutex SingleMutex = null;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
        public class MEMORYSTATUSEX
        {
            public uint dwLength;
            public uint dwMemoryLoad;
            public ulong ullTotalPhys;
            public ulong ullAvailPhys;
            public ulong ullTotalPageFile;
            public ulong ullAvailPageFile;
            public ulong ullTotalVirtual;
            public ulong ullAvailVirtual;
            public ulong ullAvailExtendedVirtual;
            public MEMORYSTATUSEX() { this.dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX)); }
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct SYSTEM_POWER_STATUS
        {
            public byte ACLineStatus;
            public byte BatteryFlag;
            public byte BatteryLifePercent;
            public byte SystemStatusFlag;
            public int BatteryLifeTime;
            public int BatteryFullLifeTime;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        public static extern bool GlobalMemoryStatusEx([In, Out] MEMORYSTATUSEX lpBuffer);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS sps);

        static void WriteLog(string msg)
        {
            try
            {
                string dir = Path.GetDirectoryName(LogPath);
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                if (File.Exists(LogPath) && new FileInfo(LogPath).Length > 2 * 1024 * 1024)
                {
                    string old = LogPath + ".old";
                    if (File.Exists(old)) File.Delete(old);
                    File.Move(LogPath, old);
                }
                File.AppendAllText(LogPath, "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + msg + Environment.NewLine);
            }
            catch { }
        }

        [STAThread]
        static void Main(string[] args)
        {
            bool createdNew = false;
            SingleMutex = new Mutex(true, "Global\\KTermNativeAgent", out createdNew);
            if (!createdNew) return;

            try
            {
                ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | SecurityProtocolType.Tls;
                ServicePointManager.ServerCertificateValidationCallback = delegate { return true; };
                ServicePointManager.DefaultConnectionLimit = 20;
            }
            catch { }

            if (args != null && args.Length > 0 && !string.IsNullOrEmpty(args[0]))
            {
                ServerUrl = args[0].TrimEnd('/');
            }
            if (args != null && args.Length > 1 && !string.IsNullOrEmpty(args[1]))
            {
                AgentSecret = args[1];
            }

            try
            {
                NetworkChange.NetworkAddressChanged += delegate { BackoffSec = 1; };
                Microsoft.Win32.SystemEvents.PowerModeChanged += delegate(object s, Microsoft.Win32.PowerModeChangedEventArgs e)
                {
                    if (e.Mode == Microsoft.Win32.PowerModes.Resume) BackoffSec = 1;
                };
            }
            catch { }

            // Start background polling thread
            Thread worker = new Thread(RunLoop);
            worker.IsBackground = true;
            worker.Start();

            // System Tray Icon
            try
            {
                Application.EnableVisualStyles();
                TrayIcon = new NotifyIcon();
                TrayIcon.Icon = SystemIcons.Information;
                TrayIcon.Text = "K-Term Agent v" + AgentVersion + " (" + Environment.MachineName + ")";
                var menu = new ContextMenuStrip();
                menu.Items.Add("Open Agent Log", null, delegate
                {
                    try { Process.Start("notepad.exe", "\"" + LogPath + "\""); } catch { }
                });
                menu.Items.Add("Exit K-Term Agent", null, delegate
                {
                    try { TrayIcon.Visible = false; TrayIcon.Dispose(); } catch { }
                    try { SingleMutex.ReleaseMutex(); SingleMutex.Dispose(); } catch { }
                    Application.Exit();
                    Environment.Exit(0);
                });
                TrayIcon.ContextMenuStrip = menu;
                TrayIcon.Visible = true;
                Application.Run();
            }
            catch
            {
                // Headless fallback
                while (true) Thread.Sleep(60000);
            }
        }

        static void RunLoop()
        {
            string cpuModel = "";
            try
            {
                using (var key = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"HARDWARE\DESCRIPTION\System\CentralProcessor\0"))
                {
                    if (key != null)
                    {
                        object val = key.GetValue("ProcessorNameString");
                        if (val != null) cpuModel = val.ToString().Trim();
                    }
                }
            }
            catch { }
            if (string.IsNullOrEmpty(cpuModel)) cpuModel = Environment.GetEnvironmentVariable("PROCESSOR_IDENTIFIER") ?? "Windows Processor";

            string deviceId = Environment.MachineName + "@" + Environment.UserName;
            WriteLog("K-Term Native Tray Agent v" + AgentVersion + " started -> " + ServerUrl + " (" + deviceId + ")");

            string lastHandledId = "";

            while (true)
            {
                while (!NetworkInterface.GetIsNetworkAvailable())
                {
                    Thread.Sleep(3000);
                }

                try
                {
                    string ramTotal = "Unknown", ramUsed = "Unknown", ramPct = "0";
                    try
                    {
                        var mem = new MEMORYSTATUSEX();
                        if (GlobalMemoryStatusEx(mem))
                        {
                            double totalGb = Math.Round((double)mem.ullTotalPhys / (1024 * 1024 * 1024), 1);
                            double freeGb = Math.Round((double)mem.ullAvailPhys / (1024 * 1024 * 1024), 1);
                            double usedGb = Math.Round(totalGb - freeGb, 1);
                            ramTotal = totalGb + " GB";
                            ramUsed = usedGb + " GB";
                            ramPct = mem.dwMemoryLoad.ToString();
                        }
                    }
                    catch { }

                    string diskTotal = "Unknown", diskFree = "Unknown", diskPct = "0%";
                    try
                    {
                        foreach (var drive in DriveInfo.GetDrives())
                        {
                            if (drive.IsReady && drive.DriveType == DriveType.Fixed)
                            {
                                double totalGb = Math.Round((double)drive.TotalSize / (1024 * 1024 * 1024), 1);
                                double freeGb = Math.Round((double)drive.TotalFreeSpace / (1024 * 1024 * 1024), 1);
                                double usedGb = Math.Round(totalGb - freeGb, 1);
                                diskTotal = totalGb + " GB (" + drive.Name.Replace("\\", "") + ")";
                                diskFree = freeGb + " GB Free";
                                diskPct = Math.Round((usedGb / totalGb) * 100).ToString() + "%";
                                break;
                            }
                        }
                    }
                    catch { }

                    string batteryPct = "", batteryStatus = "";
                    try
                    {
                        SYSTEM_POWER_STATUS sps;
                        if (GetSystemPowerStatus(out sps) && sps.BatteryLifePercent <= 100)
                        {
                            batteryPct = sps.BatteryLifePercent + "%";
                            batteryStatus = sps.ACLineStatus == 1 ? "Charging/AC" : "On Battery";
                        }
                    }
                    catch { }

                    string pollData = "{"
                        + "\"deviceId\":\"" + EscapeJson(deviceId) + "\","
                        + "\"version\":\"" + AgentVersion + "\","
                        + "\"hostname\":\"" + EscapeJson(Environment.MachineName) + "\","
                        + "\"user\":\"" + EscapeJson(Environment.UserName) + "\","
                        + "\"os\":\"" + EscapeJson(Environment.OSVersion.ToString()) + "\","
                        + "\"cpuModel\":\"" + EscapeJson(cpuModel) + "\","
                        + "\"cores\":\"" + Environment.ProcessorCount + "\","
                        + "\"ramTotal\":\"" + EscapeJson(ramTotal) + "\","
                        + "\"ramUsed\":\"" + EscapeJson(ramUsed) + "\","
                        + "\"ramPercent\":\"" + EscapeJson(ramPct) + "\","
                        + "\"diskTotal\":\"" + EscapeJson(diskTotal) + "\","
                        + "\"diskFree\":\"" + EscapeJson(diskFree) + "\","
                        + "\"diskPercent\":\"" + EscapeJson(diskPct) + "\","
                        + "\"battery\":\"" + EscapeJson(batteryPct) + "\","
                        + "\"batteryStatus\":\"" + EscapeJson(batteryStatus) + "\""
                        + "}";

                    string pollResp = PostJson(ServerUrl + "/api/agent/poll", pollData);
                    BackoffSec = 1;

                    if (!string.IsNullOrEmpty(pollResp))
                    {
                        string cmdId = ExtractJsonValue(pollResp, "id");
                        string cmd = ExtractJsonValue(pollResp, "cmd");

                        if (!string.IsNullOrEmpty(cmd) && cmdId != lastHandledId)
                        {
                            lastHandledId = cmdId;
                            WriteLog("CMD: " + cmd);
                            string result = ExecuteCommand(cmd);
                            string resultPayload = "{"
                                + "\"id\":\"" + EscapeJson(cmdId) + "\","
                                + "\"output\":\"" + EscapeJson(result) + "\""
                                + "}";
                            PostJson(ServerUrl + "/api/agent/result", resultPayload);
                        }
                    }
                }
                catch (Exception ex)
                {
                    WriteLog("Poll error: " + ex.Message);
                    BackoffSec = Math.Min(15, BackoffSec * 2);
                }

                Thread.Sleep(BackoffSec * 1000);
            }
        }

        static string ExecuteCommand(string cmd)
        {
            try
            {
                string trimmed = cmd.Trim();
                if (trimmed.StartsWith("cd ", StringComparison.OrdinalIgnoreCase))
                {
                    string target = trimmed.Substring(3).Trim().Trim('"');
                    string combinedPath = Path.IsPathRooted(target) ? target : Path.GetFullPath(Path.Combine(CurrentWorkDir, target));
                    if (Directory.Exists(combinedPath))
                    {
                        CurrentWorkDir = combinedPath;
                        return "Directory changed to: " + CurrentWorkDir;
                    }
                    return "The system cannot find the path specified: " + combinedPath;
                }

                var startInfo = new ProcessStartInfo
                {
                    FileName = "cmd.exe",
                    Arguments = "/c " + cmd,
                    WorkingDirectory = Directory.Exists(CurrentWorkDir) ? CurrentWorkDir : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };

                using (var proc = new Process { StartInfo = startInfo })
                {
                    proc.Start();
                    string stdout = proc.StandardOutput.ReadToEnd();
                    string stderr = proc.StandardError.ReadToEnd();
                    bool exited = proc.WaitForExit(30000);

                    if (!exited)
                    {
                        try { proc.Kill(); } catch { }
                        return "[ERROR] Command timed out after 30 seconds.\n" + stdout;
                    }

                    string combined = "";
                    if (!string.IsNullOrEmpty(stdout)) combined += stdout;
                    if (!string.IsNullOrEmpty(stderr)) combined += (combined.Length > 0 ? "\n" : "") + stderr;
                    return string.IsNullOrEmpty(combined) ? "(Command completed successfully with no output)" : combined;
                }
            }
            catch (Exception ex)
            {
                return "[Execution Error]: " + ex.Message;
            }
        }

        static string PostJson(string url, string data)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(data);
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "POST";
            req.ContentType = "application/json";
            req.ContentLength = bytes.Length;
            req.Timeout = 12000;
            if (!string.IsNullOrEmpty(AgentSecret))
            {
                req.Headers["X-Agent-Secret"] = AgentSecret;
            }

            using (var stream = req.GetRequestStream())
            {
                stream.Write(bytes, 0, bytes.Length);
            }

            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
            {
                return reader.ReadToEnd();
            }
        }

        static string ExtractJsonValue(string json, string key)
        {
            string pattern = "\"" + key + "\":\"";
            int idx = json.IndexOf(pattern);
            if (idx == -1) return null;
            idx += pattern.Length;
            StringBuilder sb = new StringBuilder();
            bool escaped = false;
            for (int i = idx; i < json.Length; i++)
            {
                char c = json[i];
                if (escaped)
                {
                    if (c == 'n') sb.Append('\n');
                    else if (c == 'r') sb.Append('\r');
                    else if (c == 't') sb.Append('\t');
                    else sb.Append(c);
                    escaped = false;
                }
                else if (c == '\\')
                {
                    escaped = true;
                }
                else if (c == '"')
                {
                    return sb.ToString();
                }
                else
                {
                    sb.Append(c);
                }
            }
            return null;
        }

        static string EscapeJson(string str)
        {
            if (string.IsNullOrEmpty(str)) return "";
            return str.Replace("\\", "\\\\")
                      .Replace("\"", "\\\"")
                      .Replace("\r", "\\r")
                      .Replace("\n", "\\n")
                      .Replace("\t", "\\t");
        }
    }
}
