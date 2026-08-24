$ErrorActionPreference = "Stop"
$BinDir = Split-Path -Parent $MyInvocation.MyCommand.Path
node (Join-Path $BinDir "gmaps-crab.js") @args
exit $LASTEXITCODE
