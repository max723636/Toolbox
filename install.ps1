# =====================================================================
#  Toolbox Handy-Panel - Installation mit einem einzigen Befehl (Windows)
#
#  In PowerShell einfuegen (kein Admin noetig):
#    irm https://max723636.github.io/Toolbox/install.ps1 | iex
#
#  Optionen vorher setzen, z. B.:
#    $env:FERN=1; $env:JAVA=1; irm https://max723636.github.io/Toolbox/install.ps1 | iex
#    FERN=1  Fernzugriff gleich einschalten (sichere https-Adresse fuer unterwegs)
#    JAVA=1  Java 21 sofort mitinstallieren (sonst laedt das Panel passende Java-Versionen bei Bedarf selbst)
#    PORT=...  anderer Port (Standard 8090)
#    APP=...   Adresse deiner Toolbox-App (Standard: https://max723636.github.io/Toolbox/)
#
#  Was passiert: Node.js wird (falls noetig) portabel nach %USERPROFILE%\handy-panel
#  geladen, das Panel ebenfalls, dann werden der Befehl "hp" und der Autostart
#  (beim Anmelden, unsichtbar) eingerichtet und das Panel gestartet. Danach
#  oeffnet sich die Koppel-Seite mit dem QR-Code. Erneut ausfuehren = aktualisieren.
# =====================================================================
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'   # Downloads sonst sehr langsam (PowerShell 5)
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch { }

  function Step($t) { Write-Host "`n> $t" -ForegroundColor Magenta }
  function Ok($t) { Write-Host "  OK  $t" -ForegroundColor Green }
  function Warn($t) { Write-Host "  !   $t" -ForegroundColor Yellow }
  # Bei Programmen, die auf stderr schreiben, darf PowerShell 5 nicht abbrechen -> dort 'Continue'
  function Major($exe) { $ErrorActionPreference = 'Continue'; try { [int](& $exe -p "process.versions.node.split('.')[0]" 2>$null) } catch { 0 } }
  function JavaMajor() { $ErrorActionPreference = 'Continue'; try { $v = (& java -version 2>&1 | Out-String); if ($v -match 'version "(\d+)') { [int]$Matches[1] } else { 0 } } catch { 0 } }
  function Fetch($url, $file) { Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing }

  try {
    $App = if ($env:APP) { $env:APP } else { 'https://max723636.github.io/Toolbox/' }
    if (-not $App.EndsWith('/')) { $App += '/' }
    $Dir = Join-Path $HOME 'handy-panel'
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    $arm = ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') -or ($env:PROCESSOR_ARCHITEW6432 -eq 'ARM64')
    Write-Host "`nToolbox Handy-Panel - Installation" -ForegroundColor White

    # ---------- Node.js ----------
    $own = Join-Path $Dir 'node\node.exe'
    $node = $null
    $sys = Get-Command node -ErrorAction SilentlyContinue
    if ($sys -and (Major $sys.Source) -ge 18) { $node = $sys.Source }
    elseif ((Test-Path $own) -and (Major $own) -ge 18) { $node = $own }
    if ($node) { Ok ("Node.js " + (& $node -v) + " ist schon da") }
    else {
      Step 'Lade Node.js (portabel, nur fuer dich, ohne Admin-Rechte)'
      $base = 'https://nodejs.org/dist/latest-v24.x/'
      $plat = if ($arm) { 'win-arm64' } else { 'win-x64' }
      $line = ((Invoke-WebRequest -Uri ($base + 'SHASUMS256.txt') -UseBasicParsing).Content -split "`n") | Where-Object { $_ -match "node-v[\d.]+-$plat\.zip\s*$" } | Select-Object -First 1
      if (-not $line) { throw 'Konnte die Node.js-Version nicht ermitteln (Internet?).' }
      $sum, $name = ($line.Trim() -split '\s+')
      $zip = Join-Path $env:TEMP $name
      Fetch ($base + $name) $zip
      if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $sum.ToUpper()) { throw 'Pruefsumme von Node.js stimmt nicht - bitte erneut versuchen.' }
      $tmp = Join-Path $Dir 'node-neu'
      Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
      Expand-Archive -Path $zip -DestinationPath $tmp -Force
      Remove-Item (Join-Path $Dir 'node') -Recurse -Force -ErrorAction SilentlyContinue
      Move-Item (Get-ChildItem $tmp | Select-Object -First 1).FullName (Join-Path $Dir 'node')
      Remove-Item $tmp, $zip -Recurse -Force -ErrorAction SilentlyContinue
      $node = $own
      Ok ("Node.js " + (& $node -v))
    }

    # ---------- Java (nur mit JAVA=1) ----------
    if ($env:JAVA) {
      if ((JavaMajor) -ge 21) { Ok 'Java 21 ist schon da' }
      else {
        Step 'Lade Java 21 (Eclipse Temurin, portabel)'
        $jz = Join-Path $env:TEMP 'toolbox-java.zip'
        $ok = $false
        foreach ($a in $(if ($arm) { 'aarch64', 'x64' } else { 'x64' })) {
          try { Fetch "https://api.adoptium.net/v3/binary/latest/21/ga/windows/$a/jre/hotspot/normal/eclipse" $jz; $ok = $true; break } catch { }
        }
        if ($ok) {
          Remove-Item (Join-Path $Dir 'java') -Recurse -Force -ErrorAction SilentlyContinue
          Expand-Archive -Path $jz -DestinationPath (Join-Path $Dir 'java') -Force
          Remove-Item $jz -Force -ErrorAction SilentlyContinue
          Ok "Java 21 liegt in $Dir\java"
        } else { Warn 'Java liess sich nicht laden - Minecraft-Server brauchen Java 21 (z. B. winget install EclipseAdoptium.Temurin.21.JRE).' }
      }
    }

    # ---------- Panel laden ----------
    Step "Lade das Handy-Panel von $App"
    $f = Join-Path $Dir 'handy-panel.js'
    $neu = Join-Path $Dir 'hp-neu.js'
    Fetch ($App + 'handy-panel.js') $neu
    if (-not (Select-String -Path $neu -Pattern 'Toolbox Handy-Panel' -Quiet)) { Remove-Item $neu -Force; throw "Unter ${App}handy-panel.js liegt kein Handy-Panel." }
    & $node --check $neu
    if ($LASTEXITCODE -ne 0) { Remove-Item $neu -Force; throw 'Die geladene Datei ist fehlerhaft.' }
    $opts = @('--app', $App)
    if ($env:PORT) { $opts += @('--port', $env:PORT) }
    # Laeuft schon ein aelteres Panel? Dann beenden, damit die neue Version startet (Server laufen weiter).
    if (Test-Path $f) { & { $ErrorActionPreference = 'Continue'; try { & $node $f @opts beenden *> $null } catch { } } }
    Move-Item $neu $f -Force
    Ok "Gespeichert in $f"

    # ---------- Einrichten: Befehl "hp", Autostart, starten, koppeln ----------
    Step 'Richte ein (Befehl hp, Autostart) und starte das Panel'
    if ($env:FERN) { $opts += '--fernzugriff' }
    & $node $f @opts einrichten
    Write-Host "`nFertig! Scanne den QR-Code auf der geoeffneten Seite mit der Toolbox-App (oder oeffne den Link)." -ForegroundColor Green
    Write-Host '  Hilfe: hp hilfe  -  Status: hp status  -  Fernzugriff: hp fernzugriff an'
    Write-Host '  (Der Befehl hp funktioniert in jedem neuen PowerShell- oder CMD-Fenster.)'
  } catch {
    Write-Host ("`nFehler: " + $_.Exception.Message) -ForegroundColor Red
  }
}
