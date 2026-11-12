/** Fixed Windows registry, toast and install scripts shipped as JavaScript strings (no packaged assets). */

/** WinRT application id already registered by the installed desktop shortcut; reused read-only. */
export const NOTIFICATION_APP_ID = 'electron.app.DeepSeek Harness'
/** Private toast group owned by this carrier; never used to clear another application's history. */
export const NOTIFICATION_GROUP = 'dsh-notifications'
/** Per-user URL scheme that returns activation to the owning Host instance. */
export const NOTIFICATION_PROTOCOL = 'dsh-notifications'
/** Only this activation URI prefix is accepted by the protocol launcher. */
export const NOTIFICATION_ACTIVATION_PREFIX = NOTIFICATION_PROTOCOL + '://activate'
/** Loopback route mounted by the owning Host instance. */
export const NOTIFICATION_ACTIVATION_PATH = '/dsh-notifications/activate/'
/** Per-user protocol key below HKCU\\Software\\Classes. */
export const NOTIFICATION_REGISTRY_KEY = 'Software\\Classes\\' + NOTIFICATION_PROTOCOL
/** Ownership marker; a key without this exact value is never overwritten. */
export const NOTIFICATION_OWNER_NAME = 'DshNotificationsProtocolOwner'
/** Stable owner value written by this implementation. */
export const NOTIFICATION_OWNER_VALUE = 'dsh-notifications.v1'

/**
 * Install the per-user protocol for the GUI launcher. The owner marker is checked before any
 * filesystem or compiler work. A matching source hash plus a PE GUI-subsystem executable is
 * reused; otherwise the fixed source is compiled through the OS .NET Framework compiler to an
 * owned temporary executable, verified as IMAGE_SUBSYSTEM_WINDOWS_GUI, and atomically replaced.
 * The registry command is checked to be exactly the executable plus the fixed "%1" token.
 */
export const SETUP_SCRIPT = String.raw`# dsh-notifications: setup (per-user GUI launcher)
$ErrorActionPreference = 'Stop'
function Test-ReparsePoint([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  $attributes = [System.IO.File]::GetAttributes($Path)
  return (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}
function Get-FileSha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $bytes = $sha.ComputeHash($stream) } finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
  return ([System.BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}
function Test-GuiSubsystem([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 0x40) { return $false }
  if ($bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) { return $false }
  $pe = [System.BitConverter]::ToInt32($bytes, 0x3C)
  if ($pe -lt 0x40 -or ($pe + 0x5E) -gt $bytes.Length) { return $false }
  if ($bytes[$pe] -ne 0x50 -or $bytes[$pe + 1] -ne 0x45 -or $bytes[$pe + 2] -ne 0 -or $bytes[$pe + 3] -ne 0) { return $false }
  return ([System.BitConverter]::ToUInt16($bytes, $pe + 0x5C) -eq 2)
}
try {
  $reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
  $payload = $reader.ReadToEnd() | ConvertFrom-Json
  $reader.Dispose()
  $key = 'HKCU:\' + [string]$payload.keyPath
  $markerName = [string]$payload.markerName
  $markerValue = [string]$payload.markerValue
  if (Test-Path -LiteralPath $key) {
    $existing = $null
    try {
      $property = Get-ItemProperty -LiteralPath $key -Name $markerName -ErrorAction Stop
      $existing = [string]$property.$markerName
    } catch {
      $existing = $null
    }
    if ($existing -ne $markerValue) { exit 2 }
  }
  $directory = [string]$payload.launcherDirectory
  $launcher = [string]$payload.launcherPath
  $source = [string]$payload.sourcePath
  $hashFile = [string]$payload.hashPath
  $sourceHash = [string]$payload.sourceHash
  if ($sourceHash -notmatch '^[0-9a-f]{64}$') { exit 1 }
  if ([System.IO.Path]::GetFileName($launcher) -ne 'activate.exe') { exit 1 }
  if ([string]$payload.command -ne ('"' + $launcher + '" "%1"')) { exit 1 }
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { exit 1 }
  $current = $directory
  while (-not [string]::IsNullOrEmpty($current)) {
    if (Test-Path -LiteralPath $current) {
      if (Test-ReparsePoint $current) { exit 1 }
      if (-not (Test-Path -LiteralPath $current -PathType Container)) { exit 1 }
    }
    $parent = [System.IO.Directory]::GetParent($current)
    if ($null -eq $parent) { break }
    $current = $parent.FullName
  }
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) { exit 1 }
  foreach ($target in @($launcher, $source, $hashFile)) {
    if (Test-Path -LiteralPath $target) {
      if (Test-ReparsePoint $target) { exit 1 }
      if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { exit 1 }
    }
  }
  if ((Get-FileSha256 $source) -ne $sourceHash) { exit 1 }
  $reuse = $false
  if (Test-Path -LiteralPath $launcher -PathType Leaf) {
    if (Test-Path -LiteralPath $hashFile -PathType Leaf) {
      $recorded = ([System.IO.File]::ReadAllText($hashFile)).Trim().ToLowerInvariant()
      if ($recorded -eq $sourceHash -and (Test-GuiSubsystem $launcher)) { $reuse = $true }
    }
  }
  if (-not $reuse) {
    $temporary = Join-Path $directory ('.activate.' + [Guid]::NewGuid().ToString('N') + '.tmp.exe')
    try {
      $definition = [System.IO.File]::ReadAllText($source)
      Add-Type -TypeDefinition $definition -Language CSharp -OutputType WindowsApplication -OutputAssembly $temporary -ErrorAction Stop
      if (-not (Test-GuiSubsystem $temporary)) { exit 1 }
      if (Test-Path -LiteralPath $launcher -PathType Leaf) {
        $backup = $launcher + '.bak.' + [Guid]::NewGuid().ToString('N')
        try {
          [System.IO.File]::Replace($temporary, $launcher, $backup)
        } finally {
          if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue }
        }
      } else {
        [System.IO.File]::Move($temporary, $launcher)
      }
    } finally {
      if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    }
    if (-not (Test-GuiSubsystem $launcher)) { exit 1 }
    [System.IO.File]::WriteAllText($hashFile, $sourceHash)
  }
  if (-not (Test-Path -LiteralPath $key)) {
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -LiteralPath $key -Name $markerName -Value $markerValue -PropertyType String -Force | Out-Null
  }
  Set-ItemProperty -LiteralPath $key -Name '(default)' -Value ([string]$payload.displayName)
  New-ItemProperty -LiteralPath $key -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
  $commandKey = $key + '\shell\open\command'
  New-Item -Path $commandKey -Force | Out-Null
  Set-ItemProperty -LiteralPath $commandKey -Name '(default)' -Value ([string]$payload.command)
  exit 0
} catch {
  exit 1
}
`

/** Show one protocol-activation toast through the existing desktop identity, silent and without a reminder. */
export const SHOW_SCRIPT = String.raw`# dsh-notifications: show
$ErrorActionPreference = 'Stop'
try {
  $reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
  $payload = $reader.ReadToEnd() | ConvertFrom-Json
  $reader.Dispose()
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $document = New-Object Windows.Data.Xml.Dom.XmlDocument
  $document.LoadXml([string]$payload.xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $document
  $toast.Tag = [string]$payload.tag
  $toast.Group = [string]$payload.group
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier([string]$payload.aumid)
  $notifier.Show($toast)
  [Console]::Out.Write('SHOWN')
  exit 0
} catch {
  [Console]::Error.Write('toast-failed')
  exit 1
}
`

/** Remove only the exact tags this carrier created. Unknown tags are ignored. */
export const REMOVE_SCRIPT = String.raw`# dsh-notifications: remove
$ErrorActionPreference = 'Stop'
try {
  $reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
  $payload = $reader.ReadToEnd() | ConvertFrom-Json
  $reader.Dispose()
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  $aumid = [string]$payload.aumid
  $group = [string]$payload.group
  foreach ($tag in @($payload.tags)) {
    try {
      [Windows.UI.Notifications.ToastNotificationManager]::History.Remove([string]$tag, $group, $aumid)
    } catch {
    }
  }
  exit 0
} catch {
  exit 1
}
`
