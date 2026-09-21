param(
    [ValidateSet('Configure', 'Build', 'Run')]
    [string]$Action = 'Build',
    [ValidateSet('Release', 'Debug')]
    [string]$Configuration = 'Release',
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$source = Join-Path $workspace 'llama.cpp'
$build = Join-Path $source 'build-nexion'
$cmake = Get-Command cmake.exe -ErrorAction SilentlyContinue
if (-not $cmake) {
    $knownPath = 'C:\Program Files\CMake\bin\cmake.exe'
    if (Test-Path $knownPath) { $cmake = Get-Item $knownPath }
}
if (-not $cmake) {
    throw 'CMake was not found. Install CMake and reopen VS Code so it is on PATH.'
}
if (-not (Test-Path (Join-Path $source 'CMakeLists.txt'))) {
    throw "llama.cpp source tree was not found at $source."
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vs = if (Test-Path $vswhere) {
    & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
} else { $null }
if (-not $vs) {
    throw 'A Visual Studio C++ toolchain is required. Install Visual Studio Build Tools with the Desktop development with C++ workload.'
}

if ($Clean -and (Test-Path $build)) {
    Remove-Item -Recurse -Force $build
}

$generator = 'Visual Studio 17 2022'
if ($Action -eq 'Configure' -or -not (Test-Path (Join-Path $build 'CMakeCache.txt'))) {
    & $cmake.Source -S $source -B $build -G $generator -A x64 `
        -DLLAMA_BUILD_SERVER=ON `
        -DLLAMA_BUILD_COMMON=ON `
        -DLLAMA_BUILD_TOOLS=ON `
        -DGGML_NATIVE=ON
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    if ($Action -eq 'Configure') { exit 0 }
}

if ($Action -eq 'Build') {
    & $cmake.Source --build $build --config $Configuration --parallel
    exit $LASTEXITCODE
}

if ($Action -eq 'Run') {
    $server = Join-Path $build "bin\$Configuration\llama-server.exe"
    if (-not (Test-Path $server)) {
        & $cmake.Source --build $build --config $Configuration --parallel
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    & $server @args
    exit $LASTEXITCODE
}
