import type { TakoformResourceDriver } from "../../src/takoform/types.ts";

export async function applyWithSelection(
  driver: TakoformResourceDriver,
  input: Omit<Parameters<TakoformResourceDriver["apply"]>[0], "selection">,
): Promise<Awaited<ReturnType<TakoformResourceDriver["apply"]>>> {
  const selection = await driver.selectApply(input);
  return await driver.apply({ ...input, selection });
}
