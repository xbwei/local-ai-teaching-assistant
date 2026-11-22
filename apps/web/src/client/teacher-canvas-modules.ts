import {
  canvasModuleOrderLimit,
  readCanvasModuleDraft,
  type CanvasInventoryEntry,
  type CanvasModuleCatalog,
  type CanvasModuleLinkItem,
  type CanvasModulePreview,
  type CanvasModuleStep,
} from "@laita/contracts/browser";
import { ClientError, type InputApi } from "./api.ts";

const get = <T extends HTMLElement>(id: string) =>
  document.getElementById(`canvas-module-${id}`) as T;

export type CanvasModuleItemSelector = (
  action: "LINK_PAGE" | "LINK_ASSIGNMENT",
  item: Pick<CanvasInventoryEntry, "id" | "title">,
) => boolean;

export async function mountTeacherCanvasModules(
  api: InputApi,
): Promise<CanvasModuleItemSelector> {
  const scope = await api.canvasModuleScope();
  const tool = document.querySelector<HTMLDetailsElement>(
    "#teacher-canvas-modules",
  )!;
  const form = get<HTMLFormElement>("form");
  const kind = get<HTMLSelectElement>("kind");
  const title = get<HTMLInputElement>("title");
  const module = get<HTMLSelectElement>("id");
  const content = get<HTMLSelectElement>("content");
  const orderFields = get("order-fields");
  const orderPick = get<HTMLSelectElement>("order-pick");
  const orderAdd = get<HTMLButtonElement>("order-add");
  const order = get<HTMLOListElement>("order");
  const reviewedOrder = get<HTMLOListElement>("reviewed-order");
  const previewButton = form.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  )!;
  const abort = get<HTMLButtonElement>("abort");
  const refresh = get<HTMLButtonElement>("refresh");
  const confirm = get<HTMLButtonElement>("confirm");
  const preview = get("preview");
  const status = get("status");
  let pending: AbortController | undefined;
  let approved: CanvasModulePreview | undefined;
  const dynamic = scope.organizeSavedResources === true;
  let destinations: { id: string; label: string }[] = [];
  let choices: { item: CanvasModuleLinkItem; label: string }[] = [];
  const selected: { item: CanvasModuleLinkItem; label: string }[] = [];
  const itemType = (kind: CanvasModuleLinkItem["kind"]) =>
    kind === "LINK_PAGE" ? "Page" : "Assignment";

  const placeholder = (label: string) =>
    dynamic ? [new Option(label, "")] : [];

  function setChoices(catalog?: CanvasModuleCatalog) {
    destinations = dynamic
      ? (catalog?.modules ?? []).map(({ id, title }) => ({
          id,
          label: `${title} · Module ${id}`,
        }))
      : scope.moduleIds.map((id) => ({ id, label: `Module ${id}` }));
    choices = [];
    for (const [action, ids, entries] of [
      ["LINK_PAGE", scope.pageIds, catalog?.pages ?? []],
      ["LINK_ASSIGNMENT", scope.assignmentIds, catalog?.assignments ?? []],
    ] as const) {
      const section = dynamic
        ? entries.map(({ id, title, published }) => ({
            item: { kind: action, contentId: id },
            label: `${title} · ${itemType(action)} ${id} · ${published ? "Published" : "Unpublished"}`,
          }))
        : ids.map((id) => ({
            item: { kind: action, contentId: id },
            label: `${itemType(action)} ${id}`,
          }));
      choices.push(...section);
      kind.querySelector<HTMLOptionElement>(
        `option[value="${action}"]`,
      )!.disabled = !destinations.length || !section.length;
    }
    kind.querySelector<HTMLOptionElement>(
      'option[value="LINK_ORDERED"]',
    )!.disabled = !destinations.length || choices.length < 2;
    if (kind.selectedOptions[0]?.disabled) kind.value = "CREATE_MODULE";
    orderPick.replaceChildren(
      ...placeholder("Choose an item"),
      ...choices.map(({ label }, index) => new Option(label, String(index))),
    );
    module.replaceChildren(
      ...placeholder("Choose an unpublished module"),
      ...destinations.map(({ id, label }) => new Option(label, id)),
    );
    fillItems();
  }

  function syncForm() {
    const adding = kind.value !== "CREATE_MODULE";
    const ordering = kind.value === "LINK_ORDERED";
    title.closest("label")!.hidden = adding;
    module.closest("label")!.hidden = !adding;
    content.closest("label")!.hidden = !adding || ordering;
    orderFields.hidden = !ordering;
    title.disabled = adding || !!pending;
    module.disabled = !adding || !!pending;
    content.disabled = !adding || ordering || !!pending;
    orderPick.disabled = !ordering || !!pending;
    orderAdd.disabled =
      orderPick.disabled ||
      orderPick.value === "" ||
      selected.length >= canvasModuleOrderLimit;
    order.querySelectorAll("button").forEach((button) => {
      button.disabled = !!pending;
    });
    kind.disabled = confirm.disabled = !!pending;
    refresh.disabled = !!pending;
    previewButton.disabled =
      !!pending ||
      (ordering && selected.length < 2) ||
      (dynamic && adding && (!module.value || (!ordering && !content.value)));
  }

  function fillItems() {
    content.replaceChildren(
      ...placeholder("Choose a saved item"),
      ...choices
        .filter(({ item }) => item.kind === kind.value)
        .map(({ item, label }) => new Option(label, item.contentId)),
    );
  }

  function clearPreview() {
    approved = undefined;
    preview.hidden = true;
    get("target").textContent = "";
    get("change").textContent = "";
    reviewedOrder.replaceChildren();
    reviewedOrder.hidden = true;
  }

  function renderOrder() {
    order.replaceChildren(
      ...selected.map(({ label }, index) => {
        const row = document.createElement("li");
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "Remove";
        remove.setAttribute("aria-label", `Remove ${label}`);
        remove.onclick = () => {
          selected.splice(index, 1);
          orderChanged();
          orderPick.focus();
        };
        row.append(label, " ");
        if (index > 0) {
          const move = document.createElement("button");
          move.type = "button";
          move.textContent = "Move up";
          move.setAttribute("aria-label", `Move ${label} up`);
          move.onclick = () => {
            const item = selected.splice(index, 1)[0]!;
            selected.splice(index - 1, 0, item);
            orderChanged();
            order.children[index - 1]?.querySelector("button")?.focus();
          };
          row.append(move, " ");
        }
        row.append(remove);
        return row;
      }),
    );
    syncForm();
  }

  function orderChanged() {
    clearPreview();
    status.textContent =
      selected.length < 2
        ? "Add at least two approved items to preview an order."
        : "";
    renderOrder();
  }

  function addToOrder(item: CanvasModuleLinkItem, label: string) {
    if (
      selected.some(
        ({ item: choice }) =>
          choice.kind === item.kind && choice.contentId === item.contentId,
      )
    ) {
      status.textContent = `${label} is already in the order.`;
      return;
    }
    if (selected.length >= canvasModuleOrderLimit) {
      status.textContent = `An order can have up to ${canvasModuleOrderLimit} items.`;
      return;
    }
    selected.push({ item, label });
    orderChanged();
  }

  function finish(controller: AbortController) {
    if (pending !== controller) return;
    pending = undefined;
    abort.hidden = true;
    syncForm();
  }

  function show(plan: CanvasModulePreview) {
    const { target, draft, moduleSubject, orderedSubjects } = plan;
    const course = document.createElement("bdi");
    course.textContent = target.courseName;
    get("target").replaceChildren(
      course,
      ` · Course ${target.courseId} · Teacher ${target.teacherId} · ${target.origin}`,
    );
    const name = document.createElement("bdi");
    if (draft.kind === "CREATE_MODULE") {
      name.textContent = draft.title;
      get("change").replaceChildren(
        "Create an empty, unpublished module named ",
        name,
        ".",
      );
      confirm.textContent = "Create unpublished module";
    } else if (draft.kind === "LINK_ORDERED") {
      if (!orderedSubjects) return;
      const destination = document.createElement("bdi");
      destination.textContent = orderedSubjects[0]!.moduleName;
      get("change").replaceChildren(
        `Append these items to unpublished Module ${draft.moduleId} (`,
        destination,
        ") in this order.",
      );
      reviewedOrder.replaceChildren(
        ...draft.items.map((item, index) => {
          const subject = orderedSubjects[index]!;
          const row = document.createElement("li");
          const name = document.createElement("bdi");
          name.textContent = subject.resourceName;
          row.append(
            `${itemType(item.kind)} ${item.contentId} (`,
            name,
            subject.resourcePublished ? ", published)" : ", unpublished)",
          );
          return row;
        }),
      );
      reviewedOrder.hidden = false;
      confirm.textContent = "Apply reviewed order";
    } else if (moduleSubject) {
      const label = draft.kind === "LINK_PAGE" ? "Page" : "Assignment";
      name.textContent = moduleSubject.resourceName;
      const destination = document.createElement("bdi");
      destination.textContent = moduleSubject.moduleName;
      get("change").replaceChildren(
        `Add ${label} ${draft.contentId} (`,
        name,
        `, ${moduleSubject.resourcePublished ? "published" : "unpublished"}) to the end of unpublished Module ${draft.moduleId} (`,
        destination,
        ").",
      );
      confirm.textContent = "Add item to module";
    }
    preview.hidden = false;
  }

  setChoices();
  refresh.hidden = !dynamic;
  tool.hidden = false;
  syncForm();
  kind.addEventListener("change", () => {
    fillItems();
    if (kind.value === "LINK_ORDERED") orderChanged();
  });
  orderAdd.onclick = () => {
    const choice =
      orderPick.value === "" ? undefined : choices[Number(orderPick.value)];
    if (!pending && choice) addToOrder(choice.item, choice.label);
  };
  refresh.onclick = async () => {
    if (!dynamic || pending) return;
    clearPreview();
    selected.length = 0;
    setChoices();
    const controller = new AbortController();
    pending = controller;
    renderOrder();
    abort.hidden = false;
    abort.textContent = "Cancel resource refresh";
    status.textContent =
      "Refreshing saved Pages, Assignments and unpublished Modules…";
    try {
      const catalog = await api.canvasModuleCatalog(controller.signal);
      if (pending !== controller || controller.signal.aborted) return;
      setChoices(catalog);
      status.textContent =
        destinations.length && choices.length
          ? "Choose an unpublished module and saved items, then preview the change."
          : "No eligible module and saved item are available yet. Create them separately and refresh.";
    } catch {
      if (pending === controller)
        status.textContent = controller.signal.aborted
          ? "Resource refresh cancelled."
          : "The complete resource list is unavailable. Check Canvas access and refresh again.";
    } finally {
      finish(controller);
    }
  };
  form.addEventListener("input", () => {
    if (approved) status.textContent = "Selection changed. Preview again.";
    clearPreview();
    syncForm();
  });
  get("cancel").onclick = () => {
    clearPreview();
    status.textContent = "Module preview cancelled.";
    previewButton.focus();
  };
  abort.onclick = () => pending?.abort();
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (pending) return;
    clearPreview();
    let draft;
    try {
      draft = readCanvasModuleDraft(
        kind.value === "CREATE_MODULE"
          ? { kind: kind.value, title: title.value.trim() }
          : kind.value === "LINK_ORDERED"
            ? {
                kind: kind.value,
                moduleId: module.value,
                items: selected.map(({ item }) => item),
              }
            : {
                kind: kind.value,
                moduleId: module.value,
                contentId: content.value,
              },
      );
    } catch {
      status.textContent =
        "Check the module title or select an approved module and item.";
      return;
    }
    const controller = new AbortController();
    pending = controller;
    syncForm();
    abort.hidden = false;
    abort.textContent = "Cancel preview request";
    status.textContent = "Checking the Canvas destination…";
    try {
      const plan = await api.previewCanvasModule(draft, controller.signal);
      if (pending !== controller || controller.signal.aborted) return;
      approved = plan;
      show(plan);
      status.textContent = "Review the exact module change before confirming.";
    } catch {
      if (pending === controller)
        status.textContent = controller.signal.aborted
          ? "Module preview cancelled."
          : "Preview unavailable. Check the signed Teacher session, unpublished module, and approved item in Canvas.";
    } finally {
      finish(controller);
    }
  };

  function showOrderResult(steps: CanvasModuleStep[], itemCount: number) {
    const verified = steps.flatMap((step) =>
      step.status === "VERIFIED" ? [step.resourceId] : [],
    );
    if (verified.length === itemCount) {
      status.textContent = `Canvas verified all ${itemCount} module items in the reviewed order.`;
      selected.length = 0;
      form.reset();
      renderOrder();
      return;
    }
    const last = steps.at(-1);
    const observation =
      last?.status === "UNCERTAIN"
        ? ` The write result for item ${steps.length} is unknown.`
        : last?.status === "UNVERIFIED"
          ? ` Canvas returned item ${last.resourceId} at step ${steps.length}, but LAITA could not verify it.`
          : "";
    const ids = verified.length
      ? ` Verified module item IDs: ${verified.join(", ")}.`
      : "";
    status.textContent = `Stopped after verifying ${verified.length} of ${itemCount} items.${ids}${observation} Check Modules in Canvas before previewing any remaining items.`;
  }

  confirm.onclick = async () => {
    if (pending || !approved || preview.hidden) return;
    const plan = approved;
    clearPreview();
    const controller = new AbortController();
    pending = controller;
    syncForm();
    const creating = plan.draft.kind === "CREATE_MODULE";
    if (plan.draft.kind === "LINK_ORDERED" || (dynamic && !creating)) {
      abort.textContent = "Stop module plan";
      abort.hidden = false;
    }
    const resultLabel = creating ? "module" : "module item";
    status.textContent = "Applying and verifying the reviewed module change…";
    const uncertain =
      "The result could not be confirmed. Check Modules in Canvas before trying again.";
    try {
      const result = await api.saveCanvasModule(plan, controller.signal);
      if (pending !== controller) return;
      if (result.status === "ORDERED" && plan.draft.kind === "LINK_ORDERED") {
        showOrderResult(result.steps, plan.draft.items.length);
      } else if (result.status === "VERIFIED") {
        status.textContent = `Canvas verified ${resultLabel} ${result.resourceId}.`;
        if (
          creating &&
          !destinations.some(({ id }) => id === result.resourceId)
        )
          status.textContent += dynamic
            ? " Refresh saved Canvas resources to select this module."
            : " To add items through LAITA, approve this module ID in the REST settings and reload.";
        form.reset();
        content.replaceChildren();
      } else {
        status.textContent =
          result.status === "UNVERIFIED"
            ? `Canvas returned ${resultLabel} ${result.resourceId}, but LAITA could not verify it. Check Canvas before trying again.`
            : uncertain;
      }
    } catch (error) {
      if (pending === controller)
        status.textContent =
          error instanceof ClientError && error.status === 409
            ? "The preview could not be confirmed. Check the current target and preview again."
            : uncertain;
    } finally {
      finish(controller);
    }
  };

  window.addEventListener("pagehide", () => {
    pending?.abort();
    pending = undefined;
    clearPreview();
    form.reset();
    content.replaceChildren();
    selected.length = 0;
    if (dynamic) setChoices();
    renderOrder();
    abort.hidden = true;
    status.textContent = "";
    syncForm();
  });

  return (action, item) => {
    const choice = choices.find(
      ({ item: entry }) => entry.kind === action && entry.contentId === item.id,
    );
    if (pending || !destinations.length || !choice) return false;
    if (kind.value === "LINK_ORDERED") {
      addToOrder(
        choice.item,
        dynamic ? choice.label : `${choice.label} · ${item.title}`,
      );
      tool.open = true;
      orderPick.focus();
      return true;
    }
    clearPreview();
    kind.value = action;
    fillItems();
    content.value = item.id;
    content.selectedOptions[0]!.textContent = `${item.title} · ID ${item.id}`;
    module.selectedIndex = -1;
    syncForm();
    status.textContent = "Choose a destination module and preview the change.";
    tool.open = true;
    module.focus();
    return true;
  };
}
