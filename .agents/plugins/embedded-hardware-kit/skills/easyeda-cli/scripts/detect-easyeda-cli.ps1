<#
.SYNOPSIS
  Detect EasyEDA Pro / JLCEDA Pro CLI installations on Windows.

.DESCRIPTION
  Locates the desktop client, reports its installation directory, edition
  (lceda-pro = mainland China, easyeda-pro = international) and version.
  Only the client's own CLI-capable executables are probed; uninstallers,
  simulation engines and legacy 6.x standard editions are never executed.

  For macOS and Linux use detect-easyeda-cli.sh instead.

.PARAMETER Text
  Print a human-readable summary instead of JSON.

.PARAMETER NoProbe
  Do not run `<exe> --help` (faster; version/cliCapable may be unknown).

.PARAMETER Doctor
  Also run `<exe> doctor` to probe the running editor bridge.

.PARAMETER TimeoutSec
  Per-probe timeout in seconds. Default: 20.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\detect-easyeda-cli.ps1

.EXAMPLE
  .\detect-easyeda-cli.ps1 -Text -Doctor
#>
[CmdletBinding()]
param(
    [switch]$Text,
    [switch]$NoProbe,
    [switch]$Doctor,
    [ValidateRange(1, 300)]
    [int]$TimeoutSec = 20
)

$ErrorActionPreference = 'Stop'

$script:IsWindowsHost = $true
if (Get-Variable -Name IsWindows -ErrorAction SilentlyContinue) {
    $script:IsWindowsHost = [bool]$IsWindows
} elseif ($env:OS -ne 'Windows_NT') {
    $script:IsWindowsHost = $false
}

if (-not $script:IsWindowsHost) {
    Write-Error 'This PowerShell script is for Windows. On macOS/Linux run: bash scripts/detect-easyeda-cli.sh'
    exit 2
}

$script:Candidates = New-Object System.Collections.Generic.List[object]

function Get-LowerLeaf([string]$Path) {
    return [System.IO.Path]::GetFileNameWithoutExtension($Path).ToLowerInvariant()
}

function Get-DistributionFromName([string]$Name) {
    switch ($Name.ToLowerInvariant()) {
        'lceda-pro' { return 'lceda-pro' }
        'easyeda-pro' { return 'easyeda-pro' }
        default { return '' }
    }
}

function Get-Edition([string]$Distribution) {
    switch ($Distribution) {
        'lceda-pro' { return 'mainland' }
        'easyeda-pro' { return 'international' }
        default { return 'unknown' }
    }
}

function Get-Product([string]$Distribution) {
    switch ($Distribution) {
        'lceda-pro' { return 'JLCEDA Pro' }
        'easyeda-pro' { return 'EasyEDA Pro' }
        default { return 'EasyEDA Pro' }
    }
}

function Get-ForwardSlashPath([string]$Path) {
    if (-not $Path) { return '' }
    return $Path.Replace('\', '/')
}

function Get-InstallDir([string]$Exe) {
    if ($Exe -match '^(.*)\.app\\Contents\\MacOS\\[^\\]+$') {
        return $Matches[1]
    }
    return Split-Path -Parent $Exe
}

function Add-Candidate {
    param(
        [string]$Source,
        [string]$Path,
        [string]$Distribution = ''
    )

    if ([string]::IsNullOrWhiteSpace($Path)) { return }

    $clean = $Path.Trim().Trim('"')
    if (-not (Test-Path -LiteralPath $clean -PathType Leaf)) { return }

    $leaf = Get-LowerLeaf $clean
    if ($leaf -match '^unins' -or $leaf -match 'uninstall' -or $leaf -match 'server' -or $leaf -match 'sim$') {
        return
    }

    if (-not $Distribution) {
        $Distribution = Get-DistributionFromName $leaf
    }
    if (-not $Distribution) { return }

    try {
        $full = [System.IO.Path]::GetFullPath($clean)
    } catch {
        $full = $clean
    }

    foreach ($c in $script:Candidates) {
        if ($c.Path -ieq $full) { return }
    }

    $script:Candidates.Add([pscustomobject]@{
        Source       = $Source
        Path         = $full
        Distribution = $Distribution
    })
}

function Invoke-Cli {
    param(
        [string]$Exe,
        [string[]]$Arguments,
        [int]$TimeoutSeconds = 20
    )

    $result = [pscustomobject]@{
        ExitCode  = $null
        StdOut    = ''
        StdErr    = ''
        TimedOut  = $false
        Exception = ''
    }

    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $Exe
        $psi.Arguments = ($Arguments | ForEach-Object {
            if ($_ -match '\s') { '"' + $_ + '"' } else { $_ }
        }) -join ' '
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.CreateNoWindow = $true
        $psi.WorkingDirectory = Split-Path -Parent $Exe

        $process = [System.Diagnostics.Process]::Start($psi)
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()

        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            try { $process.Kill() } catch { }
            $result.TimedOut = $true
            $result.StdOut = if ($stdoutTask.Wait(1000)) { $stdoutTask.Result } else { '' }
            $result.StdErr = if ($stderrTask.Wait(1000)) { $stderrTask.Result } else { '' }
            return $result
        }

        $result.ExitCode = $process.ExitCode
        $result.StdOut = $stdoutTask.Result
        $result.StdErr = $stderrTask.Result
        $process.Dispose()
    } catch {
        $result.Exception = $_.Exception.Message
    }

    return $result
}

function Get-BuildId([string]$Exe) {
    $versionFile = Join-Path (Split-Path -Parent $Exe) 'version'
    if (Test-Path -LiteralPath $versionFile -PathType Leaf) {
        try {
            return (Get-Content -LiteralPath $versionFile -TotalCount 1).Trim()
        } catch {
            return ''
        }
    }
    return ''
}

function Get-VersionKey([string]$Version) {
    $numbers = @([regex]::Matches("$Version", '\d+') |
        ForEach-Object { [int64]$_.Value } |
        Select-Object -First 4)
    while ($numbers.Count -lt 4) { $numbers += 0 }
    return ($numbers | ForEach-Object { $_.ToString('D10') }) -join '.'
}

function Test-VersionAtLeast4_1_70([string]$Version) {
    if ([string]::IsNullOrWhiteSpace($Version)) { return $true }
    $numbers = @([regex]::Matches($Version, '\d+') | ForEach-Object { [int64]$_.Value })
    $major = if ($numbers.Count -ge 1) { $numbers[0] } else { 0 }
    $minor = if ($numbers.Count -ge 2) { $numbers[1] } else { 0 }
    $patch = if ($numbers.Count -ge 3) { $numbers[2] } else { 0 }
    if ($major -ne 4) { return $major -gt 4 }
    if ($minor -ne 1) { return $minor -gt 1 }
    return $patch -ge 70
}

# --------------------------------------------------------------- discovery --

foreach ($commandName in @('lceda-pro', 'easyeda-pro')) {
    $found = Get-Command $commandName -ErrorAction SilentlyContinue
    foreach ($item in @($found)) {
        if ($null -eq $item) { continue }
        if ($item.CommandType -eq 'Application' -and $item.Source) {
            Add-Candidate -Source 'path' -Path $item.Source
        }
    }
}

$roots = @(
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)},
    $env:ProgramW6432
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique

foreach ($root in $roots) {
    foreach ($exeName in @('lceda-pro', 'easyeda-pro')) {
        Add-Candidate -Source 'known-dir' -Path (Join-Path $root "$exeName\$exeName.exe")
        Add-Candidate -Source 'known-dir' -Path (Join-Path $root "JLCEDA Pro\$exeName.exe")
        Add-Candidate -Source 'known-dir' -Path (Join-Path $root "EasyEDA Pro\$exeName.exe")
    }
}

if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    foreach ($exeName in @('lceda-pro', 'easyeda-pro')) {
        Add-Candidate -Source 'known-dir' -Path (Join-Path $env:LOCALAPPDATA "Programs\$exeName\$exeName.exe")
        Add-Candidate -Source 'known-dir' -Path (Join-Path $env:LOCALAPPDATA "Programs\JLCEDA Pro\$exeName.exe")
        Add-Candidate -Source 'known-dir' -Path (Join-Path $env:LOCALAPPDATA "Programs\EasyEDA Pro\$exeName.exe")
    }
}

# Registry uninstall entries catch custom install directories. Match only the
# Pro executables so legacy EasyEDA/lceda 6.x and unrelated EDA tools are ignored.
$uninstallRoots = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
)

foreach ($registryRoot in $uninstallRoots) {
    $entries = Get-ItemProperty -Path $registryRoot -ErrorAction SilentlyContinue
    foreach ($entry in @($entries)) {
        if ($null -eq $entry) { continue }
        $haystack = "$($entry.DisplayName) $($entry.InstallLocation) $($entry.UninstallString)"
        if ($haystack -notmatch '(?i)lceda-pro|easyeda-pro') { continue }
        if ([string]::IsNullOrWhiteSpace($entry.InstallLocation)) { continue }
        $location = $entry.InstallLocation.Trim().Trim('"')
        foreach ($exeName in @('lceda-pro', 'easyeda-pro')) {
            Add-Candidate -Source 'registry' -Path (Join-Path $location "$exeName.exe")
        }
    }
}

# ----------------------------------------------------------------- probing --

$results = New-Object System.Collections.Generic.List[object]
$warnings = New-Object System.Collections.Generic.List[string]
$probedCount = 0
$maxProbe = 8

foreach ($candidate in $script:Candidates) {
    $cliCapable = $null
    $version = ''
    $header = ''
    $probeError = ''
    $versionSource = 'unknown'
    $buildId = Get-BuildId $candidate.Path

    if (-not $NoProbe) {
        $probeError = 'skipped probe (too many candidates)'
        if ($probedCount -lt $maxProbe) {
            $probedCount++
            $run = Invoke-Cli -Exe $candidate.Path -Arguments @('--help') -TimeoutSeconds $TimeoutSec
            $combined = (($run.StdOut -replace "`r", '') + "`n" + ($run.StdErr -replace "`r", '')).Trim()

            if ($run.TimedOut) {
                $cliCapable = $false
                $probeError = "probe timed out after ${TimeoutSec}s"
            } elseif ($run.Exception) {
                $cliCapable = $false
                $probeError = $run.Exception
            } elseif ($run.ExitCode -eq 0 -and $combined -match '(?m)^(Usage:|Commands:)') {
                $cliCapable = $true
                $probeError = ''
                $lines = @($combined -split "`n" | Select-Object -First 12)
                $headerLine = $lines | Where-Object { $_ -match '(JLCEDA|EasyEDA|EASYEDA).*[0-9]' } | Select-Object -First 1
                if (-not $headerLine) {
                    $headerLine = $combined -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 1
                }
                if ($headerLine) {
                    $header = $headerLine.Trim()
                    if ($header -match '\s([0-9][0-9A-Za-z._-]*)\s*$') {
                        $version = $Matches[1]
                    }
                }
            } else {
                $cliCapable = $false
                $firstLine = $combined -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 1
                $probeError = if ($firstLine) { $firstLine.Trim() } else { "probe failed (exit $($run.ExitCode))" }
            }
        }
    }

    if (-not $version -and $buildId) {
        $versionSource = 'version-file-only'
    } elseif ($version) {
        $versionSource = 'help'
    }

    $onPath = ($candidate.Source -eq 'path')

    $results.Add([pscustomobject]@{
        Source        = $candidate.Source
        Executable    = $candidate.Path
        Distribution  = $candidate.Distribution
        OnPath        = $onPath
        CliCapable    = $cliCapable
        Version       = $version
        BuildId       = $buildId
        VersionSource = $versionSource
        Header        = $header
        ProbeError    = $probeError
    })
}

# ----------------------------------------------------------------- select ---

function Select-BestInstallation {
    param($Items)

    $items = @($Items | Where-Object { $null -ne $_ })
    if ($items.Count -eq 0) { return $null }

    $cliItems = @($items | Where-Object { $_.CliCapable -eq $true })
    $pool = if ($cliItems.Count -gt 0) { $cliItems } else { $items }

    return $pool |
        Sort-Object -Property @{ Expression = { Get-VersionKey $_.Version } } -Descending |
        Select-Object -First 1
}

$pathCandidates = @($results | Where-Object { $_.OnPath })
$selected = $null
$selectedReason = ''

$pathBest = Select-BestInstallation -Items $pathCandidates
if ($null -ne $pathBest) {
    $selected = $pathBest
    $selectedReason = 'on PATH'
} else {
    $anyBest = Select-BestInstallation -Items @($results)
    if ($null -ne $anyBest) {
        $selected = $anyBest
        $selectedReason = 'highest version (not on PATH)'
    }
}

$cliDistributions = @($results | Where-Object { $_.CliCapable -eq $true } |
    Select-Object -ExpandProperty Distribution -Unique)
$ambiguous = ($cliDistributions.Count -gt 1)

if ($results.Count -eq 0) {
    $warnings.Add('No EasyEDA Pro CLI installation found. Install the desktop client v4.1.70 or newer (lceda.cn for the mainland edition, easyeda.com for the international edition), then re-run this script.')
}
if ($results.Count -gt 0 -and $pathCandidates.Count -eq 0) {
    $warnings.Add('The client is installed but not on PATH. Use the absolute executable path, or add the install directory to PATH.')
}
if ($pathCandidates.Count -gt 1) {
    $warnings.Add("Multiple client installations are on PATH; selected '$($selected.Distribution)' ($($selected.Executable)).")
}
if ($ambiguous) {
    $warnings.Add('Both lceda-pro (mainland) and easyeda-pro (international) are available. Ask the user which edition to drive; do not mix sessions from different editions.')
}
$oldClients = @($results | Where-Object {
    $_.CliCapable -eq $true -and $_.Version -and -not (Test-VersionAtLeast4_1_70 $_.Version)
})
if ($oldClients.Count -gt 0) {
    $warnings.Add('At least one detected client is older than 4.1.70. The CLI requires v4.1.70+; ask the user to update before relying on it.')
}

$doctorOutput = $null
if ($Doctor -and $null -ne $selected) {
    $doctorRun = Invoke-Cli -Exe $selected.Executable -Arguments @('doctor') -TimeoutSeconds $TimeoutSec
    $doctorOk = $false
    $connected = $false
    $endpoint = ''
    $bridgeVersion = ''
    try {
        $parsed = $doctorRun.StdOut | ConvertFrom-Json
        $doctorOk = [bool]$parsed.ok
        if ($null -ne $parsed.value) {
            $connected = [bool]$parsed.value.connected
            $endpoint = [string]$parsed.value.endpoint
            $bridgeVersion = [string]$parsed.value.bridgeVersion
        }
    } catch { }

    $doctorOutput = [ordered]@{
        ok            = $doctorOk
        connected     = $connected
        endpoint      = $endpoint
        bridgeVersion = $bridgeVersion
        raw           = $doctorRun.StdOut.Trim()
    }
}

# ----------------------------------------------------------------- output ---

function Get-InstallationObject {
    param($Installation)

    $cliCapable = $Installation.CliCapable
    return [ordered]@{
        distribution  = $Installation.Distribution
        edition       = Get-Edition $Installation.Distribution
        product       = Get-Product $Installation.Distribution
        command       = $Installation.Distribution
        installDir    = Get-ForwardSlashPath (Get-InstallDir $Installation.Executable)
        executable    = Get-ForwardSlashPath $Installation.Executable
        onPath        = [bool]$Installation.OnPath
        cliCapable    = $cliCapable
        probed        = ($null -ne $cliCapable)
        version       = $Installation.Version
        buildId       = $Installation.BuildId
        versionSource = $Installation.VersionSource
        versionHeader = $Installation.Header
        probeError    = $Installation.ProbeError
        source        = $Installation.Source
    }
}

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

if ($Text) {
    $arch = switch ($env:PROCESSOR_ARCHITECTURE) {
        'AMD64' { 'x64' }
        'ARM64' { 'arm64' }
        'x86' { 'x86' }
        default { $env:PROCESSOR_ARCHITECTURE }
    }

    Write-Output 'EasyEDA Pro CLI detection'
    Write-Output "OS: windows ($arch)"
    if ($results.Count -eq 0) {
        Write-Output 'No EasyEDA Pro CLI installation found.'
    } else {
        Write-Output "Found $($results.Count) installation(s)"
        foreach ($item in $results) {
            Write-Output ''
            Write-Output "  edition    : $($item.Distribution) ($(Get-Edition $item.Distribution))"
            Write-Output "  installDir : $(Get-ForwardSlashPath (Get-InstallDir $item.Executable))"
            Write-Output "  executable : $(Get-ForwardSlashPath $item.Executable)"
            if ($item.Version) { Write-Output "  version    : $($item.Version)" } else { Write-Output '  version    : unknown' }
            if ($item.BuildId) { Write-Output "  buildId    : $($item.BuildId)" }
            Write-Output "  on PATH    : $($item.OnPath.ToString().ToLowerInvariant())"
            if ($null -eq $item.CliCapable) { Write-Output '  CLI usable : not probed' }
            else { Write-Output "  CLI usable : $($item.CliCapable.ToString().ToLowerInvariant())" }
            Write-Output "  source     : $($item.Source)"
            if ($item.ProbeError) { Write-Output "  probe error: $($item.ProbeError)" }
        }
        Write-Output ''
        Write-Output "Selected: $selectedReason"
        Write-Output "  $($selected.Distribution)  ->  $(Get-ForwardSlashPath $selected.Executable)"
    }
    if ($warnings.Count -gt 0) {
        Write-Output ''
        Write-Output 'Warnings:'
        foreach ($warning in $warnings) { Write-Output "  - $warning" }
    }
    Write-Output ''
    if ($results.Count -gt 0) { exit 0 } else { exit 1 }
}

$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    'x86' { 'x86' }
    default { $env:PROCESSOR_ARCHITECTURE }
}

$selectedObject = if ($null -ne $selected) { Get-InstallationObject $selected } else { $null }
$installationObjects = @($results | ForEach-Object { Get-InstallationObject $_ })

$output = [ordered]@{
    ok             = ($results.Count -gt 0)
    skill          = 'easyeda-cli'
    detectedAt     = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    os             = 'windows'
    arch           = $arch
    wsl            = $false
    ambiguous      = $ambiguous
    distribution   = if ($null -ne $selected) { $selected.Distribution } else { '' }
    edition        = if ($null -ne $selected) { Get-Edition $selected.Distribution } else { '' }
    product        = if ($null -ne $selected) { Get-Product $selected.Distribution } else { '' }
    command        = if ($null -ne $selected) { $selected.Distribution } else { '' }
    installDir     = if ($null -ne $selected) { Get-ForwardSlashPath (Get-InstallDir $selected.Executable) } else { '' }
    executable     = if ($null -ne $selected) { Get-ForwardSlashPath $selected.Executable } else { '' }
    version        = if ($null -ne $selected) { $selected.Version } else { '' }
    buildId        = if ($null -ne $selected) { $selected.BuildId } else { '' }
    onPath         = if ($null -ne $selected) { [bool]$selected.OnPath } else { $false }
    selected       = $selectedObject
    selectedReason = $selectedReason
    installations  = $installationObjects
    warnings       = @($warnings)
    doctor         = $doctorOutput
}

$output | ConvertTo-Json -Depth 8

if ($results.Count -gt 0) { exit 0 } else { exit 1 }
