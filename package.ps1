param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $output -Force | Out-Null
$staging = Join-Path ([System.IO.Path]::GetTempPath()) ('copilot-archive-package-' + [guid]::NewGuid())
$package = Join-Path $staging 'conversation-archive'
$files = @(
    'plugin.json',
    'package.json',
    'README.md',
    'archive.mjs',
    'package.ps1',
    'extensions\archive\extension.mjs',
    'extensions\archive\controller.mjs',
    'extensions\archive\core.mjs',
    'test\archive.test.mjs',
    'test\runtime-smoke.mjs'
)
$zip = Join-Path $output 'conversation-archive-0.1.0.zip'
if (Test-Path -LiteralPath $zip) { throw "Refusing to overwrite existing package: $zip" }
try {
    foreach ($file in $files) {
        $destination = Join-Path $package $file
        New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $source $file) -Destination $destination
    }
    Compress-Archive -LiteralPath $package -DestinationPath $zip
    Get-FileHash -LiteralPath $zip -Algorithm SHA256
}
finally {
    if (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force
    }
}
