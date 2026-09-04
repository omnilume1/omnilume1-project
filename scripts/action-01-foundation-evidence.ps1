[CmdletBinding()]
param(
    [switch]$RunChecks,
    [switch]$Remote
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

function Invoke-CapturedCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& $Command @Arguments 2>&1)
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    [pscustomobject]@{
        Output = (($lines | ForEach-Object { $_.ToString() }) -join "`n").Trim()
        ExitCode = $LASTEXITCODE
    }
}

function Invoke-RecordedCheck {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [string]$Command,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $result = Invoke-CapturedCommand -Command $Command -Arguments $Arguments
    [pscustomobject]@{
        Name = $Name
        Status = if ($result.ExitCode -eq 0) { 'PASS' } else { 'FAIL' }
        ExitCode = $result.ExitCode
        Output = $result.Output
    }
}

function Get-RelativeFiles {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Filter
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return @()
    }

    return @(Get-ChildItem -LiteralPath $Path -Recurse -File -Filter $Filter |
        ForEach-Object { $_.FullName.Substring($repoRoot.Length + 1).Replace('\', '/') } |
        Sort-Object)
}

function Get-MatchingLines {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Pattern,

        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return @()
    }

    $matches = @(& rg --no-heading --line-number --color never $Pattern $Path 2>$null)
    if ($LASTEXITCODE -eq 1) {
        return @()
    }
    if ($LASTEXITCODE -gt 1) {
        throw ('rg failed while searching ' + $Path)
    }
    return $matches
}

function Get-EnvironmentKeyNames {
    $files = @('.env.example', '.env.local') | Where-Object { Test-Path -LiteralPath $_ }
    $keys = foreach ($file in $files) {
        Get-Content -LiteralPath $file | ForEach-Object {
            if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') {
                $Matches[1]
            }
        }
    }
    return @($keys | Sort-Object -Unique)
}

$head = (Invoke-CapturedCommand -Command 'git' -Arguments @('log', '-1', '--oneline')).Output
$branch = (Invoke-CapturedCommand -Command 'git' -Arguments @('branch', '--show-current')).Output
$status = (Invoke-CapturedCommand -Command 'git' -Arguments @('status', '--short', '--untracked-files=all')).Output

$routes = @(Get-RelativeFiles -Path 'src/app' -Filter '*.tsx' |
    Where-Object { $_ -match '/(page|layout)\.tsx$' }
)
$apiRoutes = @(Get-RelativeFiles -Path 'src/app' -Filter 'route.ts')
$actions = @(Get-RelativeFiles -Path 'src/actions' -Filter '*.ts')
$hooks = @(Get-RelativeFiles -Path 'src/hooks' -Filter '*.ts')
$providers = @(Get-RelativeFiles -Path 'src/components' -Filter '*Provider.tsx')
$migrations = @(Get-RelativeFiles -Path 'supabase/migrations' -Filter '*.sql')

$guardResults = @(
    [pscustomobject]@{
        Name = 'obsolete React Player APIs'
        Matches = @(Get-MatchingLines -Pattern 'getInternalPlayer|config\.file' -Path 'src')
        Interpretation = 'No matches expected; review any match before later work.'
    },
    [pscustomobject]@{
        Name = 'legacy room_messages application writer'
        Matches = @(Get-MatchingLines -Pattern '\.from\([''\"]room_messages[''\"]\)|insert\([^)]*room_messages' -Path 'src')
        Interpretation = 'No application writer expected; database table may remain.'
    },
    [pscustomobject]@{
        Name = 'incorrect storage folder expression'
        Matches = @(Get-MatchingLines -Pattern 'storage\.foldername\(r\.name\)' -Path 'supabase')
        Interpretation = 'No matches expected.'
    },
    [pscustomobject]@{
        Name = 'room channel named as private chat'
        Matches = @(Get-MatchingLines -Pattern 'chat_\$\{roomId\}' -Path 'src')
        Interpretation = 'No matches expected; private chat uses its own chat id.'
    },
    [pscustomobject]@{
        Name = 'hardcoded private-key/secret markers'
        Matches = @(Get-MatchingLines -Pattern 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|sk-[A-Za-z0-9]{16,}' -Path 'src')
        Interpretation = 'No hardcoded secret markers expected.'
    },
    [pscustomobject]@{
        Name = 'public USING(true) policy candidates'
        Matches = @(Get-MatchingLines -Pattern 'USING\s*\(true\)' -Path 'supabase')
        Interpretation = 'Any match requires policy-context review; not every base-schema public policy is private-room access.'
    }
)

$checks = @()
if ($RunChecks) {
    $checks += Invoke-RecordedCheck -Name 'TypeScript' -Command 'npx' -Arguments @('tsc', '--noEmit')
    $checks += Invoke-RecordedCheck -Name 'Production build' -Command 'npm' -Arguments @('run', 'build')
    $checks += Invoke-RecordedCheck -Name 'Lint' -Command 'npm' -Arguments @('run', 'lint')
    $checks += Invoke-RecordedCheck -Name 'Diff check' -Command 'git' -Arguments @('diff', '--check')
}
if ($Remote) {
    $checks += Invoke-RecordedCheck -Name 'Supabase migration list (read-only)' -Command 'npx' -Arguments @('supabase', 'migration', 'list')
}

Write-Output '# OmniLume Action 01 Evidence Run'
Write-Output ''
Write-Output ('- UTC timestamp: ' + [DateTime]::UtcNow.ToString('o'))
Write-Output ('- Branch: ' + $branch)
Write-Output ('- HEAD: ' + $head)
$treeState = if ([string]::IsNullOrWhiteSpace($status)) { 'clean' } else { 'changes present; inspect before proceeding' }
Write-Output ('- Working tree status: ' + $treeState)
Write-Output ''
Write-Output '## Inventoried source paths'
Write-Output ''
Write-Output '### Routes'
if ($routes.Count -eq 0) { Write-Output '- none found' } else { $routes | ForEach-Object { Write-Output ('- `' + $_ + '`') } }
Write-Output ''
Write-Output '### API routes'
if ($apiRoutes.Count -eq 0) { Write-Output '- none found' } else { $apiRoutes | ForEach-Object { Write-Output ('- `' + $_ + '`') } }
Write-Output ''
Write-Output '### Actions'
if ($actions.Count -eq 0) { Write-Output '- none found' } else { $actions | ForEach-Object { Write-Output ('- `' + $_ + '`') } }
Write-Output ''
Write-Output '### Hooks'
if ($hooks.Count -eq 0) { Write-Output '- none found' } else { $hooks | ForEach-Object { Write-Output ('- `' + $_ + '`') } }
Write-Output ''
Write-Output '### Providers'
if ($providers.Count -eq 0) { Write-Output '- none found' } else { $providers | ForEach-Object { Write-Output ('- `' + $_ + '`') } }
Write-Output ''
Write-Output '### SQL migrations'
if ($migrations.Count -eq 0) { Write-Output '- none found' } else { $migrations | ForEach-Object { Write-Output ('- `' + $_ + '`') } }
Write-Output ''
Write-Output '## Environment key names (values intentionally omitted)'
Write-Output ''
$environmentKeys = Get-EnvironmentKeyNames
if ($environmentKeys.Count -eq 0) { Write-Output '- none found' } else { $environmentKeys | ForEach-Object { Write-Output ('- `' + $_ + '`') } }
Write-Output ''
Write-Output '## Static guard searches'
Write-Output ''
foreach ($guard in $guardResults) {
    $guardStatus = if ($guard.Matches.Count -eq 0) { 'PASS/no matches' } else { 'REVIEW/matches found' }
    Write-Output ('- **' + $guard.Name + ':** ' + $guardStatus + ' - ' + $guard.Interpretation)
    if ($guard.Matches.Count -gt 0 -and $guard.Name -ne 'public USING(true) policy candidates') {
        Write-Output '  - match locations intentionally omitted from this safe summary'
    }
}
Write-Output ''
Write-Output '## Requested checks'
Write-Output ''
if ($checks.Count -eq 0) {
    Write-Output '- Not run. Use `-RunChecks` and optionally `-Remote` for the read-only validation set.'
} else {
    foreach ($check in $checks) {
        Write-Output ('- **' + $check.Name + ':** ' + $check.Status + ' (exit ' + $check.ExitCode + ')')
    }
}
Write-Output ''
Write-Output 'Sensitive command output is intentionally not printed. Review failed commands directly in a controlled terminal without copying secrets into evidence.'
