import { ApiError, type ResourceSummary } from "../api.ts";
import { h } from "../dom.ts";
import {
  blankPaths,
  pathLabel,
  type ReferenceSlot,
  type StarterSpec,
  slotLabel,
  starterSpec,
  valueAt,
  withValueAt,
} from "../form-specs.ts";
import { formLabel, KNOWN_FORM_GROUPS } from "../forms.ts";
import { tr } from "../i18n.ts";
import {
  isUnknownAcceptance,
  prepareResourceIntent,
  type ResourceIntent,
  resourceIntentRequestBody,
  sendResourceIntent,
} from "../resource-intent.ts";
import { navigate } from "../router.ts";
import { api, currentOrganization } from "../state.ts";
import { copyable, explain, openModal, toast } from "../ui.ts";

function jsonSpec(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function sameOrganization(organizationId: string): boolean {
  if (currentOrganization()?.id === organizationId) return true;
  toast(
    tr(
      "組織が変更されました。操作は送信していません。",
      "Organization changed. No operation was sent.",
    ),
    "bad",
  );
  return false;
}

function recoveryDetails(
  key: string,
  method: string,
  path: string,
  body: string | null,
  generation?: number,
): HTMLElement {
  return h(
    "div",
    { class: "field" },
    h(
      "small",
      null,
      tr(
        "送信前に正確なキーと本文を確認・コピーできます。ページ再読み込み後はConsoleから再送できません。結果が不明なら読み取りで確認してください。",
        "Review or copy the exact key and body before sending. After a full reload the Console cannot replay; reconcile by reading if acceptance is unknown.",
      ),
    ),
    h("div", { class: "mono" }, `${method} ${path}`),
    generation === undefined
      ? null
      : h("div", { class: "mono" }, `takoform-expected-generation: ${generation}`),
    h("div", null, "idempotency-key: ", copyable(key)),
    body === null
      ? null
      : h(
          "div",
          null,
          tr("正確なJSON本文", "Exact JSON body"),
          " ",
          copyable(body, tr("本文をコピー", "Copy body")),
          h("pre", { class: "mono" }, body),
        ),
  );
}

/**
 * The exact request, folded away. Someone recovering an uncertain send can
 * open it and copy the key and body; nobody else has to read them first.
 */
function requestDisclosure(details: HTMLElement): HTMLElement {
  return h(
    "details",
    { class: "request-details" },
    h("summary", null, tr("送信するリクエスト", "Request to send")),
    details,
  );
}

async function submit(intent: ResourceIntent, close: () => void): Promise<void> {
  try {
    const accepted = await sendResourceIntent(intent.id);
    close();
    if (currentOrganization()?.id === intent.organizationId)
      navigate(
        `/resources?operation=${encodeURIComponent(accepted.id)}&intent=${encodeURIComponent(intent.id)}`,
      );
  } catch (error) {
    if (
      isUnknownAcceptance(error) ||
      (error instanceof ApiError && error.code === "replay_window_expired")
    ) {
      close();
      if (currentOrganization()?.id === intent.organizationId)
        navigate(`/resources?acceptance=unknown&intent=${encodeURIComponent(intent.id)}`);
      return;
    }
    toast(explain(error as Error), "bad");
  }
}

const OTHER_FORM = "other";
/** A Host that has not answered about one Form by now is not waited for. */
const PROBE_TIMEOUT_MS = 5_000;

interface FormChoice {
  readonly element: HTMLElement;
  /** The exact Form URL chosen or typed, trimmed; empty when none is. */
  value(): string;
  setDisabled(disabled: boolean): void;
}

/** One Form's support answer, or null when the Host did not give one in time. */
function probeSupport(organizationId: string, form: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
    api.formSupport(organizationId, form).then(
      (supported) => {
        clearTimeout(timer);
        resolve(supported);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * A choice among the Forms this Host supports, so nobody has to know a Form
 * URL by heart. The list is usable at once; each known Form is asked about
 * when the dialog opens, and its option is marked as the answer arrives: a
 * Form the Host does not support stays visible but cannot be chosen, and one
 * the Host did not answer for says so. "Another exact Form URL" keeps any URL
 * possible. If the Host answered for none, the URL field is the whole
 * control. The create itself still asks about the exact URL before sending.
 */
function formChoice(organizationId: string, onChange: () => void): FormChoice {
  const url = h("input", {
    class: "input",
    id: "create-resource-form-url",
    placeholder: "https://…/forms/Kind/1.0.0/",
    autocomplete: "off",
    spellcheck: "false",
    "aria-label": "Form URL",
  });
  url.hidden = true;
  const options = new Map<string, HTMLOptionElement>();
  const select = h(
    "select",
    { class: "select", id: "create-resource-form" },
    h(
      "option",
      { value: "", disabled: true, selected: true },
      tr("Formを選んでください", "Choose a Form"),
    ),
    ...KNOWN_FORM_GROUPS.map((group) =>
      h(
        "optgroup",
        { label: group.label() },
        group.forms.map((form) => {
          const option = h("option", { value: form }, formLabel(form));
          options.set(form, option);
          return option;
        }),
      ),
    ),
    h("option", { value: OTHER_FORM }, tr("別のForm URLを入力…", "Another exact Form URL…")),
  );
  const label = h("label", { for: "create-resource-form" }, "Form");
  const hint = h("small");
  let pending = options.size;
  let answered = 0;

  const typed = (): boolean => select.hidden || select.value === OTHER_FORM;
  const value = (): string =>
    typed() ? url.value.trim() : select.value.startsWith("https://") ? select.value : "";
  const render = (): void => {
    url.hidden = !typed();
    if (!typed() && select.value.startsWith("https://")) {
      hint.replaceChildren(
        tr(
          "設定に書ける項目は公開仕様で確認できます：",
          "The spec's fields are in its published contract: ",
        ),
        h(
          "a",
          { href: select.value, target: "_blank", rel: "noopener noreferrer" },
          formLabel(select.value),
          h("span", { "aria-hidden": "true" }, " ↗"),
          h(
            "span",
            { class: "visually-hidden" },
            tr("（新しいタブで開きます）", " (opens in a new tab)"),
          ),
        ),
      );
      return;
    }
    hint.replaceChildren(
      select.hidden
        ? tr(
            "このHostが対応しているFormを確認できませんでした。正確なForm URLを入力してください。",
            "Couldn't ask this Host which Forms it supports. Enter an exact Form URL.",
          )
        : select.value === OTHER_FORM
          ? tr(
              "正確なForm URLを入力してください。送信前に、このHostが対応しているかを確認します。",
              "Enter an exact Form URL. The Host is asked whether it supports it before anything is sent.",
            )
          : pending > 0
            ? tr(
                "このHostが対応しているFormを確認しています…",
                "Checking which Forms this Host supports…",
              )
            : tr(
                "このHostが対応しているFormだけを選べます。",
                "Only the Forms this Host supports can be chosen.",
              ),
    );
  };
  const sync = (): void => {
    render();
    onChange();
  };
  select.addEventListener("change", sync);
  url.addEventListener("input", sync);

  const settle = (form: string, supported: boolean | null): void => {
    pending -= 1;
    const option = options.get(form);
    if (supported === false) {
      if (option) {
        option.disabled = true;
        option.replaceChildren(
          tr(
            `${formLabel(form)}（このHostにはありません）`,
            `${formLabel(form)} — not on this Host`,
          ),
        );
      }
      answered += 1;
    } else if (supported === null) {
      option?.replaceChildren(
        tr(`${formLabel(form)}（確認できませんでした）`, `${formLabel(form)} — not checked`),
      );
    } else {
      answered += 1;
    }
    // Once the create is being sent the choice is fixed; a late answer only
    // marks its option, and the create's own check decides what is sent.
    if (select.disabled) return;
    if (supported === false && select.value === form) select.value = "";
    // A Host that answered for no Form at all leaves only the exact URL,
    // unless the person has already picked something to keep.
    if (pending === 0 && answered === 0 && select.value === "") {
      select.hidden = true;
      label.setAttribute("for", "create-resource-form-url");
    }
    sync();
  };
  for (const form of options.keys()) {
    void probeSupport(organizationId, form).then((supported) => settle(form, supported));
  }
  render();

  return {
    element: h("div", { class: "field" }, label, select, url, hint),
    value,
    setDisabled(disabled) {
      url.disabled = disabled;
      select.disabled = disabled;
    },
  };
}

/** The Resources of one exact Form, first page only, or null when the Host did not answer. */
function resourcesOfForm(
  organizationId: string,
  form: string,
): Promise<{ readonly items: readonly ResourceSummary[]; readonly more: boolean } | null> {
  return api.resources(organizationId, { form }).then(
    ({ resources, cursor }) => ({ items: resources, more: cursor !== null }),
    () => null,
  );
}

/**
 * One choice per place the starter names another Resource. Choosing writes
 * that Resource's UID into the spec; the JSON stays the one thing that is
 * sent, so a person can still type any UID by hand.
 */
function referencePicker(
  organizationId: string,
  slots: readonly ReferenceSlot[],
  spec: HTMLTextAreaElement,
  onWrite: (text: string) => void,
): { readonly element: HTMLElement; sync(): void; setDisabled(disabled: boolean): void } {
  let sending = false;
  const selects = slots.map((slot, index) => {
    const id = `create-resource-ref-${index}`;
    // The UIDs this choice offers, so the JSON can be matched without reading the DOM back.
    const offered: string[] = [];
    const select = h(
      "select",
      { class: "select", id },
      h("option", { value: "" }, tr("読み込み中…", "Loading…")),
    );
    select.disabled = true;
    void resourcesOfForm(organizationId, slot.form).then((answer) => {
      const options: HTMLOptionElement[] = [
        h(
          "option",
          { value: "" },
          answer === null
            ? tr("読み込めませんでした", "Couldn't load")
            : answer.items.length === 0
              ? tr("まだありません", "None yet")
              : tr("リソースを選んでください", "Choose a Resource"),
        ),
        ...(answer?.items ?? []).map((item) => h("option", { value: item.uid }, item.name)),
      ];
      if (answer?.more)
        options.push(
          h(
            "option",
            { value: "", disabled: true },
            tr("ほかはUIDを直接書いてください", "Others: write the UID"),
          ),
        );
      offered.push(...(answer?.items ?? []).map((item) => item.uid));
      select.replaceChildren(...options);
      select.dataset.empty = String(answer === null || answer.items.length === 0);
      select.disabled = sending || select.dataset.empty === "true";
      sync();
    });
    select.addEventListener("change", () => {
      const parsed = jsonSpec(spec.value);
      if (!parsed || select.value === "") return;
      const next = withValueAt(parsed, slot.path, select.value);
      if (!next) return;
      onWrite(JSON.stringify(next, null, 2));
    });
    return {
      slot,
      select,
      offered,
      element: h(
        "div",
        { class: "field" },
        h(
          "label",
          { for: id },
          h("span", { class: "mono" }, slotLabel(slot)),
          ` — ${formLabel(slot.form)}`,
        ),
        select,
      ),
    };
  });
  // The choice follows the JSON: a UID typed by hand, or removed, shows here.
  const sync = (): void => {
    const parsed = jsonSpec(spec.value);
    for (const { slot, select, offered } of selects) {
      const current = parsed ? valueAt(parsed, slot.path) : undefined;
      select.value = typeof current === "string" && offered.includes(current) ? current : "";
    }
  };
  return {
    element: h(
      "div",
      { class: "field", style: { gap: "10px" } },
      h("span", { class: "field__label" }, tr("参照先", "References")),
      ...selects.map(({ element }) => element),
      h(
        "small",
        null,
        tr(
          "選ぶと、そのリソースのUIDが設定に入ります。一覧にないリソースは、UIDを設定に直接書けます。",
          "Choosing one writes its UID into the spec. For a Resource not listed, write its UID there yourself.",
        ),
      ),
    ),
    sync,
    setDisabled(disabled) {
      sending = disabled;
      for (const { select } of selects)
        select.disabled = disabled || select.dataset.empty !== "false";
    },
  };
}

/** Create one Resource of an exact Form this Host supports. */
export function createResource(organizationId: string): void {
  const key = `console-create-${crypto.randomUUID()}`;
  const name = h("input", {
    class: "input",
    id: "create-resource-name",
    placeholder: "my-resource",
    autocomplete: "off",
  });
  const spec = h("textarea", {
    class: "textarea",
    id: "create-resource-spec",
    spellcheck: "false",
  });
  spec.value = "{}";
  const specHint = h("small");
  const references = h("div");
  let picker: ReturnType<typeof referencePicker> | null = null;
  // The starter for the chosen Form, and the exact text the spec held when the
  // Console last wrote it. A spec the person has not touched follows the
  // chosen Form; an edited one is never overwritten, only offered the starter.
  let starter: StarterSpec | null = null;
  let untouched = "{}";
  let chosen = "";
  // Console-written text, sized so the whole starter shows without scrolling.
  const write = (text: string): void => {
    spec.value = text;
    spec.rows = Math.min(12, text.split("\n").length + 1);
    untouched = text;
  };
  const useStarter = (): void => {
    if (!starter) return;
    write(JSON.stringify(starter.spec, null, 2));
    showDetails();
    picker?.sync();
    describeStarter();
  };
  const describeStarter = (): void => {
    if (!starter) {
      specHint.replaceChildren();
      return;
    }
    const label = formLabel(chosen);
    if (spec.value !== untouched) {
      specHint.replaceChildren(
        blankPaths(jsonSpec(spec.value)).length > 0
          ? tr(
              "入力した設定を使います。空の値を埋めてください。",
              "Your spec is kept. Fill in the empty values.",
            )
          : tr("入力した設定を使います。", "Your spec is kept."),
        " ",
        h(
          "button",
          { class: "btn btn--sm", type: "button", onClick: useStarter },
          tr(`${label}の最小の設定で置き換える`, `Replace with the smallest ${label} spec`),
        ),
      );
      return;
    }
    specHint.replaceChildren(
      Object.keys(starter.spec).length === 0
        ? tr(
            `${label}は空の設定 {} で作成できます。`,
            `${label} is created with an empty spec, {}.`,
          )
        : blankPaths(jsonSpec(spec.value)).length > 0
          ? tr(
              `${label}が受け付ける最小の設定です。空の値を埋めてください。`,
              `The smallest spec ${label} accepts. Fill in the empty values.`,
            )
          : tr(`${label}が受け付ける最小の設定です。`, `The smallest spec ${label} accepts.`),
    );
  };
  // Called on every change to the Form control, including each support answer;
  // only a different Form changes the starter.
  const applyStarter = (): void => {
    const selected = form.value();
    if (selected === chosen) return;
    chosen = selected;
    const previous = starter;
    starter = selected ? starterSpec(selected) : null;
    if (spec.value === untouched) {
      // A Resource already chosen for the same place and Form carries over.
      const before = jsonSpec(spec.value);
      let next: Record<string, unknown> = starter?.spec ?? {};
      for (const slot of starter?.references ?? []) {
        const carried = before ? valueAt(before, slot.path) : undefined;
        const same = previous?.references.some(
          (old) => old.form === slot.form && pathLabel(old.path) === pathLabel(slot.path),
        );
        if (same && typeof carried === "string" && carried !== "")
          next = withValueAt(next, slot.path, carried) ?? next;
      }
      write(JSON.stringify(next, null, 2));
    }
    picker =
      starter && starter.references.length > 0
        ? referencePicker(organizationId, starter.references, spec, (text) => {
            // A chosen Resource is the Console's own writing, like the starter.
            write(text);
            showDetails();
            picker?.sync();
            describeStarter();
          })
        : null;
    references.replaceChildren(picker?.element ?? "");
    picker?.sync();
    describeStarter();
  };
  const details = h("div");
  const showDetails = (): void => {
    const parsed = jsonSpec(spec.value);
    const body = parsed
      ? JSON.stringify({
          form: form.value(),
          space: organizationId,
          name: name.value.trim(),
          spec: parsed,
        })
      : null;
    details.replaceChildren(
      recoveryDetails(key, "POST", "/apis/forms.takoform.com/v2/resources", body),
    );
  };
  const form = formChoice(organizationId, () => {
    applyStarter();
    showDetails();
  });
  name.addEventListener("input", showDetails);
  spec.addEventListener("input", () => {
    showDetails();
    picker?.sync();
    describeStarter();
  });
  showDetails();
  let intent: ResourceIntent | null = null;
  const close = openModal({
    title: tr("リソースを作成", "New resource"),
    confirmLabel: tr("受け付ける", "Accept create"),
    body: h(
      "div",
      { style: { display: "grid", gap: "14px" } },
      form.element,
      h(
        "div",
        { class: "field" },
        h("label", { for: "create-resource-name" }, tr("名前", "Name")),
        name,
      ),
      h(
        "div",
        { class: "field" },
        h("label", null, tr("スペース", "Space")),
        h("span", { class: "field__value" }, organizationId),
      ),
      references,
      h(
        "div",
        { class: "field" },
        h("label", { for: "create-resource-spec" }, tr("設定 (JSON)", "Spec (JSON)")),
        spec,
        specHint,
      ),
      requestDisclosure(details),
    ),
    onConfirm: async () => {
      if (!sameOrganization(organizationId)) return;
      if (!intent) {
        const selectedForm = form.value();
        const selectedName = name.value.trim();
        const parsed = jsonSpec(spec.value);
        if (!selectedForm || !selectedName || !parsed) {
          toast(
            tr(
              "Formを選び、名前とJSONオブジェクトを入力してください",
              "Choose a Form, then enter a name and a JSON object",
            ),
            "bad",
          );
          return;
        }
        // A starter's empty values are the ones the Host would refuse; say which.
        const blanks = starter
          ? blankPaths(starter.spec).filter((path) => valueAt(parsed, path) === "")
          : [];
        if (blanks.length > 0) {
          toast(
            tr(
              `まだ空の値があります：${blanks.map(pathLabel).join("、")}`,
              `Still empty: ${blanks.map(pathLabel).join(", ")}`,
            ),
            "bad",
          );
          return;
        }
        form.setDisabled(true);
        name.disabled = true;
        spec.disabled = true;
        picker?.setDisabled(true);
        showDetails();
        try {
          if (!(await api.formSupport(organizationId, selectedForm))) {
            toast(
              tr(
                "このHostはそのFormの作成をサポートしていません",
                "This Host does not support create for that exact Form",
              ),
              "bad",
            );
            form.setDisabled(false);
            name.disabled = false;
            spec.disabled = false;
            picker?.setDisabled(false);
            return;
          }
          if (!sameOrganization(organizationId)) return;
          const replayWindowSeconds = await api.replayWindowSeconds();
          if (!sameOrganization(organizationId)) return;
          intent = prepareResourceIntent(
            organizationId,
            { action: "create", form: selectedForm, name: selectedName, spec: parsed },
            replayWindowSeconds,
            key,
          );
          details.replaceChildren(
            recoveryDetails(
              key,
              "POST",
              "/apis/forms.takoform.com/v2/resources",
              resourceIntentRequestBody(intent),
            ),
          );
        } catch (error) {
          form.setDisabled(false);
          name.disabled = false;
          spec.disabled = false;
          picker?.setDisabled(false);
          toast(explain(error as Error), "bad");
          return;
        }
      }
      await submit(intent, close);
    },
  });
}

/** Update one observed UID, fenced on the generation the person last read. */
export function updateResource(organizationId: string, resource: ResourceSummary): void {
  const key = `console-update-${crypto.randomUUID()}`;
  const path = `/apis/forms.takoform.com/v2/resources/${encodeURIComponent(resource.uid)}`;
  const spec = h("textarea", { class: "textarea", spellcheck: "false" });
  spec.value = JSON.stringify(resource.spec, null, 2);
  const details = h("div");
  const showDetails = (): void => {
    const parsed = jsonSpec(spec.value);
    details.replaceChildren(
      recoveryDetails(
        key,
        "PUT",
        path,
        parsed ? JSON.stringify({ spec: parsed }) : null,
        resource.generation,
      ),
    );
  };
  spec.addEventListener("input", showDetails);
  showDetails();
  let intent: ResourceIntent | null = null;
  const close = openModal({
    title: tr(`${resource.name}を更新`, `Update ${resource.name}`),
    confirmLabel: tr("更新を受け付ける", "Accept update"),
    body: h(
      "div",
      { class: "field" },
      h("label", null, tr("設定 (JSON)", "Spec (JSON)")),
      spec,
      requestDisclosure(details),
    ),
    onConfirm: async () => {
      if (!sameOrganization(organizationId)) return;
      if (!intent) {
        const parsed = jsonSpec(spec.value);
        if (!parsed) {
          toast(tr("JSONオブジェクトを入力してください", "Enter a JSON object"), "bad");
          return;
        }
        spec.disabled = true;
        showDetails();
        try {
          const replayWindowSeconds = await api.replayWindowSeconds();
          if (!sameOrganization(organizationId)) return;
          intent = prepareResourceIntent(
            organizationId,
            { action: "update", uid: resource.uid, generation: resource.generation, spec: parsed },
            replayWindowSeconds,
            key,
          );
          details.replaceChildren(
            recoveryDetails(
              key,
              "PUT",
              path,
              resourceIntentRequestBody(intent),
              resource.generation,
            ),
          );
        } catch (error) {
          spec.disabled = false;
          toast(explain(error as Error), "bad");
          return;
        }
      }
      await submit(intent, close);
    },
  });
}

/** Destructive delete requires a separate explicit confirmation. */
export function deleteResource(organizationId: string, resource: ResourceSummary): void {
  const key = `console-delete-${crypto.randomUUID()}`;
  const path = `/apis/forms.takoform.com/v2/resources/${encodeURIComponent(resource.uid)}`;
  let intent: ResourceIntent | null = null;
  const close = openModal({
    title: tr(`${resource.name}を削除しますか？`, `Delete ${resource.name}?`),
    confirmLabel: tr("リソースを削除", "Delete resource"),
    confirmTone: "danger",
    body: h(
      "div",
      { style: { display: "grid", gap: "14px" } },
      h(
        "div",
        { class: "notice notice--bad" },
        tr(
          "実体と保存されているデータが削除されます。この操作は元に戻せません。",
          "The backend resource and its data may be destroyed. This cannot be undone.",
        ),
      ),
      requestDisclosure(recoveryDetails(key, "DELETE", path, null, resource.generation)),
    ),
    onConfirm: async () => {
      if (!sameOrganization(organizationId)) return;
      if (!intent) {
        try {
          const replayWindowSeconds = await api.replayWindowSeconds();
          if (!sameOrganization(organizationId)) return;
          intent = prepareResourceIntent(
            organizationId,
            { action: "delete", uid: resource.uid, generation: resource.generation },
            replayWindowSeconds,
            key,
          );
        } catch (error) {
          toast(explain(error as Error), "bad");
          return;
        }
      }
      await submit(intent, close);
    },
  });
}
