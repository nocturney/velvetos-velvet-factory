param(
  [Parameter(Mandatory=$true)]
  [ValidateSet('Protect','Unprotect')]
  [string]$Operation,
  [Parameter(Mandatory=$true)]
  [string]$ProtectedFile
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
if ([IO.Path]::GetFileName($ProtectedFile) -ne 'fleet-signing-key.dpapi' -or
    -not [IO.Path]::IsPathRooted($ProtectedFile)) {
  throw 'invalid_protected_key_path'
}
$parent = [IO.Path]::GetDirectoryName($ProtectedFile)
if (-not [IO.Directory]::Exists($parent)) {
  throw 'protected_key_directory_missing'
}
$entropy = [Text.Encoding]::UTF8.GetBytes('VelvetOS/Fleet/Ed25519/DPAPI/CurrentUser/v1')
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
if ($Operation -eq 'Protect') {
  if ([IO.File]::Exists($ProtectedFile)) {
    throw 'protected_key_already_exists'
  }
  # PKCS8 secret arrives over private stdin pipe, never argv, env or file.
  $line = [Console]::In.ReadToEnd().Trim()
  if ($line.Length -lt 48 -or $line.Length -gt 2048) {
    throw 'invalid_private_key_payload'
  }
  $plain = [Convert]::FromBase64String($line)
  $temp = $ProtectedFile + '.' + [guid]::NewGuid().ToString('N') + '.new'
  try {
    $cipher = [Security.Cryptography.ProtectedData]::Protect($plain, $entropy, $scope)
    [IO.File]::WriteAllBytes($temp, $cipher)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = Get-Acl -LiteralPath $temp
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($entry in @($acl.Access)) {
      [void]$acl.RemoveAccessRuleAll($entry)
    }
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
      $sid, [Security.AccessControl.FileSystemRights]::FullControl,
      [Security.AccessControl.AccessControlType]::Allow)
    [void]$acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $temp -AclObject $acl
    $checked = Get-Acl -LiteralPath $temp
    $allow = @($checked.Access | Where-Object { $_.AccessControlType -eq 'Allow' })
    if ($allow.Count -ne 1 -or $allow[0].IdentityReference -ne $sid -and
        $allow[0].IdentityReference.Value -ne $sid.Value) {
      throw 'protected_key_acl_rejected'
    }
    # No overwrite. If the target raced into existence, exit without replacing.
    [IO.File]::Move($temp, $ProtectedFile)
    [Console]::Out.Write('PROTECTED_KEY_SAVED')
  } finally {
    [Array]::Clear($plain, 0, $plain.Length)
    if ($cipher) { [Array]::Clear($cipher, 0, $cipher.Length) }
    if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) }
  }
} else {
  if (-not [IO.File]::Exists($ProtectedFile)) {
    throw 'protected_key_not_found'
  }
  $cipher = [IO.File]::ReadAllBytes($ProtectedFile)
  $plain = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $entropy, $scope)
  try {
    # Delivers the PKCS8 only through an in-memory child stdout pipe captured by Node.
    [Console]::Out.Write([Convert]::ToBase64String($plain))
  } finally {
    [Array]::Clear($cipher, 0, $cipher.Length)
    [Array]::Clear($plain, 0, $plain.Length)
  }
}
