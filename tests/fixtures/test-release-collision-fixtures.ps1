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
      return @{ Success = $false; Error = "NULL_PAGE: page $pageIndex" }
    }
    if (-not ($page -is [System.Array] -or $page -is [System.Collections.IList])) {
      return @{ Success = $false; Error = "PAGE_NOT_ARRAY: page $pageIndex" }
    }
    $itemIndex = 0
    foreach ($item in $page) {
      $itemIndex++
      if ($null -eq $item) {
        return @{ Success = $false; Error = "NULL_RECORD: page $pageIndex item $itemIndex" }
      }
      if (-not ($item -is [System.Management.Automation.PSCustomObject] -or $item -is [System.Collections.IDictionary])) {
        return @{ Success = $false; Error = "NON_OBJECT_RECORD: page $pageIndex item $itemIndex" }
      }

      $tagName = $null
      if ($item -is [System.Management.Automation.PSCustomObject]) {
        if (-not ($item.PSObject.Properties.Match('tag_name').Count -gt 0)) {
          return @{ Success = $false; Error = "MISSING_TAG_NAME: page $pageIndex item $itemIndex" }
        }
        $tagName = $item.tag_name
      } else {
        if (-not $item.Contains('tag_name')) {
          return @{ Success = $false; Error = "MISSING_TAG_NAME: page $pageIndex item $itemIndex" }
        }
        $tagName = $item['tag_name']
      }

      if ($null -eq $tagName -or (-not ($tagName -is [string])) -or [string]::IsNullOrWhiteSpace($tagName)) {
        return @{ Success = $false; Error = "EMPTY_TAG_NAME: page $pageIndex item $itemIndex" }
      }

      $nameVal = $null
      if ($item -is [System.Management.Automation.PSCustomObject]) {
        if ($item.PSObject.Properties.Match('name').Count -gt 0) {
          $nameVal = $item.name
        }
      } else {
        if ($item.Contains('name')) {
          $nameVal = $item['name']
        }
      }
      if ($null -ne $nameVal -and (-not ($nameVal -is [string]))) {
        return @{ Success = $false; Error = "INVALID_NAME_TYPE: page $pageIndex item $itemIndex" }
      }

      $releases.Add($item)
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

# Run all 15 cases
$fixtures = @(
  @{ Name = "CASE A - ZERO RELEASES"; Input = "[[]]"; ExpectPass = $true; ExpPages = 1; ExpRecords = 0 },
  @{ Name = "CASE B - ONE PAGE NON-TARGET"; Input = "[[{`"tag_name`":`"v9.9.9`",`"name`":`"AgentForge v9.9.9`"}]]"; ExpectPass = $true; ExpPages = 1; ExpRecords = 1 },
  @{ Name = "CASE C - CANONICAL COLLISION"; Input = "[[{`"tag_name`":`"v0.1.0`",`"name`":`"Release`"}]]"; ExpectPass = $false },
  @{ Name = "CASE D - UNPREFIXED COLLISION"; Input = "[[{`"tag_name`":`"0.1.0`",`"name`":`"Release`"}]]"; ExpectPass = $false },
  @{ Name = "CASE E - MULTIPLE PAGES NO COLLISION"; Input = "[[{`"tag_name`":`"v1.0.0`"},{`"tag_name`":`"v2.0.0`"}],[{`"tag_name`":`"v3.0.0`"}]]"; ExpectPass = $true; ExpPages = 2; ExpRecords = 3 },
  @{ Name = "CASE F - COLLISION ON PAGE 2"; Input = "[[{`"tag_name`":`"v1.0.0`"}],[{`"tag_name`":`"v0.1.0`"}]]"; ExpectPass = $false },
  @{ Name = "CASE G - MALFORMED JSON"; Input = "{ invalid json"; ExpectPass = $false },
  @{ Name = "CASE H - WRONG ROOT SHAPE"; Input = "{}"; ExpectPass = $false },
  @{ Name = "CASE I - WRONG PAGE SHAPE"; Input = "[{`"tag_name`":`"v9.9.9`"}]"; ExpectPass = $false },
  @{ Name = "CASE J - NULL PAGE"; Input = "[null]"; ExpectPass = $false },
  @{ Name = "CASE K - NULL RELEASE RECORD"; Input = "[[null]]"; ExpectPass = $false },
  @{ Name = "CASE L - SCALAR RELEASE RECORD"; Input = "[[123]]"; ExpectPass = $false },
  @{ Name = "CASE M - RECORD MISSING TAG_NAME"; Input = "[[{`"name`":`"Some release`"}]]"; ExpectPass = $false },
  @{ Name = "CASE N - EMPTY TAG_NAME"; Input = "[[{`"tag_name`":`"  `",`"name`":`"Some release`"}]]"; ExpectPass = $false },
  @{ Name = "CASE O - NULL NAME IS VALID"; Input = "[[{`"tag_name`":`"v9.9.9`",`"name`":null}]]"; ExpectPass = $true; ExpPages = 1; ExpRecords = 1 }
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
