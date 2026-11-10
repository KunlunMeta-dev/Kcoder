import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat, writeFile } from "node:fs/promises";
const digest = (data) => createHash("sha256").update(data).digest("hex");
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
export function artifactTransferPlan({ owner, root, leaf, sha256, bytes }) {
  assert.match(owner, /^[a-f0-9-]{36}$/);
  assert.match(root, /^[A-Za-z]:\\/);
  assert.ok(!/[\r\n\0]/.test(root));
  assert.ok(!root.split(/[\\/]/).includes(".."));
  assert.match(leaf, /^[A-Za-z0-9_.-]+$/);
  assert.match(sha256, /^[a-f0-9]{64}$/);
  assert.ok(
    Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 1024 * 1024 * 1024,
  );
  return { owner, root, leaf, sha256, bytes, chunkBytes: 1024 * 1024 };
}
/** Each data block uses the caller's existing SCP transport; authority and metadata stay separate. */
export async function transferWindowsArtifact({
  context,
  ps,
  uploadPart,
  local,
  owner,
  root,
  leaf,
  sha256,
}) {
  const info = await stat(local);
  const hash = createHash("sha256");
  for await (const data of createReadStream(local)) hash.update(data);
  const observed = hash.digest("hex");
  if (sha256 !== undefined) assert.equal(observed, sha256);
  else sha256 = observed;
  const plan = artifactTransferPlan({
    owner,
    root,
    leaf,
    sha256,
    bytes: info.size,
  });
  const prefix = `$r=${literal(root)};$m=Get-Content -LiteralPath (Join-Path $r '.owner.json') -Raw|ConvertFrom-Json;if($m.owner -cne '${owner}'){throw 'Artifact owner changed'};$dst=Join-Path $r '${leaf}';$parts=Join-Path $r '.parts-${sha256}';`;
  const inspect = JSON.parse(
    (
      await ps(
        prefix +
          `if(Test-Path -LiteralPath $dst){@{present=$true;bytes=(Get-Item -LiteralPath $dst).Length;sha256=(Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash.ToLowerInvariant()}|ConvertTo-Json -Compress}else{@{present=$false}|ConvertTo-Json -Compress}`,
      )
    ).trim(),
  );
  if (
    inspect.present &&
    inspect.bytes === plan.bytes &&
    inspect.sha256 === sha256
  )
    return {
      verified: true,
      reused: true,
      bytes: plan.bytes,
      sha256,
      chunks: 0,
    };
  assert.equal(
    typeof uploadPart,
    "function",
    "A separately owned SCP data transport is required",
  );
  await ps(
    prefix +
      `if(Test-Path -LiteralPath $dst){Move-Item -LiteralPath $dst -Destination ($dst+'.incomplete-'+[Guid]::NewGuid().ToString())};[IO.Directory]::CreateDirectory($parts)|Out-Null`,
  );
  const file = await open(local, "r"),
    chunks = [];
  try {
    for (
      let offset = 0, index = 0;
      offset < plan.bytes;
      offset += plan.chunkBytes, index++
    ) {
      const data = Buffer.alloc(Math.min(plan.chunkBytes, plan.bytes - offset));
      assert.equal(
        (await file.read(data, 0, data.length, offset)).bytesRead,
        data.length,
      );
      const chunk = { index, bytes: data.length, sha256: digest(data) },
        part = String(index).padStart(6, "0") + ".part";
      chunks.push(chunk);
      const inspectPart = () =>
        ps(
          prefix +
            `$p=Join-Path $parts '${part}';if(Test-Path -LiteralPath $p){@{bytes=(Get-Item -LiteralPath $p).Length;sha256=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()}|ConvertTo-Json -Compress}else{@{}|ConvertTo-Json -Compress}`,
        );
      let ready = JSON.parse((await inspectPart()).trim());
      if (ready.bytes !== chunk.bytes || ready.sha256 !== chunk.sha256) {
        const path = context.pathInState("artifact-part-" + sha256 + ".bin");
        await writeFile(path, data, { mode: 0o600 });
        let failure;
        try {
          await uploadPart(path, `.parts-${sha256}/${part}`);
        } catch (error) {
          failure = error;
        }
        // A lost transfer receipt never causes a blind resend or executable dispatch.
        ready = JSON.parse((await inspectPart()).trim());
        if (ready.bytes !== chunk.bytes || ready.sha256 !== chunk.sha256) {
          if (failure) throw failure;
          throw Error("Owned artifact chunk was not confirmed");
        }
      }
      await context.writeArtifactJson(
        "artifact-transfer-" + leaf + "-part-" + index + ".json",
        {
          ...plan,
          chunks: chunks.length,
          verifiedBytes: offset + data.length,
          complete: false,
        },
      );
    }
  } finally {
    await file.close();
  }
  const header = JSON.stringify({ owner, count: chunks.length });
  const manifest =
    header +
    "\n" +
    chunks.map((chunk) => JSON.stringify(chunk)).join("\n") +
    "\n";
  const assembled = JSON.parse(
    (
      await ps(
        prefix +
          `$v=[Console]::In.ReadLine()|ConvertFrom-Json;if($v.owner -cne '${owner}' -or $v.count -gt 1024){throw 'Artifact assembly owner changed'};$tmp=$dst+'.assembling-'+[Guid]::NewGuid().ToString();$o=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{for($i=0;$i -lt $v.count;$i++){$c=[Console]::In.ReadLine()|ConvertFrom-Json;if($c.index -ne $i){throw 'Artifact chunk order changed'};$p=Join-Path $parts (([int]$c.index).ToString('000000')+'.part');if((Get-Item -LiteralPath $p).Length -ne $c.bytes -or (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() -cne $c.sha256){throw 'Artifact part changed'};$f=[IO.File]::OpenRead($p);try{$f.CopyTo($o)}finally{$f.Dispose()}};$o.Flush($true)}finally{$o.Dispose()};if((Get-Item -LiteralPath $tmp).Length -ne ${plan.bytes} -or (Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash.ToLowerInvariant() -cne '${sha256}'){throw 'Artifact whole-file identity mismatch'};Move-Item -LiteralPath $tmp -Destination $dst;@{verified=$true;bytes=${plan.bytes};sha256='${sha256}'}|ConvertTo-Json -Compress`,
        manifest,
        120000,
      )
    ).trim(),
  );
  assert.deepEqual(assembled, { verified: true, bytes: plan.bytes, sha256 });
  const receipt = {
    ...plan,
    chunks: chunks.length,
    verified: true,
    complete: true,
    reused: false,
  };
  await context.writeArtifactJson(
    "artifact-transfer-" + leaf + ".json",
    receipt,
  );
  return receipt;
}
