# KotuKole ⚡ Web Terminal & Hardware Monitor Console

A high-performance remote terminal and hardware inspection console connecting physical Windows computers to a web-based dashboard via a lightweight reverse agent.

---

## 📁 Project Architecture & Components

1. **`server.js`**
   - Node.js backend running on the server.
   - Manages reverse agent polling (`/api/agent/poll`), command dispatching, live Server-Sent Events (SSE) streaming (`/api/exec`), and authentication.
   - Protected with access password: `DINUJAYA` (configurable via `LAP_PASSWORD`).

2. **`public/index.html`**
   - Modern, responsive web terminal and hardware dashboard.
   - Live real-time hardware gauges for CPU, RAM, Disk, and System OS.
   - Quick action chips for Specs, RAM Info, Disks, Wi-Fi Profiles, Wi-Fi Passwords extractor, Signal Strength, Public IP, Apps, Files, Lock Screen, and Text-to-Speech.
   - Command history navigation (Arrow Up / Arrow Down), Copy Output, and Fullscreen toggle.

3. **`KotuKoleAgent.cs`**
   - High-performance, lightweight (12KB) C# Windows client.
   - Built with native .NET 4.0/4.8 compatibility.
   - Gathers live CPU, RAM (`GlobalMemoryStatusEx`), and Disk metrics and executes commands via `cmd.exe /c`.

4. **`agent.ps1`**
   - Zero-install Windows PowerShell edition of the agent.
   - Runs directly on modern Windows 10/11 using:
     ```powershell
     irm https://kotukole.com/lap/agent.ps1 | iex
     ```

5. **`Start-Laptop-Agent.bat`**
   - 1-Click launcher script for Windows.
   - Clears cache, downloads the latest compiled agent executable, and runs it with auto-pause fallback.

---

## 🚀 How to Run Locally

### 1. Starting the Server:
```bash
npm install
node server.js
```
The server runs on port `3880`.

### 2. Connecting a Windows Machine:
Open PowerShell on the Windows machine and run:
```powershell
irm https://kotukole.com/lap/agent.ps1 | iex
```
Or double-click `Start-Laptop-Agent.bat` / run `KotuKole-Laptop.exe`.

---
⚡ *Built with KotuKole Engine for Dinujaya.*
