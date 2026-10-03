function Get-NonPortableWindowsMarketplaceNames([PSCustomObject]$Settings) {
    $nonPortable = [Collections.Generic.List[string]]::new()
    $pluginsProperty = $Settings.PSObject.Properties["plugins"]
    if ($null -eq $pluginsProperty -or $pluginsProperty.Value -isnot [PSCustomObject]) {
        return $nonPortable.ToArray()
    }
    $marketplacesProperty = $pluginsProperty.Value.PSObject.Properties["marketplaces"]
    if ($null -eq $marketplacesProperty -or $marketplacesProperty.Value -isnot [PSCustomObject]) {
        return $nonPortable.ToArray()
    }

    foreach ($entry in @($marketplacesProperty.Value.PSObject.Properties)) {
        if ($entry.Value -isnot [PSCustomObject]) {
            continue
        }
        $sourceProperty = $entry.Value.PSObject.Properties["source"]
        if ($null -eq $sourceProperty -or $sourceProperty.Value -isnot [PSCustomObject]) {
            continue
        }
        $source = $sourceProperty.Value
        $typeProperty = $source.PSObject.Properties["type"]
        $pathProperty = $source.PSObject.Properties["path"]
        if ($null -eq $typeProperty -or $null -eq $pathProperty -or $typeProperty.Value -ne "local") {
            continue
        }

        $path = ([string]$pathProperty.Value).Trim()
        $isPosixAbsolute = $path -match '^/'
        $isRootProfilePath = $path -match '^[A-Za-z]:[\\/]+root(?:[\\/]|$)'
        if ($isPosixAbsolute -or $isRootProfilePath) {
            [void]$nonPortable.Add($entry.Name)
        }
    }
    return $nonPortable.ToArray()
}

function Remove-NonPortableWindowsMarketplaces([PSCustomObject]$Settings) {
    $names = @(Get-NonPortableWindowsMarketplaceNames $Settings)
    if ($names.Count -eq 0) {
        return $names
    }

    $marketplaces = $Settings.PSObject.Properties["plugins"].Value.PSObject.Properties["marketplaces"].Value
    foreach ($name in $names) {
        $marketplaces.PSObject.Properties.Remove($name)
    }
    return $names
}
