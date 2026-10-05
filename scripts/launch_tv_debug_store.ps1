# Launch TradingView Desktop (Microsoft Store / MSIX install) with the
# Chrome DevTools Protocol debug port enabled.
#
# Store apps run in an AppContainer: starting TradingView.exe directly from
# WindowsApps is access-denied, and launching through the Start menu drops
# command-line flags. Activating the app through the Windows
# IApplicationActivationManager COM interface passes the flag through.
# No admin rights or Developer Mode needed.
#
# Usage:  powershell -ExecutionPolicy Bypass -File launch_tv_debug_store.ps1 [-Port 9222] [-NoKill] [-ShowErrors]
#
# -ShowErrors pops up a message box on failure. The desktop shortcut made by
# create_shortcut.ps1 uses it, since that runs with a hidden window.
#
# Exit codes: 0 = debug port ready, 1 = Store TradingView not installed,
#             2 = launched but port never came up, 3 = TradingView running
#             without the port and -NoKill was given, 4 = activation failed

param(
    [int]$Port = 9222,
    [switch]$NoKill,
    [switch]$ShowErrors
)

function Stop-WithMessage([int]$Code, [string]$Message, [string]$Color = 'Red') {
    Write-Host $Message -ForegroundColor $Color
    if ($ShowErrors) {
        $icon = 16; if ($Color -eq 'Yellow') { $icon = 48 }
        try { (New-Object -ComObject WScript.Shell).Popup($Message, 0, 'TradingView (CDP)', $icon) | Out-Null } catch { }
    }
    exit $Code
}

function Test-Cdp {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 2
        return $r.StatusCode -eq 200
    } catch { return $false }
}

if (Test-Cdp) {
    Write-Host "Debug port already open at http://127.0.0.1:$Port - nothing to do." -ForegroundColor Green
    exit 0
}

# --- Find the Store package and its AppUserModelID ---
$pkg = Get-AppxPackage -Name 'TradingView.Desktop' | Select-Object -First 1
if (-not $pkg) {
    Stop-WithMessage 1 "TradingView Desktop (Microsoft Store version) is not installed."
}
$appId = 'TradingView.Desktop'
try {
    $ids = @((Get-AppxPackageManifest $pkg).Package.Applications.Application | ForEach-Object { $_.Id })
    if ($ids.Count -gt 0 -and $ids[0]) { $appId = $ids[0] }
} catch { }
$aumid = "$($pkg.PackageFamilyName)!$appId"
Write-Host "Package: $($pkg.PackageFullName)"
Write-Host "AUMID:   $aumid"
Write-Host "Port:    $Port"

# --- TradingView must be fully closed, or the flag is ignored ---
if (Get-Process -Name TradingView -ErrorAction SilentlyContinue) {
    if ($NoKill) {
        Stop-WithMessage 3 "TradingView is running without the debug port. Close it and re-run (or drop -NoKill)."
    }
    Write-Host "Closing running TradingView..."
    & taskkill.exe /F /IM TradingView.exe 2>&1 | Out-Null
    for ($i = 0; $i -lt 10 -and (Get-Process -Name TradingView -ErrorAction SilentlyContinue); $i++) {
        Start-Sleep -Milliseconds 500
    }
}

# --- Activate through COM with the debug-port argument ---
if (-not ('TvLaunch.ActivationManager' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace TvLaunch {
    [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IApplicationActivationManager {
        void ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
                                 [MarshalAs(UnmanagedType.LPWStr)] string arguments,
                                 int options, out uint processId);
    }
    [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    class ApplicationActivationManagerClass { }
    public static class ActivationManager {
        public static uint Activate(string aumid, string args) {
            var mgr = (IApplicationActivationManager)new ApplicationActivationManagerClass();
            uint pid;
            mgr.ActivateApplication(aumid, args, 0, out pid);
            return pid;
        }
    }
}
"@
}

try {
    $procId = [TvLaunch.ActivationManager]::Activate($aumid, "--remote-debugging-port=$Port")
    Write-Host "Launched (PID $procId). Waiting for debug port..."
} catch {
    Stop-WithMessage 4 "Could not start TradingView: $($_.Exception.Message)"
}

for ($i = 0; $i -lt 40; $i++) {
    if (Test-Cdp) {
        Write-Host "Debug port ready at http://127.0.0.1:$Port" -ForegroundColor Green
        exit 0
    }
    Start-Sleep -Milliseconds 750
}

Stop-WithMessage 2 "TradingView started, but the debug port did not open within 30 seconds. It may still be loading - check http://127.0.0.1:$Port/json/version in a moment. If it never opens, quit TradingView from the system tray and try again." 'Yellow'
