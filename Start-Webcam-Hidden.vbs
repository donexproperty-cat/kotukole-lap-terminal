Set WshShell = CreateObject("WScript.Shell")
strPath = WshShell.ExpandEnvironmentStrings(Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\")))
WshShell.Run "powershell.exe -ExecutionPolicy Bypass -sta -WindowStyle Hidden -File """ & strPath & "webcam-agent.ps1""", 0, False
