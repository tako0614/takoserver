const encoder = new TextEncoder();
const decoder = new TextDecoder();
const counts = { members: 100, rooms: 20, posts: 1000, attachments: 20 };

function requireRun(env) {
  if (typeof env.E2E_RUN_ID !== "string") throw new Error("missing fixture run");
  return env.E2E_RUN_ID;
}

async function query(env, sql, params = []) {
  return (await env.DB.query(sql, params)).rows;
}

async function transactions(env, statements) {
  for (let offset = 0; offset < statements.length; offset += 50) {
    await env.DB.transaction(statements.slice(offset, offset + 50));
  }
}

async function put(bucket, key, value) {
  const bytes = encoder.encode(value);
  return await bucket.put(key, bytes.buffer, {
    contentLength: bytes.byteLength,
    contentType: "text/plain",
  });
}

async function objectText(bucket, key, options) {
  const object = await bucket.get(key, options);
  return object === null ? null : await new Response(object.body).text();
}

async function kvText(kv, key) {
  const value = await kv.get(key);
  return value === null ? null : decoder.decode(value);
}

async function seed(env) {
  const id = requireRun(env);
  const statements = [];
  for (let index = 0; index < counts.members; index++) {
    statements.push({
      sql: "INSERT INTO members VALUES (?, ?)",
      params: [index, `Member ${index}`],
    });
  }
  for (let index = 0; index < counts.rooms; index++) {
    statements.push({ sql: "INSERT INTO rooms VALUES (?, ?)", params: [index, `Room ${index}`] });
  }
  for (let index = 0; index < counts.posts; index++) {
    statements.push({
      sql: "INSERT INTO posts VALUES (?, ?, ?, ?)",
      params: [index, index % counts.rooms, index % counts.members, `Post ${index}`],
    });
  }
  await transactions(env, statements);
  for (let index = 0; index < counts.attachments; index++) {
    const key = `runs/${id}/attachments/${index}.txt`;
    await put(env.BUCKET, key, `Attachment ${index}`);
    await env.DB.execute("INSERT INTO attachments VALUES (?, ?)", [index, key]);
  }
  return await evidence(env);
}

async function feed(env) {
  const key = `runs:${requireRun(env)}:feed`;
  const cached = await kvText(env.KV, key);
  if (cached !== null) return { cache: "hit", posts: JSON.parse(cached) };
  const posts = await query(env, "SELECT id, body FROM posts WHERE room_id = ? ORDER BY id", [0]);
  await env.KV.put(key, JSON.stringify(posts), { expirationTtlSeconds: 300 });
  return { cache: "miss", posts };
}

async function exercise(env) {
  const id = requireRun(env);
  const key = `runs/${id}/probe.txt`;
  const kvKey = `runs:${id}:probe`;
  await env.DB.execute("INSERT INTO probes VALUES (?, ?)", ["crud", "before"]);
  await env.DB.execute("UPDATE probes SET value = ? WHERE id = ?", ["after", "crud"]);
  const updated = (await query(env, "SELECT value FROM probes WHERE id = ?", ["crud"]))[0]?.value;
  await env.DB.execute("DELETE FROM probes WHERE id = ?", ["crud"]);
  let transactionRefused = false;
  try {
    await env.DB.transaction([
      { sql: "INSERT INTO probes VALUES (?, ?)", params: ["rollback", "must disappear"] },
      { sql: "INSERT INTO missing_fixture_table VALUES (?)", params: [1] },
    ]);
  } catch {
    transactionRefused = true;
  }
  const remaining = (await query(env, "SELECT COUNT(*) AS count FROM probes"))[0]?.count;
  await env.KV.put(kvKey, "portable-kv", { metadata: { fixture: id }, expirationTtlSeconds: 60 });
  const metadata = await env.KV.getWithMetadata(kvKey);
  const kvPage = await env.KV.list({ prefix: kvKey, limit: 1 });
  await env.KV.delete(kvKey);
  const kvDeleted = (await env.KV.get(kvKey)) === null;
  const stored = await put(env.BUCKET, key, "portable-object");
  const head = await env.BUCKET.head(key);
  const range = await objectText(env.BUCKET, key, { range: { offset: 0, length: 8 } });
  const conditional = await objectText(env.BUCKET, key, { ifMatch: stored.etag });
  const objectPage = await env.BUCKET.list({ prefix: key, limit: 1 });
  const multipartKey = `runs/${id}/multipart.txt`;
  const upload = await env.BUCKET.createMultipartUpload(multipartKey, {
    contentType: "text/plain",
  });
  const partBytes = encoder.encode("multipart-object");
  const part = await env.BUCKET.uploadPart(multipartKey, upload.uploadId, 1, partBytes.buffer, {
    contentLength: partBytes.byteLength,
  });
  await env.BUCKET.completeMultipartUpload(multipartKey, upload.uploadId, [
    { partNumber: 1, etag: part.etag },
  ]);
  const multipart = await objectText(env.BUCKET, multipartKey);
  const aborted = await env.BUCKET.createMultipartUpload(`${multipartKey}.abort`);
  await env.BUCKET.abortMultipartUpload(`${multipartKey}.abort`, aborted.uploadId);
  await env.BUCKET.delete(key);
  await env.BUCKET.delete(multipartKey);
  const objectDeleted =
    (await env.BUCKET.get(key)) === null && (await env.BUCKET.head(key)) === null;
  return {
    sqlite: { updated, remaining, transactionRefused },
    kv: {
      value: metadata === null ? null : decoder.decode(metadata.value),
      metadata: metadata?.metadata,
      listed: kvPage.keys.some((entry) => entry.name === kvKey),
      deleted: kvDeleted,
    },
    object: {
      size: head?.size,
      range,
      conditional,
      multipart,
      listed: objectPage.objects.some((entry) => entry.key === key),
      deleted: objectDeleted,
    },
  };
}

async function evidence(env) {
  const id = requireRun(env);
  const actual = {};
  for (const table of Object.keys(counts)) {
    actual[table] = Number((await query(env, `SELECT COUNT(*) AS count FROM ${table}`))[0]?.count);
  }
  const rows = await query(
    env,
    "SELECT slot, value FROM scheduled_receipts WHERE run_id = ? ORDER BY slot",
    [id],
  );
  const scheduled = [];
  for (const row of rows) {
    scheduled.push({
      slot: row.slot,
      sql: row.value,
      kv: await kvText(env.KV, `runs:${id}:scheduled:${row.slot}`),
      object: await objectText(env.BUCKET, `runs/${id}/scheduled/${row.slot}.json`),
    });
  }
  const attachments = [];
  for (let index = 0; index < counts.attachments; index++) {
    attachments.push(await objectText(env.BUCKET, `runs/${id}/attachments/${index}.txt`));
  }
  return { runId: id, revision: env.E2E_REVISION, counts: actual, attachments, scheduled };
}

async function clearData(env) {
  const prefix = `runs/${requireRun(env)}/`;
  while (true) {
    const page = await env.BUCKET.list({ prefix, limit: 100 });
    for (const object of page.objects) await env.BUCKET.delete(object.key);
    if (!page.truncated) break;
  }
  while (true) {
    const page = await env.KV.list({ prefix: `runs:${requireRun(env)}:`, limit: 100 });
    for (const key of page.keys) await env.KV.delete(key.name);
    if (page.listComplete) break;
  }
  return { cleared: true };
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.headers.get("x-takoserver-e2e-run") !== requireRun(env)) {
      return Response.json({ error: "wrong_run" }, { status: 403 });
    }
    if (request.method === "GET" && path === "/health") {
      return Response.json({ runId: requireRun(env), revision: env.E2E_REVISION });
    }
    if (request.method === "POST" && path === "/e2e/seed") return Response.json(await seed(env));
    if (request.method === "POST" && path === "/e2e/exercise")
      return Response.json(await exercise(env));
    if (request.method === "GET" && path === "/e2e/feed") return Response.json(await feed(env));
    if (request.method === "GET" && path === "/e2e/evidence")
      return Response.json(await evidence(env));
    if (request.method === "GET" && path === "/e2e/service") {
      return await env.SERVICE.fetch(
        new Request("https://sample.invalid/service", {
          headers: { "x-takoserver-e2e-run": requireRun(env) },
        }),
      );
    }
    if (request.method === "POST" && path === "/e2e/clear")
      return Response.json(await clearData(env));
    return Response.json({ error: "not_found" }, { status: 404 });
  },
  async scheduled(controller, env) {
    const slot = controller.scheduledTime;
    if (!Number.isSafeInteger(slot) || controller.cron !== "* * * * *")
      throw new Error("invalid schedule");
    const id = requireRun(env);
    const proposed = JSON.stringify({
      runId: id,
      slot,
      posts: Number((await query(env, "SELECT COUNT(*) AS count FROM posts"))[0]?.count),
      invokedAt: Date.now(),
    });
    await env.DB.execute("INSERT OR IGNORE INTO scheduled_receipts VALUES (?, ?, ?)", [
      id,
      slot,
      proposed,
    ]);
    const value = (
      await query(env, "SELECT value FROM scheduled_receipts WHERE run_id = ? AND slot = ?", [
        id,
        slot,
      ])
    )[0]?.value;
    if (typeof value !== "string") throw new Error("scheduled receipt unavailable");
    await env.KV.put(`runs:${id}:scheduled:${slot}`, value);
    await put(env.BUCKET, `runs/${id}/scheduled/${slot}.json`, value);
  },
};
