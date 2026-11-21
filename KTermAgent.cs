using System;
using System.IO;
using System.Net;
using System.Text;
using System.Diagnostics;
using System.Threading;
using System.Runtime.InteropServices;

namespace KTerm
{
    class Program
    {
        static string ServerUrl = "https://kotukole.com/lap";

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
            public MEMORYSTATUSEX()
            {
                this.dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
            }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        public static extern bool GlobalMemoryStatusEx([In, Out] MEMORYSTATUSEX lpBuffer);

        // Keep Main minimal so JIT cannot fail before try-catch is active
        static void Main(string[] args)
        {
            AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("\n[UNHANDLED ERROR]: " + (e.ExceptionObject != null ? e.ExceptionObject.ToString() : "Unknown error"));
                Console.ResetColor();
                Console.WriteLine("\nPress Enter to exit...");
                try { Console.ReadLine(); } catch { }
            };

            try
            {
                RunAgent(args);
            }
            catch (Exception ex)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("\n[STARTUP / RUNTIME ERROR]: " + ex.ToString());
                Console.ResetColor();
                Console.WriteLine("\nPress Enter to exit...");
                try { Console.ReadLine(); } catch { }
            }
        }

        static void RunAgent(string[] args)
        {
            Console.Title = "K-Term ⚡ Physical Laptop Agent";
            Console.ForegroundColor = ConsoleColor.Cyan;
            Console.WriteLine("=================================================================");
            Console.WriteLine("        ⚡ K-TERM PHYSICAL LAPTOP CONNECTOR AGENT ⚡             ");
            Console.WriteLine("=================================================================\n");
            Console.ResetColor();

            // Enable TLS 1.2 on Windows .NET Framework 4.0/4.5+
            try
            {
                ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | SecurityProtocolType.Tls;
                ServicePointManager.ServerCertificateValidationCallback = delegate { return true; };
                ServicePointManager.DefaultConnectionLimit = 20;
            }
            catch { }

            if (args != null && args.Length > 0 && !string.IsNullOrEmpty(args[0]))
            {
                ServerUrl = args[0];
                while (ServerUrl.EndsWith("/"))
                {
                    ServerUrl = ServerUrl.Substring(0, ServerUrl.Length - 1);
                }
            }

            // Detect CPU Model via Registry or Environment
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

            if (string.IsNullOrEmpty(cpuModel))
            {
                cpuModel = Environment.GetEnvironmentVariable("PROCESSOR_IDENTIFIER");
                if (string.IsNullOrEmpty(cpuModel)) cpuModel = "Windows Processor";
            }

            Console.WriteLine("[*] Connecting your laptop to : " + ServerUrl);
            Console.WriteLine("[*] Machine Name              : " + Environment.MachineName);
            Console.WriteLine("[*] User Name                 : " + Environment.UserName);
            Console.WriteLine("[*] Processor (CPU)           : " + cpuModel);
            Console.WriteLine("[*] CPU Cores                 : " + Environment.ProcessorCount);
            Console.WriteLine("[*] Operating OS              : " + Environment.OSVersion.ToString());
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine("\n[+] Status: CONNECTED & LISTENING for commands from Server");
            Console.WriteLine("[+] Keep this window open while using the web console.\n");
            Console.ResetColor();

            string lastHandledId = "";

            while (true)
            {
                try
                {
                    // Live Memory (RAM)
                    string ramTotal = "Unknown";
                    string ramUsed = "Unknown";
                    string ramPct = "0";
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

                    // Live Storage (C: Drive)
                    string diskTotal = "Unknown";
                    string diskFree = "Unknown";
                    string diskPct = "0%";
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

                    string pollData = "{"
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
                        + "\"diskPercent\":\"" + EscapeJson(diskPct) + "\""
                        + "}";

                    string pollResp = PostJson(ServerUrl + "/api/agent/poll", pollData);

                    if (!string.IsNullOrEmpty(pollResp))
                    {
                        string cmdId = ExtractJsonValue(pollResp, "id");
                        string cmd = ExtractJsonValue(pollResp, "cmd");

                        if (!string.IsNullOrEmpty(cmd) && cmdId != lastHandledId)
                        {
                            lastHandledId = cmdId;
                            Console.ForegroundColor = ConsoleColor.Yellow;
                            Console.WriteLine("[" + DateTime.Now.ToString("HH:mm:ss") + "] [CMD RECEIVED] " + cmd);
                            Console.ResetColor();

                            string result = ExecuteCommand(cmd);

                            string resultPayload = "{"
                                + "\"id\":\"" + EscapeJson(cmdId) + "\","
                                + "\"output\":\"" + EscapeJson(result) + "\""
                                + "}";

                            PostJson(ServerUrl + "/api/agent/result", resultPayload);
                            Console.ForegroundColor = ConsoleColor.Green;
                            Console.WriteLine("[" + DateTime.Now.ToString("HH:mm:ss") + "] [RESULT SENT BACK TO WEB CONSOLE]");
                            Console.ResetColor();
                        }
                    }
                }
                catch
                {
                    // Network hiccup - silent retry
                }

                Thread.Sleep(1000);
            }
        }

        static string ExecuteCommand(string cmd)
        {
            try
            {
                var startInfo = new ProcessStartInfo
                {
                    FileName = "cmd.exe",
                    Arguments = "/c " + cmd,
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
            int endIdx = json.IndexOf("\"", idx);
            if (endIdx == -1) return null;
            string val = json.Substring(idx, endIdx - idx);
            return UnescapeJson(val);
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

        static string UnescapeJson(string str)
        {
            if (string.IsNullOrEmpty(str)) return "";
            return str.Replace("\\n", "\n")
                      .Replace("\\r", "\r")
                      .Replace("\\t", "\t")
                      .Replace("\\\"", "\"")
                      .Replace("\\\\", "\\");
        }
    }
}
