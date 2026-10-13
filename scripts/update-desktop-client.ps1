param(
  [string]$PackageDirectory = (Join-Path $PSScriptRoot '..\out\Agent Workbench-win32-x64'),
  [string]$InstallationRoot = (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Applications\AgentWorkbench'),
  [switch]$Launch
)

$ErrorActionPreference = 'Stop'
$packageRoot = (Resolve-Path -LiteralPath $PackageDirectory).Path
$sourceExecutable = Join-Path $packageRoot 'agent-workbench.exe'
if (-not (Test-Path -LiteralPath $sourceExecutable -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $packageRoot 'resources\app.asar') -PathType Leaf)) {
  throw '没有找到完整的当前客户端产物，未更新桌面入口。'
}
$version = (Get-Item -LiteralPath $sourceExecutable).VersionInfo.ProductVersion
if ($version -notmatch '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$') {
  throw '客户端产物版本无效，未更新。'
}
$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop -or -not [IO.Path]::IsPathRooted($InstallationRoot)) {
  throw '无法确定桌面或安装目录不是绝对路径。'
}
$releaseRoot = Join-Path ([IO.Path]::GetFullPath($InstallationRoot)) 'releases'
$legacyReleaseRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AgentWorkbench\releases'
$releasePath = Join-Path $releaseRoot "$version-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
New-Item -ItemType Directory -Path $releasePath | Out-Null
Get-ChildItem -LiteralPath $packageRoot -Force | Copy-Item -Destination $releasePath -Recurse
$executable = Join-Path $releasePath 'agent-workbench.exe'
if ((Get-FileHash -LiteralPath $sourceExecutable -Algorithm SHA256).Hash -ne
    (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash -or
    (Get-FileHash -LiteralPath (Join-Path $packageRoot 'resources\app.asar') -Algorithm SHA256).Hash -ne
    (Get-FileHash -LiteralPath (Join-Path $releasePath 'resources\app.asar') -Algorithm SHA256).Hash) {
  throw '复制后的客户端内容不一致，桌面入口未更新；复制文件保留供检查。'
}

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$linkBackup = Join-Path $releasePath 'shortcut-backups'
New-Item -ItemType Directory -Path $linkBackup | Out-Null
$shell = New-Object -ComObject WScript.Shell
$updatedLinks = @()
$linkNames = @('开发者智能体工作台.lnk', '开发者智能体工作台（最新源码）.lnk', 'Agent Workbench.lnk')
foreach ($name in $linkNames) {
  $linkPath = Join-Path $desktop $name
  if (Test-Path -LiteralPath $linkPath) {
    $old = $shell.CreateShortcut($linkPath)
    $belongsToProject = $old.WorkingDirectory -eq $projectRoot -or
      $old.WorkingDirectory.StartsWith($releaseRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
      $old.WorkingDirectory.StartsWith($legacyReleaseRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
      $old.TargetPath -eq $sourceExecutable
    if (-not $belongsToProject) { throw "桌面入口属于其他项目，拒绝覆盖：$name" }
    Copy-Item -LiteralPath $linkPath -Destination (Join-Path $linkBackup $name)
  } elseif ($name -ne '开发者智能体工作台.lnk') { continue }
  $link = $shell.CreateShortcut($linkPath)
  $link.TargetPath = $executable
  $link.Arguments = ''
  $link.WorkingDirectory = $releasePath
  $link.Description = "开发者智能体工作台 $version（独立桌面客户端）"
  $link.IconLocation = "$executable,0"
  $link.WindowStyle = 1
  $link.Save()
  $readBack = $shell.CreateShortcut($linkPath)
  if ($readBack.TargetPath -ne $executable -or $readBack.Arguments -ne '') {
    throw "桌面入口保存结果不一致，请查看快捷方式备份：$linkBackup"
  }
  $updatedLinks += $linkPath
}
Write-Output "已部署客户端：$executable"
Write-Output "版本：$version"
Write-Output "快捷方式备份：$linkBackup"
$updatedLinks | ForEach-Object { Write-Output "已更新桌面入口：$_" }
if ($Launch) {
  $desktopShell = New-Object -ComObject Shell.Application
  $desktopShell.ShellExecute($executable, '', $releasePath, 'open', 1)
  Write-Output '已请求启动，启动结果需另行确认；未请求模型或执行任务。'
}
