# K-Term ⚡ Web Terminal, Hardware Monitor, Webcam & Audio Console

A high-performance remote administration console and hardware inspection dashboard connecting physical Windows laptops to a web-based management center with live terminal execution, real-time screen capture, instant webcam photos, and live ambient microphone recording.

---

## 📁 Unified System Architecture & Components

1. **`server.js` (Unified Backend Server)**
   - Single Node.js server running on port `3880`.
   - Reverse agent command dispatch & polling (`/api/agent/poll`, `/api/agent/result`, `/api/poll`).
   - Live Server-Sent Events (SSE) streaming for real-time terminal output, webcam broadcasts, and multimedia audio (`/api/events`, `/api/exec`).
   - Multipart webcam and audio uploads with automatic storage in `public/uploads/`.
   - Protected with access authentication: `DINUJAYA` (configurable via `LAP_PASSWORD`).

2. **`public/index.html` (All-in-One Dashboard)**
   - Modern, responsive web terminal and hardware inspection console.
   - Live real-time hardware gauges for CPU, RAM, Disk, and System OS.
   - Quick action chips for System Specs, RAM breakdown, Disks, 📸 Screen Capture, 📷 Webcam Photo Capture, 🎙️ Mic Record (5s), Wi-Fi Profiles, Wi-Fi Passwords extractor, Signal Strength, Public IP, Apps, Files, and Lock Screen.
   - Live interactive modals and cards for Screen Capture, Webcam Photos, and an inline dark-mode Audio Player with instant playback and download.

3. **`public/webcam.html` (Dedicated Webcam Console)**
   - Lightweight standalone webcam trigger and live photo viewer console.
   - Accessible directly at `https://kotukole.com/lap/webcam.html`.

4. **`agent.ps1` (Zero-Install PowerShell Agent)**
   - Runs directly on modern Windows 10/11 machines without installation:
     ```powershell
     irm https://kotukole.com/lap/agent.ps1 | iex
     ```

5. **`webcam-agent.ps1` (Standalone Webcam Agent)**
   - Windows client using native `avicap32.dll` to poll `/api/poll` and upload snapshots to `/api/upload-webcam`.
   - Supports configurable ServerURL parameter:
     ```powershell
     powershell -ExecutionPolicy Bypass -File .\webcam-agent.ps1 -ServerURL https://kotukole.com/lap
     ```

6. **`KTermAgent.cs` / `K-Term.exe` (Compiled Native Agent)**
   - High-performance, lightweight (12KB) C# Windows client.

---

## 🚀 How to Run Locally

### 1. Starting the Unified Server:
```bash
npm install
npm start
# Server runs on http://localhost:3880
```

### 2. Connecting a Windows Machine (Full Terminal & Console Agent):
Open PowerShell on your Windows laptop and run:
```powershell
irm https://kotukole.com/lap/agent.ps1 | iex
```

### 3. Connecting a Windows Machine (Standalone Webcam Agent):
Open PowerShell on your Windows laptop and run:
```powershell
powershell -ExecutionPolicy Bypass -File .\webcam-agent.ps1
```

---
⚡ *Built with K-Term Engine for Dinujaya.*
