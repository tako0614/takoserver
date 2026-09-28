/** Separate the HTTP response budget from its bounded invocation lifetime. */
export async function awaitInlineExecution(
  work: Promise<unknown>,
  budgetMilliseconds: number | undefined,
  retain: ((work: Promise<void>) => void) | undefined,
  onBackgroundFailure: (error: unknown) => void,
): Promise<boolean> {
  if (budgetMilliseconds === undefined) {
    await work;
    return true;
  }
  const tracked = work.then(
    () => ({ kind: "settled" as const }),
    (error: unknown) => ({ kind: "failed" as const, error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), budgetMilliseconds);
  });
  const outcome = await Promise.race([tracked, expired]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome === "timeout") {
    // The caller supplies an invocation-lifetime owner in Workers. Retaining
    // the promise is deliberately a separate concern from the HTTP budget.
    const completion = tracked.then((result) => {
      if (result.kind === "failed") onBackgroundFailure(result.error);
    });
    if (retain) retain(completion);
    else void completion;
    return false;
  }
  if (outcome.kind === "failed") throw outcome.error;
  return true;
}
