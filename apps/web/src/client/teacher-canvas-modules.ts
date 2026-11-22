import {
  canvasModuleOrderLimit,
  readCanvasModuleDraft,
  type CanvasInventoryEntry,
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
  const confirm = get<HTMLButtonElement>("confirm");
  const preview = get("preview");
  const status = get("status");
  let pending: AbortController | undefined;
  let approved: CanvasModulePreview | undefined;
  const choices = [
    ...scope.pageIds.map((contentId) => ({
      kind: "LINK_PAGE" as const,
      contentId,
    })),
    ...scope.assignmentIds.map((contentId) => ({
      kind: "LINK_ASSIGNMENT" as const,
      contentId,
    })),
  ];
  const selected: { item: CanvasModuleLinkItem; label: string }[] = [];
  const itemType = (kind: CanvasModuleLinkItem["kind"]) =>
    kind === "LINK_PAGE" ? "Page" : "Assignment";

  kind.querySelector<HTMLOptionElement>(
    'option[value="LINK_ORDERED"]',
  )!.disabled = !scope.moduleIds.length || choices.length < 2;
  orderPick.replaceChildren(
    ...choices.map(
      ({ kind, contentId }, index) =>
        new Option(`${itemType(kind)} ${contentId}`, String(index)),
    ),
  );

  for (const [action, ids] of [
    ["LINK_PAGE", scope.pageIds],
    ["LINK_ASSIGNMENT", scope.assignmentIds],
  ] as const) {
    kind.querySelector<HTMLOptionElement>(
      `option[value="${action}"]`,
    )!.disabled = !scope.moduleIds.length || !ids.length;
  }
  module.replaceChildren(
    ...scope.moduleIds.map((id) => new Option(`Module ${id}`, id)),
  );

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
      orderPick.disabled || selected.length >= canvasModuleOrderLimit;
    order.querySelectorAll("button").forEach((button) => {
      button.disabled = !!pending;
    });
    kind.disabled = confirm.disabled = !!pending;
    previewButton.disabled = !!pending || (ordering && selected.length < 2);
  }

  function fillItems() {
    const page = kind.value === "LINK_PAGE";
    content.replaceChildren(
      ...(page ? scope.pageIds : scope.assignmentIds).map(
        (id) => new Option(`${page ? "Page" : "Assignment"} ${id}`, id),
      ),
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

  function addToOrder(item: CanvasModuleLinkItem, name?: string) {
    const label = `${itemType(item.kind)} ${item.contentId}`;
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
    selected.push({ item, label: name ? `${label} · ${name}` : label });
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

  tool.hidden = false;
  syncForm();
  kind.addEventListener("change", () => {
    fillItems();
    if (kind.value === "LINK_ORDERED") orderChanged();
  });
  orderAdd.onclick = () => {
    const item = choices[orderPick.selectedIndex];
    if (!pending && item) addToOrder(item);
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
    if (plan.draft.kind === "LINK_ORDERED") {
      abort.textContent = "Stop module plan";
      abort.hidden = false;
    }
    const creating = plan.draft.kind === "CREATE_MODULE";
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
        if (creating && !scope.moduleIds.includes(result.resourceId))
          status.textContent +=
            " To add items through LAITA, approve this module ID in the REST settings and reload.";
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
    renderOrder();
    abort.hidden = true;
    status.textContent = "";
    syncForm();
  });

  return (action, item) => {
    const ids = action === "LINK_PAGE" ? scope.pageIds : scope.assignmentIds;
    if (pending || !scope.moduleIds.length || !ids.includes(item.id))
      return false;
    if (kind.value === "LINK_ORDERED") {
      addToOrder({ kind: action, contentId: item.id }, item.title);
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
