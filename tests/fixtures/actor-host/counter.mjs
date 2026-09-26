// Generic application input for the unadmitted Takoserver Host class profile.
// No native imports, base class, native state, or application-name special case.
export class Counter {
  constructor(context, env) {
    this.context = context;
    this.env = env;
  }
  async start() {
    await this.context.storage.execute(
      "CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)",
    );
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/increment" && request.method === "POST") {
      const result = await this.context.storage.execute(
        "INSERT INTO counter VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET value = value + 1 RETURNING value",
      );
      return Response.json({
        id: this.context.id,
        value: result.rows[0].value,
        version: this.env.VERSION,
      });
    }
    if (path === "/value" && request.method === "GET") {
      const result = await this.context.storage.query("SELECT value FROM counter WHERE id = 1");
      return Response.json({
        id: this.context.id,
        value: result.rows[0]?.value ?? 0,
        version: this.env.VERSION,
      });
    }
    return new Response(null, { status: 404 });
  }
  async alarm() {}
  async socketMessage() {}
  async socketClose() {}
  async socketError() {}
}
