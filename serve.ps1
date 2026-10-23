# Serves Logo Prep Studio to this computer only, at http://localhost:8790
# Nothing is sent anywhere: the page and its AI models are loaded from this folder.
$port = 8790
$root = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript'; '.mjs' = 'text/javascript'
  '.css' = 'text/css'; '.json' = 'application/json'; '.wasm' = 'application/wasm'
  '.bin' = 'application/octet-stream'; '.svg' = 'image/svg+xml'; '.png' = 'image/png'
  '.woff' = 'font/woff'; '.woff2' = 'font/woff2'; '.md' = 'text/plain; charset=utf-8'
}
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
try { $listener.Start() } catch {
  Write-Host "Could not start on port $port. Is Logo Prep Studio already open in another window?"
  Read-Host "Press Enter to close"; exit 1
}
Write-Host "Logo Prep Studio is running at http://localhost:$port/"
Write-Host "Keep this window open while you use it. Close it to stop."
Start-Process "http://localhost:$port/"
while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
    if ($rel -eq '') { $rel = 'index.html' }
    $file = [IO.Path]::GetFullPath((Join-Path $root $rel))
    if ($file.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $file -PathType Leaf)) {
      $bytes = [IO.File]::ReadAllBytes($file)
      $ext = [IO.Path]::GetExtension($file).ToLower()
      $ctx.Response.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
    }
    $ctx.Response.Close()
  } catch {
    # a browser tab closing mid-download is harmless; keep serving
  }
}
