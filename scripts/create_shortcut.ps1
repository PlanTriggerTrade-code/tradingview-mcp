# Create a "TradingView (CDP)" shortcut that always starts TradingView Desktop
# with the debug port open. Use it instead of the normal TradingView icon.
#
# - Microsoft Store version: the shortcut runs launch_tv_debug_store.ps1 in a
#   hidden window (closes a running TradingView first, pops up a message on failure).
# - Installer version: the shortcut starts TradingView.exe with the flag directly.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\create_shortcut.ps1 [-Port 9222] [-NoStartMenu] [-Destination <folder>]
#
# Creates the shortcut on the Desktop and in the Start Menu (pin it to the
# taskbar from there). Re-run after moving this folder.

param(
    [int]$Port = 9222,
    [switch]$NoStartMenu,
    [string]$Destination   # put the shortcut in this folder instead of Desktop + Start Menu
)

$name = 'TradingView (CDP)'
$storeLauncher = Join-Path $PSScriptRoot 'launch_tv_debug_store.ps1'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

# Build a multi-size .ico from the Store package's own logo PNGs. A shortcut
# icon that points into WindowsApps breaks (goes blank) on every TradingView
# update, because the versioned install folder is deleted.
function New-TradingViewIcon($InstallLocation, $OutFile) {
    $sizes = 16, 24, 32, 48, 64, 256
    $images = @()
    foreach ($s in $sizes) {
        $png = Join-Path $InstallLocation "images\Square44x44Logo.targetsize-$($s)_altform-unplated.png"
        if (-not (Test-Path $png)) { $png = Join-Path $InstallLocation "images\Square44x44Logo.targetsize-$s.png" }
        if (Test-Path $png) { $images += [pscustomobject]@{ Size = $s; Bytes = [IO.File]::ReadAllBytes($png) } }
    }
    if ($images.Count -eq 0) { return $false }
    $ms = New-Object IO.MemoryStream
    $w = New-Object IO.BinaryWriter $ms
    $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$images.Count)
    $offset = 6 + 16 * $images.Count
    foreach ($img in $images) {
        $dim = [byte]($img.Size % 256)   # 0 means 256
        $w.Write($dim); $w.Write($dim); $w.Write([byte]0); $w.Write([byte]0)
        $w.Write([uint16]1); $w.Write([uint16]32)
        $w.Write([uint32]$img.Bytes.Length); $w.Write([uint32]$offset)
        $offset += $img.Bytes.Length
    }
    foreach ($img in $images) { $w.Write($img.Bytes) }
    $w.Flush()
    [IO.File]::WriteAllBytes($OutFile, $ms.ToArray())
    return $true
}

# --- Work out what the shortcut should run ---
$classicExe = @(
    "$env:LOCALAPPDATA\TradingView\TradingView.exe",
    "$env:ProgramFiles\TradingView\TradingView.exe",
    "${env:ProgramFiles(x86)}\TradingView\TradingView.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

$pkg = Get-AppxPackage -Name 'TradingView.Desktop' -ErrorAction SilentlyContinue | Select-Object -First 1

if ($classicExe) {
    $target = $classicExe
    $arguments = "--remote-debugging-port=$Port"
    $workDir = Split-Path $classicExe
    $icon = "$classicExe,0"
    $kind = 'installer version'
} elseif ($pkg) {
    $target = $psExe
    $arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$storeLauncher`" -Port $Port -ShowErrors"
    $workDir = $PSScriptRoot
    $icoFile = Join-Path $PSScriptRoot 'tradingview.ico'
    if (New-TradingViewIcon $pkg.InstallLocation $icoFile) {
        $icon = "$icoFile,0"
    } else {
        $icon = "$(Join-Path $pkg.InstallLocation 'TradingView.exe'),0"
    }
    $kind = 'Microsoft Store version'
} else {
    Write-Host "ERROR: TradingView Desktop not found (neither installer nor Microsoft Store version)." -ForegroundColor Red
    exit 1
}

# --- Write the shortcut(s) ---
if ($Destination) {
    $folders = @($Destination)
} else {
    $folders = @([Environment]::GetFolderPath('Desktop'))
    if (-not $NoStartMenu) { $folders += [Environment]::GetFolderPath('Programs') }
}

$shell = New-Object -ComObject WScript.Shell
foreach ($folder in $folders) {
    $path = Join-Path $folder "$name.lnk"
    $lnk = $shell.CreateShortcut($path)
    $lnk.TargetPath = $target
    $lnk.Arguments = $arguments
    $lnk.WorkingDirectory = $workDir
    $lnk.IconLocation = $icon
    $lnk.Description = "TradingView Desktop with the debug port ($Port) open for the TradingView MCP"
    $lnk.Save()
    Write-Host "Created: $path" -ForegroundColor Green
}

Write-Host ""
Write-Host "Detected the $kind. Use the '$name' shortcut to start TradingView from now on."
if ($classicExe) {
    Write-Host "Note: TradingView must be fully closed (including the system tray) before you click it," -ForegroundColor Yellow
    Write-Host "      or the debug port won't open." -ForegroundColor Yellow
}
