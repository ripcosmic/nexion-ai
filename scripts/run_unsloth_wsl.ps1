param(
    [switch]$Install,
    [string]$BaseModel = 'unsloth/Llama-3.2-1B-Instruct',
    [double]$Epochs = 3,
    [int]$MaxSeqLength = 2048,
    [int]$BatchSize = 2,
    [int]$GradAccumulation = 4,
    [ValidateSet('lora', 'merged_16bit', 'merged_4bit')]
    [string]$SaveMethod = 'merged_16bit',
    [switch]$ExportGguf
)

$wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
if (-not $wsl) {
    throw 'WSL is not installed. Install it with "wsl.exe --install", restart Windows, then run this task again.'
}

$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$linuxWorkspace = (& $wsl.Source wslpath -a $workspace 2>$null | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $linuxWorkspace) {
    throw 'Could not convert the workspace path for WSL.'
}

$setup = @'
set -e
cd "$1"
if [ ! -x .venv-unsloth/bin/python ]; then
  python3 -m venv .venv-unsloth
fi
.venv-unsloth/bin/python -m pip install --upgrade pip
.venv-unsloth/bin/python -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
.venv-unsloth/bin/python -m pip install -r requirements-unsloth.txt
'@

$train = @'
set -e
cd "$1"
exec .venv-unsloth/bin/python scripts/finetune_unsloth.py \
  --base-model "$2" \
  --epochs "$3" \
  --max-seq-length "$4" \
  --batch-size "$5" \
  --grad-accumulation "$6" \
  --save-method "$7" \
  ${8}
'@

$ggufFlag = if ($ExportGguf) { '--export-gguf' } else { '' }

if ($Install) {
    & $wsl.Source bash -lc $setup -- $linuxWorkspace
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

& $wsl.Source bash -lc $train -- $linuxWorkspace $BaseModel $Epochs $MaxSeqLength $BatchSize $GradAccumulation $SaveMethod $ggufFlag
exit $LASTEXITCODE
