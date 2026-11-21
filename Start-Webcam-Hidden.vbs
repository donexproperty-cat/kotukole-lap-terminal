Set WshShell = CreateObject("WScript.Shell")
strPath = WshShell.ExpandEnvironmentStrings(Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\")))
WshShell.Run "powershell.exe -ExecutionPolicy Bypass -sta -WindowStyle Hidden -File """ & strPath & "webcam-agent.ps1""", 0, False
WshShell.Popup "K-Term Webcam Agent සාර්ථකව Background එකේ Start විය!" & vbCrLf & vbCrLf & "දැන් https://kotukole.com/lap/ එකෙන් 'Capture Webcam' ඔබන්න.", 5, "K-Term Webcam Agent", 64
