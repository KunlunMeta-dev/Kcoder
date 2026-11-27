# Private deterministic MCP fixture; no network or desktop interaction.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$program = (Get-Process -Id $PID).Path
$leaf = Start-Process -FilePath $program -ArgumentList @('-NoLogo', '-NoProfile', '-Command', 'Start-Sleep -Seconds 60') -WindowStyle Hidden -PassThru
[System.IO.File]::WriteAllText($env:KCODER_PRIVATE_STDIO_PID, [string]$leaf.Id)
while ($null -ne ($line = [Console]::ReadLine())) {
    $request = $line | ConvertFrom-Json
    if ($null -eq $request.id) { continue }
    switch ($request.method) {
        'initialize' {
            $result = @{protocolVersion='2024-11-05'; capabilities=@{tools=@{}}; serverInfo=@{name='private-fixture'; version='1'}}
        }
        'tools/list' {
            $result = @{tools=@(@{name='echo'; description='Private fixture'; inputSchema=@{type='object'; properties=@{}}})}
        }
        'tools/call' {
            $result = @{content=@(@{type='text'; text=$env:KCODER_PRIVATE_STDIO_TOKEN}); isError=$false}
        }
        default { throw 'Unexpected fixture method' }
    }
    $response = @{jsonrpc='2.0'; id=$request.id; result=$result} | ConvertTo-Json -Depth 12 -Compress
    [Console]::WriteLine($response)
}
