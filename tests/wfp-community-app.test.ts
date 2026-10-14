import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from "miniflare";

test("community fixture keeps SQL posts, KV feed cache, R2 attachments and idempotent scheduled summaries", async () => {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      log: new Log(LogLevel.ERROR),
      workers: [
        {
          name: "community",
          modules: true,
          compatibilityDate: "2026-08-18",
          script: readFileSync(
            new URL("./fixtures/wfp-community-app/worker.mjs", import.meta.url),
            "utf8",
          ),
          d1Databases: { DB: "community-db" },
          r2Buckets: { MEDIA: "community-media" },
          kvNamespaces: { CACHE: "community-cache" },
        },
      ],
    }),
  );
  const request = (path: string, options?: Parameters<Miniflare["dispatchFetch"]>[1]) =>
    runtime.dispatchFetch(`https://community.example.test${path}`, options);
  const post = (path: string, value: unknown) =>
    request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  try {
    expect((await request("/health")).status).toBe(200);
    expect((await request("/api/setup", { method: "POST" })).status).toBe(200);
    const member = (await (await post("/api/members", { name: "Fixture member" })).json()) as {
      id: string;
    };
    const room = (await (await post("/api/rooms", { name: "Fixture room" })).json()) as {
      id: string;
    };
    for (let i = 0; i < 20; i++)
      expect(
        (
          await post("/api/posts", {
            roomId: room.id,
            memberId: member.id,
            body: `Community post ${i}`,
          })
        ).status,
      ).toBe(201);
    const feed = (await (await request(`/api/rooms/${room.id}/feed`)).json()) as {
      cache: string;
      posts: unknown[];
    };
    expect(feed.cache).toBe("miss");
    expect(feed.posts).toHaveLength(20);
    expect(await (await request(`/api/rooms/${room.id}/feed`)).json()).toMatchObject({
      cache: "hit",
    });
    const bytes = "fixture attachment";
    const upload = await request("/api/attachments", {
      method: "POST",
      headers: {
        "x-member-id": member.id,
        "content-type": "text/plain",
        "content-length": String(bytes.length),
      },
      body: bytes,
    });
    expect(upload.status).toBe(201);
    const attachment = (await upload.json()) as { id: string };
    expect(await (await request(`/api/attachments/${attachment.id}`)).text()).toBe(bytes);
    const worker = await runtime.getWorker("community");
    const scheduledTime = Math.floor(Date.now() / 60_000) * 60_000;
    await worker.scheduled({ scheduledTime: new Date(scheduledTime), cron: "* * * * *" });
    await worker.scheduled({ scheduledTime: new Date(scheduledTime), cron: "* * * * *" });
    const status = (await (await request("/api/status")).json()) as {
      scheduled: unknown[];
      lastScheduledCache: string;
    };
    expect(status).toMatchObject({ counts: { members: 1, rooms: 1, posts: 20, attachments: 1 } });
    expect(status.scheduled).toHaveLength(1);
    expect(JSON.parse(status.lastScheduledCache)).toMatchObject({ scheduledTime, posts: 20 });
    expect(await (await request("/api/summary")).json()).toMatchObject({
      scheduledTime,
      posts: 20,
    });
    expect((await request(`/api/attachments/${attachment.id}`, { method: "DELETE" })).status).toBe(
      204,
    );
    expect((await request(`/api/attachments/${attachment.id}`)).status).toBe(404);
    expect(
      (await post("/api/posts", { roomId: room.id, memberId: member.id, body: "" })).status,
    ).toBe(400);
  } finally {
    await runtime.dispose();
  }
});
