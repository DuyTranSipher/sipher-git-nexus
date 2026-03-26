[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [string]$ProjectFile,

    [string]$PluginSource = (Join-Path $PSScriptRoot '..\vendor\GitNexusUnreal'),

    [string]$EditorCmd,

    [int]$TimeoutMs = 300000,

    [switch]$Force,

    [switch]$RunAnalyze,

    [string]$GitNexusCommand = 'gitnexus'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-FullPath {
    param([Parameter(Mandatory = $true)][string]$PathValue)

    return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($PathValue)
}

function Convert-ToPortablePath {
    param([Parameter(Mandatory = $true)][string]$PathValue)

    return ($PathValue -replace '\\', '/')
}

function Get-UProjectPath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [string]$ExplicitProjectFile
    )

    if ($ExplicitProjectFile) {
        $resolved = Resolve-FullPath -PathValue $ExplicitProjectFile
        if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
            throw "Project file not found: $resolved"
        }

        return $resolved
    }

    $uprojects = Get-ChildItem -LiteralPath $Root -Filter '*.uproject' -File
    if ($uprojects.Count -eq 0) {
        throw "No .uproject file found under $Root. Pass -ProjectFile explicitly."
    }

    if ($uprojects.Count -gt 1) {
        $names = ($uprojects | Select-Object -ExpandProperty FullName) -join ', '
        throw "Multiple .uproject files found under ${Root}: $names. Pass -ProjectFile explicitly."
    }

    return $uprojects[0].FullName
}

function Add-EditorCmdCandidates {
    param(
        [Parameter(Mandatory = $true)][System.Collections.Generic.List[string]]$Candidates,
        [string]$RootOrExe
    )

    if ([string]::IsNullOrWhiteSpace($RootOrExe)) {
        return
    }

    $Candidates.Add($RootOrExe)
    $Candidates.Add((Join-Path $RootOrExe 'Engine\Binaries\Win64\UnrealEditor-Cmd.exe'))
    $Candidates.Add((Join-Path $RootOrExe 'Engine\Windows\Engine\Binaries\Win64\UnrealEditor-Cmd.exe'))
}

function Resolve-UnrealEditorCmd {
    param(
        [string]$ExplicitEditorCmd,
        [string]$EngineAssociation
    )

    if ($ExplicitEditorCmd) {
        $resolvedExplicit = Resolve-FullPath -PathValue $ExplicitEditorCmd
        if (-not (Test-Path -LiteralPath $resolvedExplicit -PathType Leaf)) {
            throw "Editor command not found: $resolvedExplicit"
        }

        return $resolvedExplicit
    }

    $candidates = [System.Collections.Generic.List[string]]::new()

    if ($EngineAssociation) {
        try {
            $builds = Get-ItemProperty -Path 'HKCU:\Software\Epic Games\Unreal Engine\Builds'
            foreach ($property in $builds.PSObject.Properties) {
                if ($property.Name -like 'PS*') {
                    continue
                }

                if ($property.Name -eq $EngineAssociation) {
                    Add-EditorCmdCandidates -Candidates $candidates -RootOrExe ([string]$property.Value)
                }
            }
        } catch {
        }

        # Try LauncherInstalled.dat (Epic Games Launcher writes this for all engine installs)
        try {
            $launcherDat = Join-Path $env:LOCALAPPDATA 'EpicGames\UnrealEngineLauncher\LauncherInstalled.dat'
            if (Test-Path -LiteralPath $launcherDat -PathType Leaf) {
                $launcher = Get-Content -LiteralPath $launcherDat -Raw | ConvertFrom-Json
                foreach ($entry in $launcher.InstallationList) {
                    if ($entry.AppName -eq "UE_$EngineAssociation" -or $entry.AppName -eq $EngineAssociation) {
                        Add-EditorCmdCandidates -Candidates $candidates -RootOrExe $entry.InstallLocation
                    }
                }
            }
        } catch {
        }

        Add-EditorCmdCandidates -Candidates $candidates -RootOrExe "C:\Program Files\Epic Games\UE_$EngineAssociation"
    }

    foreach ($candidate in $candidates | Select-Object -Unique) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-FullPath -PathValue $candidate)
        }
    }

    throw "Could not auto-detect UnrealEditor-Cmd.exe for EngineAssociation '$EngineAssociation'. Pass -EditorCmd explicitly."
}

$resolvedProjectRoot = Resolve-FullPath -PathValue $ProjectRoot
if (-not (Test-Path -LiteralPath $resolvedProjectRoot -PathType Container)) {
    throw "Project root not found: $resolvedProjectRoot"
}

$resolvedPluginSource = Resolve-FullPath -PathValue $PluginSource
if (-not (Test-Path -LiteralPath $resolvedPluginSource -PathType Container)) {
    throw "Plugin source not found: $resolvedPluginSource"
}

$uprojectPath = Get-UProjectPath -Root $resolvedProjectRoot -ExplicitProjectFile $ProjectFile
$uproject = Get-Content -LiteralPath $uprojectPath -Raw | ConvertFrom-Json
$engineAssociation = ''
if ($uproject.PSObject.Properties.Name -contains 'EngineAssociation') {
    $engineAssociation = [string]$uproject.EngineAssociation
}

$resolvedEditorCmd = Resolve-UnrealEditorCmd -ExplicitEditorCmd $EditorCmd -EngineAssociation $engineAssociation

$pluginsRoot = Join-Path $resolvedProjectRoot 'Plugins'
$pluginDestination = Join-Path $pluginsRoot 'GitNexusUnreal'
$gitnexusRoot = Join-Path $resolvedProjectRoot '.gitnexus'
$unrealRoot = Join-Path $gitnexusRoot 'unreal'
$configPath = Join-Path $unrealRoot 'config.json'

if ((Test-Path -LiteralPath $pluginDestination) -and -not $Force) {
    throw "Plugin destination already exists: $pluginDestination. Remove it first or rerun with -Force."
}

if ((Test-Path -LiteralPath $configPath) -and -not $Force) {
    throw "Config already exists: $configPath. Remove it first or rerun with -Force."
}

New-Item -ItemType Directory -Path $pluginsRoot -Force | Out-Null
New-Item -ItemType Directory -Path $unrealRoot -Force | Out-Null

if (Test-Path -LiteralPath $pluginDestination) {
    Remove-Item -LiteralPath $pluginDestination -Recurse -Force
}

Copy-Item -LiteralPath $resolvedPluginSource -Destination $pluginDestination -Recurse

$config = [ordered]@{
    editor_cmd  = Convert-ToPortablePath -PathValue $resolvedEditorCmd
    project_path = Convert-ToPortablePath -PathValue $uprojectPath
    commandlet  = 'GitNexusBlueprintAnalyzer'
    timeout_ms  = $TimeoutMs
}

$config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding UTF8

if ($RunAnalyze) {
    Push-Location $resolvedProjectRoot
    try {
        & $GitNexusCommand analyze
    } finally {
        Pop-Location
    }
}

Write-Host "Installed GitNexusUnreal plugin to: $pluginDestination"
Write-Host "Wrote Unreal config to: $configPath"
Write-Host "Resolved UnrealEditor-Cmd.exe: $resolvedEditorCmd"
Write-Host ""
Write-Host "Next steps:"
Write-Host "1. Build your Unreal editor target."
Write-Host "2. Run 'gitnexus analyze' in $resolvedProjectRoot if you have not indexed the repo yet."
Write-Host "3. Run 'gitnexus unreal-sync'."
Write-Host "4. Run 'gitnexus unreal-find-refs ""Class::Function""'."
