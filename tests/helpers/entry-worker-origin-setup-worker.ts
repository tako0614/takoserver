type FixtureD1Result = {
  readonly success?: boolean;
  readonly meta?: { readonly changes?: number };
};

type FixtureD1Statement = {
  bind(...values: readonly string[]): FixtureD1Statement;
  all(): Promise<FixtureD1Result>;
};

type FixtureD1Database = {
  prepare(source: string): FixtureD1Statement;
  batch(statements: readonly FixtureD1Statement[]): Promise<readonly FixtureD1Result[]>;
};

type MigrationSetup = {
  readonly kind: "migrations";
  readonly batches: readonly (readonly string[])[];
};

type WriterSetup = {
  readonly kind: "request-writer";
  readonly statements: readonly string[];
  readonly epoch: string;
};

function assertAcknowledged(result: FixtureD1Result | undefined): void {
  if (result?.success !== true) throw new Error("fixture D1 statement was not acknowledged");
}

export default {
  async fetch(request: Request, env: { readonly STATE_DB: FixtureD1Database }): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (request.method !== "POST" || pathname !== "/__test/entry-origin-setup")
      return new Response("fixture");

    const input = (await request.json()) as MigrationSetup | WriterSetup;
    if (input.kind === "migrations") {
      let statementCount = 0;
      for (const statements of input.batches) {
        const results = await env.STATE_DB.batch(
          statements.map((statement) => env.STATE_DB.prepare(statement)),
        );
        if (results.length !== statements.length)
          throw new Error("fixture D1 migration batch result count differs");
        for (const result of results) assertAcknowledged(result);
        statementCount += results.length;
      }
      return Response.json({ kind: input.kind, batchCount: input.batches.length, statementCount });
    }
    if (input.kind === "request-writer") {
      let statementCount = 0;
      for (const statement of input.statements) {
        assertAcknowledged(await env.STATE_DB.prepare(statement).all());
        statementCount++;
      }
      const result = await env.STATE_DB.prepare(
        "INSERT INTO money_cutover_authorized_epoch VALUES (1, ?)",
      )
        .bind(input.epoch)
        .all();
      assertAcknowledged(result);
      if (result.meta?.changes !== 1) throw new Error("fixture writer epoch insert count differs");
      return Response.json({ kind: input.kind, statementCount, epochChanges: 1 });
    }
    throw new Error("unsupported fixture setup kind");
  },
};
