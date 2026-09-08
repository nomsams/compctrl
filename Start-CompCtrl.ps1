param(
    [string]$WebUrl = ''
)

$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectPath

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js 22 or newer is required. Install it from https://nodejs.org and run this script again.'
}

if (-not (Test-Path -LiteralPath (Join-Path $projectPath 'node_modules'))) {
    Write-Host 'Installing CompCtrl dependencies…'
    npm install
}

if ($WebUrl) { $env:COMPCTRL_WEB_URL = $WebUrl }

$devProcess = $null
try {
    try {
        $null = Invoke-WebRequest -UseBasicParsing 'http://localhost:3000/' -TimeoutSec 2
    }
    catch {
        Write-Host 'Starting the local controller…'
        $devProcess = Start-Process -FilePath 'npm.cmd' -ArgumentList 'run', 'dev' -WorkingDirectory $projectPath -WindowStyle Hidden -PassThru
        $ready = $false
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            Start-Sleep -Milliseconds 500
            try {
                $response = Invoke-WebRequest -UseBasicParsing 'http://localhost:3000/' -TimeoutSec 2
                if ($response.StatusCode -eq 200) { $ready = $true; break }
            }
            catch {
                if ($devProcess.HasExited) { break }
            }
        }
        if (-not $ready) { throw 'The local controller did not start on http://localhost:3000/.' }
    }

    npm run companion
}
finally {
    if ($devProcess -and -not $devProcess.HasExited) {
        Stop-Process -Id $devProcess.Id -Force
    }
}
