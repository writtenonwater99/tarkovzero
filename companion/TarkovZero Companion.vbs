' TarkovZero Companion — double-click launcher.
' Starts "node companion.mjs" in this script's own folder with no console window;
' the companion opens its UI at http://127.0.0.1:4173 in your browser.
' Use start-companion.cmd instead if you want to see the console output.
Option Explicit
Dim sh, fso, folder, nodeExe
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = folder
nodeExe = "C:\Program Files\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node"
sh.Run """" & nodeExe & """ ""companion.mjs""", 0, False
