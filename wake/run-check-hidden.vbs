' HoshinoSumi scheduled-task hidden runner (invoked by Task Scheduler via wscript)
' WScript.Shell.Run windowStyle=0 hides the cmd window; False = do not wait.
' Directory is derived from ScriptFullName so no hardcoded (possibly non-ASCII) path.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c """ & dir & "\run-check.cmd""", 0, False
