const MAX_ATTACHMENT_BYTES = 256 * 1024;
const schema = [
  "CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, name TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), member_id TEXT NOT NULL REFERENCES members(id), body TEXT NOT NULL, created_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS posts_by_room ON posts(room_id, created_at, id)",
  "CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), media_type TEXT NOT NULL, bytes INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS scheduled_receipts (scheduled_time INTEGER NOT NULL, cron TEXT NOT NULL, post_count INTEGER NOT NULL, PRIMARY KEY (scheduled_time, cron))",
];

function text(value, maximum) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum)
    throw new TypeError("invalid text");
  return value;
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

async function fetchApp(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "GET" && path === "/health")
    return json({ app: "wfp-community", version: env.APP_VERSION ?? "1" });
  if (request.method === "POST" && path === "/api/setup") {
    await env.DB.batch(schema.map((statement) => env.DB.prepare(statement)));
    return json({ ready: true });
  }
  if (request.method === "POST" && (path === "/api/members" || path === "/api/rooms")) {
    const value = await request.json();
    const name = text(value.name, 80);
    const id = crypto.randomUUID();
    const statement =
      path === "/api/members"
        ? "INSERT INTO members (id, name) VALUES (?, ?)"
        : "INSERT INTO rooms (id, name) VALUES (?, ?)";
    await env.DB.prepare(statement).bind(id, name).run();
    return json({ id, name }, 201);
  }
  if (request.method === "GET" && path === "/api/rooms") {
    const result = await env.DB.prepare(
      "SELECT id, name FROM rooms ORDER BY name, id LIMIT 100",
    ).all();
    return json({ rooms: result.results });
  }
  if (request.method === "POST" && path === "/api/posts") {
    const value = await request.json();
    const roomId = text(value.roomId, 128);
    const memberId = text(value.memberId, 128);
    const body = text(value.body, 4_000);
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO posts (id, room_id, member_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(id, roomId, memberId, body, Date.now())
      .run();
    await env.CACHE.delete(`feed:${roomId}`);
    return json({ id, roomId, memberId, body }, 201);
  }
  const feed = /^\/api\/rooms\/([a-z0-9-]+)\/feed$/u.exec(path);
  if (request.method === "GET" && feed) {
    const key = `feed:${feed[1]}`;
    const cached = await env.CACHE.get(key);
    if (cached !== null) return json({ ...JSON.parse(cached), cache: "hit" });
    const result = await env.DB.prepare(
      "SELECT p.id, p.body, p.created_at, m.name AS member_name FROM posts p JOIN members m ON m.id = p.member_id WHERE p.room_id = ? ORDER BY p.created_at DESC, p.id DESC LIMIT 100",
    )
      .bind(feed[1])
      .all();
    const value = { posts: result.results };
    await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: 60 });
    return json({ ...value, cache: "miss" });
  }
  if (request.method === "POST" && path === "/api/attachments") {
    const memberId = text(request.headers.get("x-member-id"), 128);
    const declared = Number(request.headers.get("content-length"));
    if (!Number.isSafeInteger(declared) || declared < 1 || declared > MAX_ATTACHMENT_BYTES)
      return json({ error: "attachment_too_large_or_missing_length" }, 413);
    const member = await env.DB.prepare("SELECT id FROM members WHERE id = ?")
      .bind(memberId)
      .first();
    if (!member) return json({ error: "member_not_found" }, 404);
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength !== declared) return json({ error: "invalid_attachment_length" }, 400);
    const id = crypto.randomUUID();
    const mediaType = text(request.headers.get("content-type") ?? "application/octet-stream", 128);
    await env.MEDIA.put(`attachments/${id}`, bytes, { httpMetadata: { contentType: mediaType } });
    await env.DB.prepare(
      "INSERT INTO attachments (id, member_id, media_type, bytes) VALUES (?, ?, ?, ?)",
    )
      .bind(id, memberId, mediaType, bytes.byteLength)
      .run();
    return json({ id, bytes: bytes.byteLength }, 201);
  }
  const attachment = /^\/api\/attachments\/([a-z0-9-]+)$/u.exec(path);
  if (attachment && request.method === "GET") {
    const record = await env.DB.prepare("SELECT media_type FROM attachments WHERE id = ?")
      .bind(attachment[1])
      .first();
    if (!record) return json({ error: "attachment_not_found" }, 404);
    const object = await env.MEDIA.get(`attachments/${attachment[1]}`);
    if (!object) return json({ error: "attachment_object_not_found" }, 404);
    return new Response(object.body, {
      headers: { "content-type": record.media_type, "cache-control": "no-store" },
    });
  }
  if (attachment && request.method === "DELETE") {
    await env.MEDIA.delete(`attachments/${attachment[1]}`);
    await env.DB.prepare("DELETE FROM attachments WHERE id = ?").bind(attachment[1]).run();
    return new Response(null, { status: 204 });
  }
  if (request.method === "GET" && path === "/api/status") {
    const counts = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM members) AS members, (SELECT COUNT(*) FROM rooms) AS rooms, (SELECT COUNT(*) FROM posts) AS posts, (SELECT COUNT(*) FROM attachments) AS attachments",
    ).first();
    const result = await env.DB.prepare(
      "SELECT scheduled_time, cron, post_count FROM scheduled_receipts ORDER BY scheduled_time DESC LIMIT 10",
    ).all();
    return json({
      counts,
      scheduled: result.results,
      lastScheduledCache: await env.CACHE.get("last-scheduled"),
    });
  }
  if (request.method === "GET" && path === "/api/summary") {
    const result = await env.DB.prepare(
      "SELECT scheduled_time FROM scheduled_receipts ORDER BY scheduled_time DESC LIMIT 1",
    ).first();
    if (!result) return json({ error: "no_scheduled_receipt" }, 404);
    const object = await env.MEDIA.get(`summaries/${result.scheduled_time}.json`);
    if (!object) return json({ error: "summary_not_found" }, 404);
    return new Response(object.body, {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return await fetchApp(request, env);
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
  },
  async scheduled(event, env) {
    const counts = await env.DB.prepare("SELECT COUNT(*) AS posts FROM posts").first();
    await env.DB.prepare(
      "INSERT INTO scheduled_receipts (scheduled_time, cron, post_count) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    )
      .bind(event.scheduledTime, event.cron, counts.posts)
      .run();
    const summary = JSON.stringify({
      scheduledTime: event.scheduledTime,
      cron: event.cron,
      posts: counts.posts,
    });
    await env.CACHE.put("last-scheduled", summary);
    await env.MEDIA.put(`summaries/${event.scheduledTime}.json`, summary, {
      httpMetadata: { contentType: "application/json" },
    });
  },
};
