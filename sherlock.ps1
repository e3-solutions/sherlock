[CmdletBinding()]
param(
    [Parameter(Position = 0)][ValidateSet("install")][string]$Action = "install",
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][Alias("GithubId")][string]$Github,
    [Parameter(Mandatory = $true)][string]$Email
)

$ErrorActionPreference = "Stop"
& "$PSScriptRoot\plugins\sherlock\scripts\launch_installer.ps1" `
    -Providers auto -RepoRoot $PSScriptRoot -Name $Name -GithubId $Github -Email $Email
exit $LASTEXITCODE
