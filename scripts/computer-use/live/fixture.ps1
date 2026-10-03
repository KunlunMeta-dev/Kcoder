param([Parameter(Mandatory=$true)][string]$OutputDirectory, [switch]$VisualChallenge,
    [ValidateRange(10,600)][int]$LifetimeSeconds = 150)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class KCTestDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[KCTestDpi]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object Windows.Forms.Form
$form.Text = 'KCoder isolated input fixture'
$form.StartPosition = 'Manual'
$area = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location = New-Object Drawing.Point(($area.X + 30), ($area.Y + 30))
$form.Size = New-Object Drawing.Size(([Math]::Min(850, $area.Width - 60)), ([Math]::Min(550, $area.Height - 60)))
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.BackColor = [Drawing.Color]::White
$challenge = if ($VisualChallenge) { (Get-Random -Minimum 1000 -Maximum 10000).ToString() } else { '' }
$challengeFont = New-Object Drawing.Font('Segoe UI', 32, [Drawing.FontStyle]::Bold)
$form.Add_Paint({ param($sender, $eventArgs)
    if ($VisualChallenge) {
        $eventArgs.Graphics.DrawString($challenge, $challengeFont, [Drawing.Brushes]::Black, 300, 250)
    }
})
$label = New-Object Windows.Forms.Label
$label.Text = 'KCoder desktop test - temporary window only'
$label.Location = New-Object Drawing.Point(25, 25)
$label.Size = New-Object Drawing.Size(650, 40)
$inputBox = New-Object Windows.Forms.TextBox
$inputBox.Name = 'KCoderInput'
$inputBox.AccessibleName = 'KCoderInput'
$inputBox.Multiline = $true
$inputBox.Location = New-Object Drawing.Point(25, 85)
$inputBox.Size = New-Object Drawing.Size(($form.ClientSize.Width - 50), 140)
$button = New-Object Windows.Forms.Button
$button.Text = 'Verify test input'
$button.AccessibleName = 'Verify test input'
$button.Location = New-Object Drawing.Point(25, 255)
$button.Size = New-Object Drawing.Size(220, 50)
$utf8 = New-Object Text.UTF8Encoding($false)
$button.Add_Click({
    $result = @{ text = $inputBox.Text; clicked = $true } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText((Join-Path $OutputDirectory 'input-result.json'), $result, $utf8)
})
$form.Controls.AddRange(@($label, $inputBox, $button))
$form.Add_Shown({
    $form.Activate()
    $rect = $form.RectangleToScreen($form.ClientRectangle)
    $point = $inputBox.PointToScreen((New-Object Drawing.Point(30, 30)))
    $click = $button.PointToScreen((New-Object Drawing.Point(70, 20)))
    $ready = @{ pid = $PID; hwnd = $form.Handle.ToInt64(); challenge = $challenge; region = @($rect.Left, $rect.Top, $rect.Right, $rect.Bottom); inputLoc = @($point.X, $point.Y); buttonLoc = @($click.X, $click.Y) } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText((Join-Path $OutputDirectory 'fixture-ready.json'), $ready, $utf8)
})
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 200
$deadline = [DateTime]::UtcNow.AddSeconds($LifetimeSeconds)
$timer.Add_Tick({
    if ((Test-Path -LiteralPath (Join-Path $OutputDirectory 'close.fixture')) -or [DateTime]::UtcNow -gt $deadline) { $form.Close() }
})
$timer.Start()
try { [Windows.Forms.Application]::Run($form) }
finally { $timer.Dispose(); $challengeFont.Dispose(); $form.Dispose() }
