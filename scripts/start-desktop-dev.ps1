param(
  [string]$ProjectRoot = (Join-Path $PSScriptRoot '..')
)

$ErrorActionPreference = 'Stop'
$taskProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
if (-not (Test-Path -LiteralPath (Join-Path $taskProjectRoot 'forge.config.mts') -PathType Leaf)) {
  throw '指定路径不是当前桌面项目，未启动。'
}
$taskNpm = (Get-Command npm.cmd -ErrorAction Stop).Source
$taskShell = Join-Path $PSHOME 'powershell.exe'
if (-not (Test-Path -LiteralPath $taskShell -PathType Leaf)) {
  $taskShell = (Get-Command pwsh.exe -ErrorAction Stop).Source
}
$taskCommand = "& '$($taskNpm.Replace("'", "''"))' --prefix '$($taskProjectRoot.Replace("'", "''"))' start"
$taskEncodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($taskCommand))
Start-Process -WindowStyle Hidden -FilePath $taskShell -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $taskEncodedCommand) -WorkingDirectory $taskProjectRoot | Out-Null
Write-Output '已请求启动开发客户端。开发入口会编译源码；此消息不代表编译或启动成功。'
