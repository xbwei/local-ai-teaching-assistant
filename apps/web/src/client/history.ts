import {
  historyStages,
  type HistoryFilter,
  type HistoryPage,
  type ConversationPage,
  type HistoryTurn,
  type HistoryFeedback,
  type HistoryRef,
} from "@laita/contracts/browser";
import type { InputApi } from "./api.ts";
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
  const e = document.createElement(tag);
  e.textContent = text;
  return e;
};
const button = (text: string, action: () => void) => {
  const b = element("button", text);
  b.type = "button";
  b.addEventListener("click", action);
  return b;
};
const select = (label: string, values: string[]) => {
  const wrapper = element("label", label),
    control = element("select");
  for (const value of values) {
    const option = element("option", value || "All");
    option.value = value;
    control.append(option);
  }
  wrapper.append(control);
  return { wrapper, control };
};
export function feedbackControls(
  api: InputApi,
  ref: HistoryRef,
  leg: string,
  canVote: boolean,
  existing?: HistoryFeedback,
) {
  const box = element("div"),
    status = element("span"),
    reason = element("textarea");
  box.className = "feedback-controls";
  reason.maxLength = 2000;
  reason.rows = 2;
  reason.placeholder = "Optional reason / problem (non-sensitive text only)";
  reason.setAttribute("aria-label", "Optional feedback reason");
  reason.value = existing?.reason ?? "";
  let vote = existing?.vote ?? null,
    report = existing?.report ?? false;
  const save = async (newVote: HistoryFeedback["vote"], newReport: boolean) => {
    const buttons = box.querySelectorAll("button");
    buttons.forEach((b) => (b.disabled = true));
    status.textContent = "Saving…";
    try {
      const result = await api.historyRequest<{ saved: boolean }>("feedback", {
        conversation: ref.conversation,
        turn: ref.turn,
        leg,
        vote: newVote,
        report: newReport,
        reason: reason.value,
      });
      if (result.saved !== true) throw new Error();
      vote = newVote;
      report = newReport;
      status.textContent = `Saved${vote ? ` · ${vote === "HELPFUL" ? "Helpful" : "Not helpful"}` : ""}${report ? " · Problem reported" : ""}`;
    } catch {
      status.textContent =
        "Feedback not confirmed saved. Remove excluded/sensitive content or try again later.";
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  };
  if (canVote)
    box.append(
      button("Helpful", () => void save("HELPFUL", report)),
      button("Not helpful", () => void save("NOT_HELPFUL", report)),
    );
  const details = element("details"),
    summary = element("summary", "Reason / report problem");
  details.append(
    summary,
    reason,
    element("p", "A blank reason retains the previously saved reason."),
    button("Save reason", () => void save(vote, report)),
    button("Report problem", () => void save(vote, true)),
  );
  box.append(details, status);
  return box;
}
export function mountHistory(api: InputApi, root: HTMLElement) {
  let revision = 0;
  const navigate = (params: URLSearchParams) => {
    window.history.pushState(
      null,
      "",
      `/history${params.size ? `?${params}` : ""}`,
    );
    void render();
  };
  const link = (text: string, params: URLSearchParams) => {
    const a = element("a", text);
    a.href = `/history${params.size ? `?${params}` : ""}`;
    a.addEventListener("click", (event) => {
      if (
        event.button ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      event.preventDefault();
      navigate(params);
    });
    return a;
  };
  const render = async () => {
    const rev = ++revision;
    const params = new URLSearchParams(location.search);
    const resultsParams = new URLSearchParams(params);
    resultsParams.delete("conversation");
    resultsParams.delete("after");
    const heading = element("h1", "Owner history & review");
    heading.tabIndex = -1;
    const back = element("a", "Back to chat");
    back.href = "/";
    const header = element("div");
    header.className = "history-heading";
    header.append(heading, back);
    const status = element("p");
    status.className = "history-status";
    status.setAttribute("role", "status");
    root.replaceChildren(header);
    const conversation = params.get("conversation");
    if (conversation !== null) {
      root.append(
        link("Back to results", resultsParams),
        element("h2", "Record detail"),
        status,
      );
      const afterText = params.get("after") ?? "0";
      const after = Number(afterText);
      if (
        !/^[a-f0-9]{64}$/.test(conversation) ||
        !/^\d+$/.test(afterText) ||
        !Number.isSafeInteger(after)
      ) {
        status.textContent =
          "Invalid history location. Return to results to select a record.";
        return;
      }
      status.textContent = "Loading complete evidence…";
      try {
        const page = await api.historyRequest<ConversationPage>(
          "conversation",
          { conversation, after },
        );
        if (rev !== revision) return;
        status.textContent = page.turns.length
          ? "Complete retained text. Missing stages remain unobserved; browser playback reports do not prove audible speech."
          : "No retained turns at this location.";
        if (after) {
          const first = new URLSearchParams(params);
          first.delete("after");
          root.append(link("Conversation from start", first));
        }
        for (const turn of page.turns) root.append(renderTurn(api, turn));
        if (page.next !== null) {
          const next = new URLSearchParams(params);
          next.set("after", String(page.next));
          root.append(link("Next turns in conversation", next));
        }
      } catch {
        if (rev === revision)
          status.textContent =
            "Conversation not available. No model was called.";
      }
    } else {
      const tabs = element("nav");
      tabs.setAttribute("aria-label", "History views");
      tabs.className = "history-views";
      const problems = params.get("problems") === "true";
      for (const [label, active] of [
        ["All records", false],
        ["Problems", true],
      ] as const) {
        const next = new URLSearchParams(resultsParams);
        next.delete("before");
        if (active) next.set("problems", "true");
        else next.delete("problems");
        const tab = link(label, next);
        if (active === problems) tab.setAttribute("aria-current", "page");
        tabs.append(tab);
      }
      root.append(
        tabs,
        element(
          "p",
          "Problems reflect recorded failures, incomplete capture, reports, Not helpful feedback, suspicion signals or Owner-confirmed issues. Optional pending Owner review alone is not a problem.",
        ),
      );
      const filters = element("form");
      filters.className = "history-filters";
      const search = element("input");
      search.placeholder = "Search complete question or answer";
      search.maxLength = 200;
      search.setAttribute("aria-label", "Search history");
      search.value = params.get("search") ?? "";
      const controls = {
        inputType: select("Input", ["", "TYPED", "VOICE"]),
        course: select("Course", ["", "IA340", "IA342"]),
        provider: select("Provider", ["", "LOCAL", "OPENAI"]),
        outcome: select("Text outcome", [
          "",
          "SUCCESS",
          "PARTIAL",
          "FAILED",
          "TIMEOUT",
          "CANCELLED",
          "NO_ANSWER",
          "INTERRUPTED",
          "TRANSCRIBED",
          "PENDING",
        ]),
        feedback: select("Feedback", ["", "HELPFUL", "NOT_HELPFUL", "REPORT"]),
        review: select("Optional Owner review", [
          "",
          "PENDING",
          "REVIEWED",
          "CONFIRMED_ISSUE",
          "NO_ISSUE",
        ]),
      };
      for (const [key, value] of Object.entries(controls))
        value.control.value = params.get(key) ?? "";
      const inputs = {
        lab: element("input"),
        model: element("input"),
        since: element("input"),
        until: element("input"),
      };
      for (const [key, label] of [
        ["lab", "Identified lab"],
        ["model", "Model"],
        ["since", "Since"],
        ["until", "Until"],
      ] as const) {
        const input = inputs[key];
        input.setAttribute("aria-label", label);
        input.placeholder = label;
        if (key === "since" || key === "until") input.type = "datetime-local";
        else input.maxLength = 200;
        input.value = params.get(key) ?? "";
      }
      const suspected = element("input");
      suspected.type = "checkbox";
      suspected.checked = params.get("suspected") === "true";
      const suspectedLabel = element("label", "Suspected misuse only");
      suspectedLabel.append(suspected);
      const filter: HistoryFilter = {
        limit: 20,
        ...(problems ? { problems: true } : {}),
      };
      const collect = () => {
        const next = new URLSearchParams();
        if (problems) next.set("problems", "true");
        if (suspected.checked) {
          next.set("suspected", "true");
          filter.suspected = true;
        }
        for (const [key, input] of Object.entries({
          search,
          ...inputs,
          ...Object.fromEntries(
            Object.entries(controls).map(([k, v]) => [k, v.control]),
          ),
        })) {
          if (!input.value) continue;
          let value = input.value;
          if (key === "since" || key === "until") {
            const date = new Date(value);
            if (
              !Number.isFinite(date.getTime()) ||
              date.getUTCFullYear() < 0 ||
              date.getUTCFullYear() > 9999
            )
              throw new Error();
            value = date.toISOString();
          }
          next.set(key, input.value);
          Object.assign(filter, { [key]: value });
        }
        if (inputs.since.validity.badInput || inputs.until.validity.badInput)
          throw new Error();
        return next;
      };
      const submit = () => {
        try {
          navigate(collect());
        } catch {
          status.textContent = "Enter a valid date and time before searching.";
        }
      };
      filters.addEventListener("submit", (event) => {
        event.preventDefault();
        submit();
      });
      const advanced = element("details");
      advanced.className = "history-advanced";
      advanced.open = [
        ...Object.keys(controls),
        ...Object.keys(inputs),
        "suspected",
      ].some((key) => params.has(key));
      advanced.append(
        element("summary", "Filters"),
        ...Object.values(controls).map((c) => c.wrapper),
        ...Object.values(inputs),
        suspectedLabel,
      );
      filters.append(search, button("Search / refresh", submit), advanced);
      const list = element("div");
      list.className = "history-list";
      root.append(filters, status, list);
      try {
        collect();
      } catch {
        status.textContent = "Enter a valid date and time before searching.";
        return;
      }
      if (params.has("before")) {
        const before = Number(params.get("before"));
        if (
          !/^\d+$/.test(params.get("before")!) ||
          !Number.isSafeInteger(before)
        ) {
          status.textContent =
            "Invalid history page. Select All records or Problems to start again.";
          return;
        }
        filter.before = before;
      }
      status.textContent = "Loading…";
      try {
        const result = await api.historyRequest<HistoryPage>("query", filter);
        if (rev !== revision) return;
        for (const row of result.items) {
          const detail = new URLSearchParams(resultsParams);
          detail.set("conversation", row.conversation);
          detail.set("after", String(row.ordinal - 1));
          const entry = link("", detail);
          entry.className = "history-row";
          const metadata = element(
            "span",
            `${new Date(row.created).toLocaleString()} · ${row.inputType}${row.course ? ` · ${row.course}${row.lab ? ` / Lab ${row.lab}` : ""}` : ""} · Text: ${row.outcome}`,
          );
          metadata.className = "history-meta";
          const attribution = element(
            "span",
            row.providers.length
              ? row.providers
                  .map(
                    (p) =>
                      `${p.actualProvider ?? p.provider} / ${p.actualModel ?? p.model}${p.actualProvider === null ? " (requested; execution unobserved)" : ""}`,
                  )
                  .join(" · ")
              : "Provider/model unobserved",
          );
          attribution.className = "history-meta";
          const preview = element(
            "span",
            row.text ?? "No retained transcript / text withheld",
          );
          preview.className = "history-preview";
          entry.append(metadata, attribution, preview);
          const labels = {
            TEXT_OUTCOME: `Text: ${row.outcome}`,
            OWNER_CONFIRMED: "Owner confirmed issue",
            INCOMPLETE: "Incomplete capture",
            SUSPECTED: "Suspected misuse",
            REPORTED: "Problem reported",
            NOT_HELPFUL: "Not helpful",
            TTS_PROBLEM: "TTS problem",
            STAGE_FAILURE: "Recorded stage problem",
          };
          for (const signal of row.problemSignals) {
            const badge = element("span", labels[signal]);
            badge.className = "history-badge";
            entry.append(badge);
          }
          list.append(entry);
        }
        status.textContent = `${result.items.length} records on this page. Open a record for complete evidence. No model is called.`;
        const paging = element("nav");
        paging.className = "history-pagination";
        paging.setAttribute("aria-label", "History pages");
        if (filter.before !== undefined) {
          const first = new URLSearchParams(resultsParams);
          first.delete("before");
          paging.append(link("Newest records", first));
        }
        if (result.next !== null) {
          const next = new URLSearchParams(resultsParams);
          next.set("before", String(result.next));
          paging.append(link("Older records", next));
        }
        root.append(paging);
      } catch {
        if (rev === revision)
          status.textContent =
            "History unavailable. Access or storage could not be verified.";
      }
    }
    if (rev === revision) {
      heading.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
  };
  window.addEventListener("popstate", () => void render());
  void render();
}
function renderTurn(api: InputApi, turn: HistoryTurn) {
  const article = element("article"),
    ref: HistoryRef = {
      conversation: turn.conversation,
      turn: turn.id,
      recording: turn.recording,
    };
  article.className = "history-turn";
  article.append(
    element(
      "h4",
      `${turn.created} · ${turn.inputType} · Text: ${turn.outcome} · Recording: ${turn.recording}`,
    ),
    element(
      "pre",
      turn.text ?? "No recognized text was retained; see the observed stages.",
    ),
  );
  for (const answer of turn.answers) {
    article.append(
      element(
        "h4",
        `${answer.provider} / ${answer.model} · ${answer.status} · Actual: ${answer.actualProvider ?? "unobserved"} / ${answer.actualModel ?? "unobserved"}`,
      ),
      element(
        "pre",
        answer.text ?? `No answer: ${answer.failure ?? answer.status}`,
      ),
      feedbackControls(
        api,
        ref,
        answer.leg,
        answer.status === "COMPLETED",
        turn.feedback.find((f) => f.leg === answer.leg),
      ),
    );
  }
  if (!turn.answers.length)
    article.append(
      feedbackControls(
        api,
        ref,
        "",
        false,
        turn.feedback.find((f) => !f.leg),
      ),
    );
  const sources = element("details"),
    sourceTitle = element(
      "summary",
      `Sources (${turn.sources.length}) · ${turn.course ?? "unidentified course"}${turn.lab ? ` / Lab ${turn.lab}` : ""}`,
    );
  sources.append(sourceTitle);
  for (const source of turn.sources)
    sources.append(
      element(
        "pre",
        `${source.course} @ ${source.commit}\n${source.path} — ${source.section}\n${source.url}`,
      ),
    );
  const trace = element("details");
  trace.append(
    element("summary", "Execution trace / identifiers"),
    element(
      "pre",
      `Conversation: ${turn.conversation}\nTurn: ${turn.id}\nCorrelation: ${turn.correlation ?? "unobserved"}\nInteraction: ${turn.interaction ?? "not reached"}`,
    ),
  );
  const timeline = element("ol");
  for (const event of turn.events)
    timeline.append(
      element(
        "li",
        `${event.at} · ${event.origin} · ${event.stage}: ${event.outcome}${event.durationMs === undefined ? "" : ` · ${event.durationMs} ms`}${event.leg ? ` · ${event.leg}` : ""}${event.snapshot ? ` · Searched snapshot: ${event.snapshot.course} @ ${event.snapshot.commit}` : ""}`,
      ),
    );
  trace.append(
    timeline,
    element(
      "p",
      `Unobserved stages: ${historyStages.filter((s) => !turn.events.some((e) => e.stage === s)).join(", ") || "none"}. A stage without an event may not have executed; no reason is inferred.`,
    ),
  );
  trace.append(
    element(
      "pre",
      `Existing provider accounting: ${JSON.stringify(turn.usage, null, 2)}`,
    ),
  );
  const feedback = element("details");
  feedback.append(element("summary", "Saved user feedback"));
  for (const f of turn.feedback)
    feedback.append(
      element(
        "pre",
        `${f.leg || "Turn problem"} · ${f.vote ?? "No vote"} · Report: ${f.report}\n${f.reason}`,
      ),
    );
  const review = select("Owner disposition (optional)", [
    "PENDING",
    "REVIEWED",
    "CONFIRMED_ISSUE",
    "NO_ISSUE",
  ]);
  review.control.value = turn.review;
  const note = element("textarea"),
    reason = element("textarea"),
    flag = element("input"),
    label = element("label", "Suspected misuse (not a confirmed violation)");
  note.value = turn.note;
  note.placeholder = "Owner review note";
  note.setAttribute("aria-label", "Owner review note");
  note.maxLength = reason.maxLength = 2000;
  reason.value = turn.suspicionReason;
  reason.placeholder = "Suspicion reason";
  reason.setAttribute("aria-label", "Suspicion reason");
  flag.type = "checkbox";
  flag.checked = turn.suspected;
  label.append(flag);
  const saved = element("span");
  const save = button("Save Owner review", () => {
    void (async () => {
      save.disabled = true;
      try {
        const result = await api.historyRequest<{ saved: boolean }>("review", {
          conversation: turn.conversation,
          turn: turn.id,
          review: review.control.value,
          note: note.value,
          suspected: flag.checked,
          suspicionReason: reason.value,
        });
        if (!result.saved) throw new Error();
        saved.textContent = "Review saved.";
        annotation.querySelector("summary")!.textContent =
          `Optional Owner annotation · ${review.control.value}`;
      } catch {
        saved.textContent =
          "Review not confirmed saved. Check non-sensitive text and access/storage.";
      } finally {
        save.disabled = false;
      }
    })();
  });
  const annotation = element("details");
  annotation.className = "owner-annotation";
  annotation.append(
    element("summary", `Optional Owner annotation · ${turn.review}`),
    element(
      "p",
      "Human disposition and notes are optional. Pending review alone does not mark this record as a problem.",
    ),
    review.wrapper,
    note,
    label,
    reason,
    save,
    saved,
  );
  article.append(
    sources,
    trace,
    feedback,
    element(
      "p",
      `Suspicion signal source: ${turn.suspicionSource ?? "none"}${turn.suspected ? ` · ${turn.suspicionReason}` : ""}`,
    ),
    annotation,
  );
  return article;
}
