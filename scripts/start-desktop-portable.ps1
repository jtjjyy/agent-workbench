param(
  [string]$ExecutablePath = (Join-Path $PSScriptRoot '..\out\Agent Workbench-win32-x64\agent-workbench.exe')
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
  throw '指定便携版可执行文件不存在。请明确选择当前源码生成的产物；脚本不会回退到旧 stage1 产物。'
}
$taskExecutable = (Resolve-Path -LiteralPath $ExecutablePath).Path
if ([IO.Path]::GetFileName($taskExecutable) -ne 'agent-workbench.exe') {
  throw '请选择当前产品的 agent-workbench.exe，未启动其他程序。'
}
Start-Process -WindowStyle Hidden -FilePath $taskExecutable -WorkingDirectory ([IO.Path]::GetDirectoryName($taskExecutable)) | Out-Null
Write-Output "已请求启动便携版：$taskExecutable。此消息不代表客户端启动成功。"
