param([Parameter(Mandatory=$true)][string]$OutputDirectory, [switch]$VisualChallenge, [switch]$FullViewIsolation, [switch]$InputDiagnostics,
    [ValidateRange(10,600)][int]$LifetimeSeconds = 150)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class KCTestDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[KCTestDpi]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if ($InputDiagnostics) {
    Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public sealed class KCTestObservedTextBox : TextBox {
    [DllImport("user32.dll")] private static extern IntPtr GetMessageExtraInfo();
    public readonly List<string> InputEvents = new List<string>();
    private int sequence;
    private static bool ObserveKey(int key) { return key == 8 || key == 17 || key == 65 || key == 162 || key == 163 || key == 231; }
    private void Record(string stage, int message, int keyData, int handled) {
        if (InputEvents.Count >= 256) return;
        InputEvents.Add(String.Format(CultureInfo.InvariantCulture,
            "{{\"sequence\":{0},\"tick\":{1},\"stage\":\"{2}\",\"message\":{3},\"keyData\":{4},\"handled\":{5},\"focused\":{6},\"ctrl\":{7},\"selectionStart\":{8},\"selectionLength\":{9},\"textLength\":{10},\"taggedMessage\":{11}}}",
            ++sequence, Environment.TickCount, stage, message, keyData, handled,
            Focused ? "true" : "false", (Control.ModifierKeys & Keys.Control) != Keys.None ? "true" : "false",
            SelectionStart, SelectionLength, TextLength, GetMessageExtraInfo() != IntPtr.Zero ? "true" : "false"));
    }
    protected override bool ProcessCmdKey(ref Message message, Keys keyData) {
        bool observe = ObserveKey((int)(keyData & Keys.KeyCode));
        if (observe) Record("cmd-before", message.Msg, (int)keyData, -1);
        bool handled = base.ProcessCmdKey(ref message, keyData);
        if (observe) Record("cmd-after", message.Msg, (int)keyData, handled ? 1 : 0);
        return handled;
    }
    protected override void WndProc(ref Message message) {
        bool character = message.Msg == 0x102;
        bool key = message.Msg == 0x100 || message.Msg == 0x101 || message.Msg == 0x104 || message.Msg == 0x105;
        bool observe = character || (key && ObserveKey((int)message.WParam.ToInt64()));
        int keyData = character ? 0 : (int)message.WParam.ToInt64();
        if (observe) Record("message-before", message.Msg, keyData, -1);
        base.WndProc(ref message);
        if (observe) Record("message-after", message.Msg, keyData, -1);
    }
    protected override void OnGotFocus(EventArgs args) { base.OnGotFocus(args); Record("focus-gained", 0, 0, -1); }
    protected override void OnLostFocus(EventArgs args) { base.OnLostFocus(args); Record("focus-lost", 0, 0, -1); }
}
'@
}
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
if ($FullViewIsolation) {
    # Cover the full virtual desktop so native full-view test screenshots cannot
    # contain private background windows. Normal fixture layout stays unchanged.
    $form.FormBorderStyle = 'None'
    $form.ShowInTaskbar = $false
    $form.Bounds = [Windows.Forms.SystemInformation]::VirtualScreen
}
$script:clickCount = 0
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
$inputBox = if ($InputDiagnostics) { New-Object KCTestObservedTextBox } else { New-Object Windows.Forms.TextBox }
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
    $script:clickCount += 1
    $resultData = @{ text = $inputBox.Text; clicked = $true }
    if ($FullViewIsolation) { $resultData.clickCount = $script:clickCount }
    $result = $resultData | ConvertTo-Json -Compress
    [IO.File]::WriteAllText((Join-Path $OutputDirectory 'input-result.json'), $result, $utf8)
})
$form.Controls.AddRange(@($label, $inputBox, $button))
$form.Add_Shown({
    $form.Activate()
    $rect = $form.RectangleToScreen($form.ClientRectangle)
    $point = $inputBox.PointToScreen((New-Object Drawing.Point(30, 30)))
    $click = $button.PointToScreen((New-Object Drawing.Point(70, 20)))
    $virtual = [Windows.Forms.SystemInformation]::VirtualScreen
    $isolationConfirmed = $FullViewIsolation -and $rect.Left -eq $virtual.Left -and $rect.Top -eq $virtual.Top -and $rect.Right -eq $virtual.Right -and $rect.Bottom -eq $virtual.Bottom
    $ready = @{ fullViewIsolated = $isolationConfirmed; pid = $PID; hwnd = $form.Handle.ToInt64(); challenge = $challenge; region = @($rect.Left, $rect.Top, $rect.Right, $rect.Bottom); inputLoc = @($point.X, $point.Y); buttonLoc = @($click.X, $click.Y) } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText((Join-Path $OutputDirectory 'fixture-ready.json'), $ready, $utf8)
})
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 200
$deadline = [DateTime]::UtcNow.AddSeconds($LifetimeSeconds)
$timer.Add_Tick({
    if ($InputDiagnostics) {
        [IO.File]::WriteAllLines((Join-Path $OutputDirectory 'input-events.jsonl'), [string[]]$inputBox.InputEvents.ToArray(), $utf8)
    }
    if ((Test-Path -LiteralPath (Join-Path $OutputDirectory 'close.fixture')) -or [DateTime]::UtcNow -gt $deadline) { $form.Close() }
})
$timer.Start()
try { [Windows.Forms.Application]::Run($form) }
finally {
    if ($InputDiagnostics) {
        [IO.File]::WriteAllLines((Join-Path $OutputDirectory 'input-events.jsonl'), [string[]]$inputBox.InputEvents.ToArray(), $utf8)
    }
    $timer.Dispose(); $challengeFont.Dispose(); $form.Dispose()
}
