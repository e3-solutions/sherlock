[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet("auto", "codex", "claude_code")][string]$Providers,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$GithubId,
    [Parameter(Mandatory = $true)][string]$Email,
    [Parameter(Mandatory = $true)][string]$RepoRoot
)

$ErrorActionPreference = "Stop"

function Find-SherlockPython {
    $names = @()
    if ($env:PYTHON_BIN) { $names += $env:PYTHON_BIN }
    $names += @("py", "python", "python3")
    foreach ($name in $names) {
        $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $command) { continue }
        $prefix = @()
        if ([IO.Path]::GetFileNameWithoutExtension($command.Name) -eq "py") { $prefix = @("-3") }
        & $command.Source @prefix -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)"
        if ($LASTEXITCODE -eq 0) { return @($command.Source) + $prefix }
    }
    throw "Python 3.11 or newer was not found. Set PYTHON_BIN to its executable path."
}

$python = @(Find-SherlockPython)
$pythonExe = $python[0]
$installer = Join-Path $RepoRoot "plugins\sherlock\scripts\client_installer.py"
if ($python.Count -eq 1) {
    & $pythonExe $installer --providers $Providers --repo-root $RepoRoot --name $Name --github-id $GithubId --email $Email
} else {
    $pythonPrefix = $python[1]
    & $pythonExe $pythonPrefix $installer --providers $Providers --repo-root $RepoRoot --name $Name --github-id $GithubId --email $Email
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
