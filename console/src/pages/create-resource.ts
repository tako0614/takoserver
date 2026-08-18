import type { FormRef, Offering } from "../api.ts";
import { type Child, h } from "../dom.ts";
import { signal } from "../reactive.ts";
import { navigate, resourcePath } from "../router.ts";
import { api } from "../state.ts";
import { explain, money, openModal, toast } from "../ui.ts";

/**
 * Declaring a resource from the console.
 *
 * The choices come from the catalog, so the console cannot offer a Form the
 * Host would refuse: what is listed is exactly what this organization may
 * provision, at the price it will be charged. The alternative — a hard-coded
 * list of kinds — drifts the day a Form ships, and drifts silently.
 *
 * The spec is left as JSON. A generated form per schema is the obvious next
 * step and a poor first one: it would have to be right about every Form, and
 * being wrong about one means a field nobody can fill. Text is honest until
 * the schemas are worth rendering.
 */
export function createResource(organizationId: string, offerings: readonly Offering[]): void {
  if (offerings.length === 0) {
    toast("This organization has nothing it may provision", "bad");
    return;
  }

  const chosen = signal<Offering>(offerings[0] as Offering);
  const name = h("input", { class: "input", placeholder: "media", autocomplete: "off" });
  const space = h("input", { class: "input", value: "default", autocomplete: "off" });
  const spec = h("textarea", { class: "textarea", spellcheck: "false" });
  spec.value = "{}";

  const price = h("div", { class: "dim", style: { fontSize: "12.5px" } });
  const showPrice = (offering: Offering): void => {
    price.replaceChildren(
      document.createTextNode(
        `${money(offering.price.unitPriceMinor, offering.price.currency)} per ${offering.price.unit} — held when you apply, charged when it succeeds.`,
      ),
    );
  };
  showPrice(chosen());

  const kind = h(
    "select",
    {
      class: "select",
      onChange: (event: Event) => {
        const picked = offerings.find(
          (offering) => offering.id === (event.target as HTMLSelectElement).value,
        );
        if (picked) {
          chosen.set(picked);
          showPrice(picked);
        }
      },
    },
    ...offerings.map((offering) =>
      h("option", { value: offering.id }, `${offering.displayName} — ${offering.form.kind}`),
    ),
  );

  const close = openModal({
    title: "New resource",
    confirmLabel: "Apply",
    body: h(
      "div",
      { style: { display: "grid", gap: "14px" } },
      h("div", { class: "field" }, h("label", null, "Offering"), kind, price),
      h(
        "div",
        { class: "field" },
        h("label", null, "Name"),
        name,
        h("small", null, "Unique within its space. It cannot be changed afterwards."),
      ),
      h(
        "div",
        { class: "field" },
        h("label", null, "Space"),
        space,
        h("small", null, "A namespace of your choosing. `default` is a fine answer."),
      ),
      h(
        "div",
        { class: "field" },
        h("label", null, "Spec"),
        spec,
        h(
          "small",
          null,
          "JSON, validated against the Form's schema. An empty object is valid for most kinds.",
        ),
      ),
    ),
    onConfirm: async () => {
      const declaredName = name.value.trim();
      const declaredSpace = space.value.trim();
      if (declaredName === "" || declaredSpace === "") {
        toast("A name and a space are required", "bad");
        return;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(spec.value) as Record<string, unknown>;
      } catch {
        // Said here rather than by the server, because the server would be
        // right and unhelpful: it never saw what was typed.
        toast("The spec is not valid JSON", "bad");
        return;
      }
      try {
        const created = await api.createResource(organizationId, {
          form: chosen().form,
          space: declaredSpace,
          name: declaredName,
          spec: parsed,
        });
        toast(`${created.kind} ${created.metadata.name} is ready`, "ok");
        close();
        navigate(resourcePath(declaredSpace, created.kind, declaredName));
      } catch (error) {
        toast(explain(error as Error), "bad");
      }
    },
  });
}

/**
 * Deleting one.
 *
 * Fenced on the generation the console last read, so a resource somebody else
 * changed in the meantime is refused rather than removed on stale information.
 */
export function deleteResource(
  organizationId: string,
  declaration: {
    readonly form: FormRef;
    readonly space: string;
    readonly name: string;
    readonly generation: string;
  },
  done: () => void,
): void {
  const close = openModal({
    title: `Delete ${declaration.name}?`,
    confirmLabel: "Delete resource",
    confirmTone: "danger",
    body: h(
      "div",
      { class: "notice notice--bad" },
      h(
        "div",
        null,
        "The backend resource is destroyed, along with anything stored in it. Nothing here can bring it back.",
      ),
    ),
    onConfirm: async () => {
      try {
        await api.deleteResource(
          organizationId,
          { form: declaration.form, space: declaration.space, name: declaration.name },
          declaration.generation,
        );
        toast(`${declaration.name} deleted`, "ok");
        close();
        done();
      } catch (error) {
        toast(explain(error as Error), "bad");
      }
    },
  });
}
