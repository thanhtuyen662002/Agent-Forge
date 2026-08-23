function Test-ReleaseCollisionJson([string]$rawJson, [string]$canonicalTag = "v0.1.0", [string]$normalizedVersion = "0.1.0") {
  if ([string]::IsNullOrWhiteSpace($rawJson)) {
    return @{ Success = $false; Error = "EMPTY_OUTPUT" }
  }

  $pages = $null
  try {
    $cmd = Get-Command ConvertFrom-Json
    if ($cmd.Parameters.ContainsKey('NoEnumerate')) {
      $pages = ConvertFrom-Json -InputObject $rawJson -NoEnumerate
    } else {
      $pages = ConvertFrom-Json -InputObject $rawJson
    }
  } catch {
    return @{ Success = $false; Error = "PARSE_FAILURE: $_" }
  }

  if ($null -eq $pages -or (-not ($pages -is [System.Array] -or $pages -is [System.Collections.IList]))) {
    return @{ Success = $false; Error = "ROOT_NOT_ARRAY" }
  }

  $releases = [System.Collections.Generic.List[object]]::new()
  $pageIndex = 0
  foreach ($page in $pages) {
    $pageIndex++
    if ($null -eq $page) {
      continue
    }
    if (-not ($page -is [System.Array] -or $page -is [System.Collections.IList])) {
      return @{ Success = $false; Error = "PAGE_NOT_ARRAY: page $pageIndex" }
    }
    foreach ($item in $page) {
      if ($null -ne $item) {
        $releases.Add($item)
      }
    }
  }

  $pageCount = $pages.Count
  $recordCount = $releases.Count

  $matchingReleases = @($releases | Where-Object {
    $_.tag_name -eq $canonicalTag -or
    $_.tag_name -eq $normalizedVersion -or
    $_.name -eq $canonicalTag -or
    $_.name -eq $normalizedVersion
  })

  if ($matchingReleases.Count -gt 0) {
    return @{
      Success = $false
      Error = "COLLISION_DETECTED: count=$($matchingReleases.Count)"
      PageCount = $pageCount
      RecordCount = $recordCount
      CollisionCount = $matchingReleases.Count
    }
  }

  return @{
    Success = $true
    PageCount = $pageCount
    RecordCount = $recordCount
    CollisionCount = 0
  }
}

# Run all 9 cases
$fixtures = @(
  @{ Name = "CASE A - ZERO RELEASES"; Input = "[[]]"; ExpectPass = $true; ExpPages = 1; ExpRecords = 0 },
  @{ Name = "CASE B - ONE PAGE NON-TARGET"; Input = "[[{`"tag_name`":`"v9.9.9`",`"name`":`"AgentForge v9.9.9`"}]]"; ExpectPass = $true; ExpPages = 1; ExpRecords = 1 },
  @{ Name = "CASE C - CANONICAL COLLISION"; Input = "[[{`"tag_name`":`"v0.1.0`",`"name`":`"Release`"}]]"; ExpectPass = $false },
  @{ Name = "CASE D - UNPREFIXED COLLISION"; Input = "[[{`"tag_name`":`"0.1.0`",`"name`":`"Release`"}]]"; ExpectPass = $false },
  @{ Name = "CASE E - MULTIPLE PAGES NO COLLISION"; Input = "[[{`"tag_name`":`"v1.0.0`"},{`"tag_name`":`"v2.0.0`"}],[{`"tag_name`":`"v3.0.0`"}]]"; ExpectPass = $true; ExpPages = 2; ExpRecords = 3 },
  @{ Name = "CASE F - COLLISION ON PAGE 2"; Input = "[[{`"tag_name`":`"v1.0.0`"}],[{`"tag_name`":`"v0.1.0`"}]]"; ExpectPass = $false },
  @{ Name = "CASE G - MALFORMED JSON"; Input = "{ invalid json"; ExpectPass = $false },
  @{ Name = "CASE H - WRONG ROOT SHAPE"; Input = "{}"; ExpectPass = $false },
  @{ Name = "CASE I - WRONG PAGE SHAPE"; Input = "[{`"tag_name`":`"v9.9.9`"}]"; ExpectPass = $false }
)

$passed = 0
$total = $fixtures.Count
foreach ($f in $fixtures) {
  $res = Test-ReleaseCollisionJson -rawJson $f.Input
  $ok = ($res.Success -eq $f.ExpectPass)
  if ($f.ContainsKey("ExpPages")) {
    $ok = $ok -and ($res.PageCount -eq $f.ExpPages)
  }
  if ($f.ContainsKey("ExpRecords")) {
    $ok = $ok -and ($res.RecordCount -eq $f.ExpRecords)
  }

  if ($ok) {
    Write-Host "PASS: $($f.Name)"
    $passed++
  } else {
    Write-Host "FAIL: $($f.Name) -> $($res | ConvertTo-Json -Compress)"
  }
}

Write-Host "COLLISION_FIXTURE_TEST_COUNT: $total"
Write-Host "COLLISION_FIXTURE_TEST_PASS_COUNT: $passed"
if ($passed -ne $total) {
  exit 1
}
