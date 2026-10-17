Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$env:BOAA_PORTABLE_SMOKE_TOKEN = [guid]::NewGuid().ToString('N')
$source = Join-Path (Get-Location) 'release/Boaa.exe'
if (!(Test-Path $source)) { throw 'Portable executable is missing.' }

$firstFolder = Join-Path $env:RUNNER_TEMP 'Boaa portable 한글 path'
$movedFolder = Join-Path $env:RUNNER_TEMP 'Boaa portable moved path'
New-Item -ItemType Directory -Path $firstFolder -Force | Out-Null
Copy-Item $source (Join-Path $firstFolder 'Boaa.exe') -Force

function Wait-ForRuntime($process, $folder, $stderrName, $expectPersisted = $false) {
  $deadline = (Get-Date).AddSeconds(150)
  do {
    $process.Refresh()
    if ($process.HasExited) {
      Write-Host "Profile exists: $(Test-Path (Join-Path $folder 'BoaaData'))"
      Get-ChildItem $folder -Recurse -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 60 -ExpandProperty FullName
      $stderr = Join-Path $folder $stderrName
      if (Test-Path $stderr) { Get-Content $stderr -Tail 30 }
      throw "Boaa.exe exited during launch (code $($process.ExitCode))."
    }
    $sidecar = Get-ChildItem (Join-Path $folder 'BoaaData/runtime') -Filter 'node.exe' -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -like '*extension-sidecar*' } | Select-Object -First 1
    $marker = Join-Path $folder "BoaaData/.smoke-$env:BOAA_PORTABLE_SMOKE_TOKEN.json"
    if ($sidecar -and (Test-Path $marker)) {
      $ready = Get-Content $marker -Raw | ConvertFrom-Json
      if ($ready.pid -eq $process.Id -and (!$expectPersisted -or $ready.persisted)) { return }
    }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  throw 'Boaa.exe did not prepare its portable runtime and WebView data.'
}

function Stop-Boaa($process) {
  if ($process) {
    $process.Refresh()
    if (!$process.HasExited) {
      $null = $process.CloseMainWindow()
      if (!$process.WaitForExit(10000)) { Stop-Process -Id $process.Id -Force; $process.WaitForExit(10000) | Out-Null }
    }
  }
}

$first = $null
$second = $null
$moved = $null
try {
  $first = Start-Process (Join-Path $firstFolder 'Boaa.exe') -PassThru -RedirectStandardError (Join-Path $firstFolder 'boaa-stderr.txt')
  Write-Host "Normal Boaa process: $($first.Id)"
  Wait-ForRuntime $first $firstFolder 'boaa-stderr.txt'
  Start-Sleep -Seconds 5
  $first.Refresh()
  if ($first.HasExited) { throw 'Boaa.exe exited after portable runtime preparation.' }

  $second = Start-Process (Join-Path $firstFolder 'Boaa.exe') -PassThru
  Write-Host "Second Boaa process: $($second.Id)"
  if (!$second.WaitForExit(15000)) { throw 'A second Boaa.exe did not focus or reject the running profile.' }
  $first.Refresh()
  if ($first.HasExited) { throw 'A second launch closed the running Boaa.exe.' }

  Stop-Boaa $first
  $first = $null
  Move-Item $firstFolder $movedFolder
  $moved = Start-Process (Join-Path $movedFolder 'Boaa.exe') -PassThru -RedirectStandardError (Join-Path $movedFolder 'boaa-moved-stderr.txt')
  Wait-ForRuntime $moved $movedFolder 'boaa-moved-stderr.txt' $true
  Start-Sleep -Seconds 5
  $moved.Refresh()
  if ($moved.HasExited) { throw 'Boaa.exe exited after moving the entire portable folder.' }
  Write-Host 'Portable UI mount, second launch exclusion, and setting preservation after folder move passed.'
} finally {
  Remove-Item Env:BOAA_PORTABLE_SMOKE_TOKEN -ErrorAction SilentlyContinue
  Stop-Boaa $second
  Stop-Boaa $first
  Stop-Boaa $moved
}
