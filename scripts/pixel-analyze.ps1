# pixel-analyze.ps1 — sample region colors/diversity of a screenshot
param([string]$Path = "out\nla-test.png")

Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile((Join-Path (Get-Location) $Path))
$w = $bmp.Width; $h = $bmp.Height
Write-Output "size ${w}x${h}"

function Sample ($name, $x0p, $y0p, $x1p, $y1p) {
  $x0 = [int]($w * $x0p); $x1 = [int]($w * $x1p)
  $y0 = [int]($h * $y0p); $y1 = [int]($h * $y1p)
  $colors = @{}
  $sr = 0; $sg = 0; $sb = 0; $n = 0
  for ($y = $y0; $y -lt $y1; $y += 7) {
    for ($x = $x0; $x -lt $x1; $x += 7) {
      $c = $bmp.GetPixel($x, $y)
      $sr += $c.R; $sg += $c.G; $sb += $c.B; $n++
      $key = "$($c.R),$($c.G),$($c.B)"
      $colors[$key] = 1
    }
  }
  if ($n -gt 0) {
    Write-Output ("{0,-9} avg=({1},{2},{3}) unique={4}/{5}" -f $name, [int]($sr/$n), [int]($sg/$n), [int]($sb/$n), $colors.Count, $n)
  }
}

Sample 'tabbar'  0.05 0.005 0.95 0.028
Sample 'rdp_top' 0.10 0.045 0.90 0.09
Sample 'rdp_mid' 0.25 0.30  0.75 0.70
Sample 'rdp_bot' 0.10 0.90  0.90 0.98
$bmp.Dispose()
