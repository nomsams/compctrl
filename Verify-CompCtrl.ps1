param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$FilePath,
    [string]$ChecksumFile
)

$ErrorActionPreference = 'Stop'
$resolvedFile = (Resolve-Path -LiteralPath $FilePath).Path
if (-not $ChecksumFile) {
    $ChecksumFile = Join-Path (Split-Path -Parent $resolvedFile) 'SHA256SUMS.txt'
}
$resolvedChecksums = (Resolve-Path -LiteralPath $ChecksumFile).Path
$fileName = Split-Path -Leaf $resolvedFile
$escapedName = [regex]::Escape($fileName)
$line = Get-Content -LiteralPath $resolvedChecksums | Where-Object { $_ -match "^[A-Fa-f0-9]{64}\s+\*?$escapedName$" } | Select-Object -First 1
if (-not $line) { throw "No SHA-256 entry for $fileName was found in $resolvedChecksums." }

$expected = ($line -split '\s+')[0].ToUpperInvariant()
$actual = (Get-FileHash -LiteralPath $resolvedFile -Algorithm SHA256).Hash.ToUpperInvariant()
if ($actual -ne $expected) { throw "Integrity check FAILED for $fileName. Do not run this file." }

Write-Host "Integrity check passed for $fileName" -ForegroundColor Green
Write-Host "SHA-256: $actual"
