/** A real Host response may arrive after many turns of an idle event loop. */
export async function waitForConsole(label: string, ready: () => boolean): Promise<void> {
  const deadline = performance.now() + 3_000;
  while (!ready()) {
    if (performance.now() >= deadline) throw new Error(`local Console did not reach ${label}`);
    await Bun.sleep(10);
  }
}
