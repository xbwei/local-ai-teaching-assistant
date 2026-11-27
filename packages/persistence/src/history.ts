import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import { historyOutcomes, historyStages } from "@laita/contracts";
import type {
  HistoryAnswer,
  HistoryDiagnostic,
  HistoryEvent,
  HistoryFeedback,
  HistoryFilter,
  HistoryOutcome,
  HistoryPage,
  HistorySource,
  HistoryTurn,
  ConversationPage,
  HistoryExport,
  HistorySelection,
  HistoryStorage,
} from "@laita/contracts";
import { createOwnerAuthRepository } from "./owner-auth.ts";

export class HistoryValidationError extends Error {}

export class HistoryLifecycleError extends Error {
  constructor(
    readonly code:
      | "SELECTION_UNAVAILABLE"
      | "SELECTION_LIMIT"
      | "EXPORT_LIMIT"
      | "ACTIVE_CONVERSATION"
      | "PROTECTED_HISTORY"
      | "STALE_PREVIEW",
  ) {
    super(code);
  }
}

export interface HistoryScope {
  role: "admin" | "teacher" | "student";
  context?: string;
  principal?: import("./owner-auth.ts").DemoUsername;
}

interface HistoryMembershipVersion {
  revision: string;
  credentialRevision: string;
}

export interface DemoHistoryGrant {
  course: string;
  teacher: HistoryMembershipVersion;
  student: HistoryMembershipVersion;
}

/** All SQL is fixed here; callers never receive a connection or raw query seam. */
export function createHistoryRepository(
  db: DatabaseSync,
  scope?: HistoryScope,
) {
  function sampleQuestions(
    principal: string,
    context: string,
    since: string,
    until: string,
    includeText: boolean,
  ) {
    const limit = includeText ? 12 : 1001;
    const rows = db
      .prepare(
        `SELECT ${includeText ? "substr(t.text, 1, 2000)" : "NULL"} AS question
         FROM history_turns t JOIN history_conversations c ON c.id = t.conversation
         WHERE c.role = 'student' AND c.principal = ? AND c.scope = ? AND t.created >= ? AND t.created <= ?
           AND t.text IS NOT NULL AND t.recording = 'RECORDED'
         ORDER BY t.ordinal DESC LIMIT ?`,
      )
      .all(principal, context, since, until, limit);
    // A summary only uses count to distinguish an empty window from rejected text.
    return {
      count: Math.min(rows.length, 1000),
      partial: rows.length > 1000,
      questions: includeText
        ? rows.flatMap(({ question }) =>
            typeof question === "string" ? [question] : [],
          )
        : [],
    };
  }
  const visibility =
    "c.principal = ?" +
    (scope?.role === "admin" ? "" : " AND c.role = ?") +
    (scope?.context === undefined ? "" : " AND c.scope = ?");
  const visibilityArgs = scope
    ? [
        scope.principal ?? "",
        ...(scope.role === "admin" ? [] : [scope.role]),
        ...(scope.context === undefined ? [] : [scope.context]),
      ]
    : [];
  const allowed = (conversation: string) => {
    if (
      scope &&
      !db
        .prepare(
          `SELECT 1 FROM history_conversations c WHERE c.id = ? AND ${visibility}`,
        )
        .get(conversation, ...visibilityArgs)
    )
      throw new HistoryValidationError("History target unavailable");
  };
  const transaction = (work: () => void) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      work();
      db.exec("COMMIT");
    } catch {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw new Error("History unavailable");
    }
  };
  const exists = (turn: string) => {
    const row = db
      .prepare("SELECT conversation FROM history_turns WHERE id = ?")
      .get(turn);
    if (!row) throw new Error("History target unavailable");
    allowed(String(row.conversation));
  };
  const binding = (conversation: string, turn: string, leg: string) => {
    allowed(conversation);
    if (
      !db
        .prepare(
          "SELECT id FROM history_turns WHERE id = ? AND conversation = ?",
        )
        .get(turn, conversation)
    )
      throw new HistoryValidationError("History target unavailable");
    if (
      leg &&
      !db
        .prepare("SELECT leg FROM history_answers WHERE turn = ? AND leg = ?")
        .get(turn, leg)
    )
      throw new HistoryValidationError("History target unavailable");
  };
  // One fixed projection drives both pagination membership and summary badges.
  // Only an explicit confirmed issue adds an Owner signal; other dispositions
  // neither create problems nor override recorded system facts.
  const signals = {
    OWNER_CONFIRMED: "t.review = 'CONFIRMED_ISSUE'",
    TEXT_OUTCOME: "t.outcome NOT IN ('SUCCESS','TRANSCRIBED','PENDING')",
    INCOMPLETE: "t.recording = 'INCOMPLETE'",
    SUSPECTED: "t.suspected = 1",
    REPORTED:
      "EXISTS (SELECT 1 FROM history_feedback f WHERE f.turn = t.id AND f.report = 1)",
    NOT_HELPFUL:
      "EXISTS (SELECT 1 FROM history_feedback f WHERE f.turn = t.id AND f.vote = 'NOT_HELPFUL')",
    TTS_PROBLEM:
      "EXISTS (SELECT 1 FROM history_events e WHERE e.turn = t.id AND json_extract(e.document, '$.stage') = 'TTS' AND json_extract(e.document, '$.outcome') NOT IN ('REQUESTED','STARTED','READY','SKIPPED','SKIPPED_LONG_ANSWER','TTS_SKIPPED_MUTED','TTS_SKIPPED_COMPARE','TTS_SKIPPED_UNAVAILABLE'))",
    STAGE_FAILURE:
      "EXISTS (SELECT 1 FROM history_events e WHERE e.turn = t.id AND json_extract(e.document, '$.stage') != 'TTS' AND json_extract(e.document, '$.outcome') IN ('FAILED','TIMEOUT','CLEANUP_FAILED','REQUEST_FAILED','INVALID_RESULT','REJECTED_TEXT_WITHHELD','INVALID_AUDIO','MISSING','AMBIGUOUS','CONFLICTING','STALE','UNAVAILABLE','BUSY','JOB_LIMIT','PLAY_FAILED','PLAY_BLOCKED'))",
  } as const;
  function readTurn(r: Record<string, SQLOutputValue>, includeUsage: boolean) {
    const usage =
      includeUsage && r.interaction
        ? db
            .prepare(
              "SELECT attempt_ref AS attempt, run_ref AS run, provider, model, outcome, usage_basis AS basis, input_tokens AS inputTokens, output_tokens AS outputTokens, estimated_cost_nano_usd AS estimatedCostNanoUsd, latency_ms AS latencyMs FROM provider_usage WHERE interaction_ref = ? ORDER BY created_at LIMIT 4",
            )
            .all(r.interaction)
        : [];
    const answers = db
      .prepare(
        "SELECT document FROM history_answers WHERE turn = ? ORDER BY rowid",
      )
      .all(r.id!)
      .map((a) => JSON.parse(String(a.document)) as HistoryAnswer);
    const events = db
      .prepare(
        "SELECT document FROM history_events WHERE turn = ? ORDER BY ordinal",
      )
      .all(r.id!)
      .map((e) => JSON.parse(String(e.document)) as HistoryEvent);
    const feedback = db
      .prepare(
        "SELECT leg, vote, report, reason, updated FROM history_feedback WHERE turn = ? ORDER BY leg",
      )
      .all(r.id!)
      .map((f) => ({
        ...f,
        report: f.report === 1,
      })) as unknown as HistoryFeedback[];
    return {
      id: String(r.id),
      ordinal: Number(r.ordinal),
      conversation: String(r.conversation),
      created: String(r.created),
      inputType: r.input_type,
      text: r.text,
      outcome: r.outcome,
      recording: r.recording,
      correlation: r.correlation,
      interaction: r.interaction,
      course: r.course,
      lab: r.lab,
      sources: JSON.parse(String(r.sources)),
      answers,
      events,
      feedback,
      usage,
      review: r.review,
      note: String(r.note),
      suspected: r.suspected === 1,
      suspicionReason: String(r.suspicion_reason),
      suspicionSource: r.suspicion_source,
    } as HistoryTurn;
  }
  function snapshot<T>(mode: "read" | "write", work: () => T): T {
    db.exec(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } finally {
      if (db.isTransaction) db.exec("ROLLBACK");
    }
  }
  function scoped() {
    if (!scope) throw new HistoryValidationError("History scope unavailable");
  }
  function selectedTurns(selection: HistorySelection) {
    scoped();
    const byConversation = "conversation" in selection;
    const rows = db
      .prepare(
        `SELECT t.id, t.ordinal, t.conversation,
                t.outcome IN ('PENDING', 'TRANSCRIBED') AS pending,
                (t.recording = 'INCOMPLETE' OR t.suspected = 1 OR
                 t.review = 'CONFIRMED_ISSUE') AS protected
         FROM history_turns t JOIN history_conversations c ON c.id = t.conversation
         WHERE ${visibility} AND ${byConversation ? "c.id = ?" : "t.created BETWEEN ? AND ?"}
         ORDER BY t.ordinal LIMIT 251`,
      )
      .all(
        ...visibilityArgs,
        ...(byConversation
          ? [selection.conversation]
          : [selection.since, selection.until]),
      );
    if (!rows.length) throw new HistoryLifecycleError("SELECTION_UNAVAILABLE");
    if (rows.length > 250) throw new HistoryLifecycleError("SELECTION_LIMIT");
    return rows;
  }
  function deletion(
    selection: HistorySelection,
    isActive: (conversation: string) => boolean,
  ) {
    const rows = selectedTurns(selection);
    const conversations = new Set(rows.map((row) => String(row.conversation)));
    if (
      rows.some((row) => row.pending === 1) ||
      [...conversations].some(isActive)
    )
      throw new HistoryLifecycleError("ACTIVE_CONVERSATION");
    if (rows.some((row) => row.protected === 1))
      throw new HistoryLifecycleError("PROTECTED_HISTORY");
    const digest = createHash("sha256")
      .update(JSON.stringify(rows))
      .digest("hex");
    return { rows, conversations, digest };
  }
  const repo = {
    storage(): HistoryStorage {
      scoped();
      const row = db
        .prepare(
          `SELECT count(DISTINCT c.id) AS conversations, count(*) AS turns,
             coalesce(sum(
               coalesce(length(CAST(t.text AS BLOB)), 0) +
               length(CAST(t.sources AS BLOB)) + length(CAST(t.note AS BLOB)) +
               length(CAST(t.suspicion_reason AS BLOB)) +
               (SELECT coalesce(sum(length(CAST(a.document AS BLOB))), 0)
                FROM history_answers a WHERE a.turn = t.id) +
               (SELECT coalesce(sum(length(CAST(e.document AS BLOB))), 0)
                FROM history_events e WHERE e.turn = t.id) +
               (SELECT coalesce(sum(length(CAST(f.reason AS BLOB))), 0)
                FROM history_feedback f WHERE f.turn = t.id)
             ), 0) AS payloadBytes
           FROM history_turns t JOIN history_conversations c ON c.id = t.conversation
           WHERE ${visibility}`,
        )
        .get(...visibilityArgs)!;
      return {
        conversations: Number(row.conversations),
        turns: Number(row.turns),
        payloadBytes: Number(row.payloadBytes),
      };
    },
    exportHistory(selection: HistorySelection): HistoryExport {
      return snapshot("read", () => {
        const rows = selectedTurns(selection);
        const read = db.prepare(
          "SELECT * FROM history_turns WHERE ordinal = ?",
        );
        let bytes = 0;
        const turns = rows.map((row) => {
          const { usage: _usage, ...turn } = readTurn(
            read.get(row.ordinal!)!,
            false,
          );
          bytes += Buffer.byteLength(JSON.stringify(turn));
          if (bytes > 3 * 1024 * 1024)
            throw new HistoryLifecycleError("EXPORT_LIMIT");
          return turn;
        });
        return { contractVersion: "history-export.v1", turns };
      });
    },
    previewDeletion(
      selection: HistorySelection,
      isActive: (conversation: string) => boolean,
    ) {
      const { rows, conversations, digest } = deletion(selection, isActive);
      return { turns: rows.length, conversations: conversations.size, digest };
    },
    deleteHistory(
      selection: HistorySelection,
      expectedDigest: string,
      isActive: (conversation: string) => boolean,
      isCurrent: () => boolean,
    ) {
      return snapshot("write", () => {
        if (!isCurrent()) throw new HistoryLifecycleError("STALE_PREVIEW");
        const { rows, conversations, digest } = deletion(selection, isActive);
        if (digest !== expectedDigest)
          throw new HistoryLifecycleError("STALE_PREVIEW");
        const remove = [
          db.prepare("DELETE FROM history_feedback WHERE turn = ?"),
          db.prepare("DELETE FROM history_events WHERE turn = ?"),
          db.prepare("DELETE FROM history_answers WHERE turn = ?"),
        ];
        const removeTurn = db.prepare("DELETE FROM history_turns WHERE id = ?");
        for (const { id } of rows) {
          for (const statement of remove) statement.run(id!);
          if (removeTurn.run(id!).changes !== 1)
            throw new Error("History unavailable");
        }
        const removeEmpty = db.prepare(
          `DELETE FROM history_conversations WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM history_turns WHERE conversation = ?)`,
        );
        for (const id of conversations) removeEmpty.run(id, id);
        return { deletedTurns: rows.length };
      });
    },
    recover() {
      // A process interruption is not evidence of provider failure or audible output.
      db.prepare(
        "UPDATE history_turns SET outcome = 'INTERRUPTED', recording = 'INCOMPLETE' WHERE outcome IN ('PENDING', 'TRANSCRIBED')",
      ).run();
    },
    begin(value: {
      id: string;
      conversation: string;
      inputType: "TYPED" | "VOICE";
      text: string | null;
      correlation: string | null;
    }) {
      transaction(() => {
        const at = new Date().toISOString();
        db.prepare(
          "INSERT INTO history_conversations(id, created, role, scope, principal) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
        ).run(
          value.conversation,
          at,
          scope?.role ?? "legacy",
          scope?.context ?? "",
          scope?.principal ?? "",
        );
        allowed(value.conversation);
        db.prepare(
          "INSERT INTO history_turns(id, conversation, created, input_type, text, outcome, recording, correlation) VALUES (?, ?, ?, ?, ?, 'PENDING', 'RECORDED', ?)",
        ).run(
          value.id,
          value.conversation,
          at,
          value.inputType,
          value.text,
          value.correlation,
        );
      });
    },
    text(turn: string, text: string) {
      exists(turn);
      db.prepare("UPDATE history_turns SET text = ? WHERE id = ?").run(
        text,
        turn,
      );
    },
    outcome(turn: string, outcome: HistoryOutcome) {
      exists(turn);
      db.prepare("UPDATE history_turns SET outcome = ? WHERE id = ?").run(
        outcome,
        turn,
      );
    },
    incomplete(turn: string) {
      exists(turn);
      db.prepare(
        "UPDATE history_turns SET recording = 'INCOMPLETE' WHERE id = ?",
      ).run(turn);
    },
    source(
      turn: string,
      course: string | null,
      lab: string | null,
      sources: HistorySource[],
    ) {
      exists(turn);
      db.prepare(
        "UPDATE history_turns SET course = ?, lab = coalesce(?, lab), sources = ? WHERE id = ?",
      ).run(
        course,
        lab,
        JSON.stringify(
          sources.map((s) => ({
            course: s.course,
            commit: s.commit,
            path: s.path,
            section: s.section,
            url: s.url,
          })),
        ),
        turn,
      );
    },
    result(
      turn: string,
      interaction: string,
      answers: HistoryAnswer[],
      outcome: HistoryOutcome,
    ) {
      transaction(() => {
        exists(turn);
        db.prepare(
          "UPDATE history_turns SET interaction = ?, outcome = ? WHERE id = ?",
        ).run(interaction, outcome, turn);
        for (const a of answers)
          db.prepare(
            "INSERT INTO history_answers(turn, leg, document) VALUES (?, ?, ?)",
          ).run(
            turn,
            a.leg,
            JSON.stringify({
              leg: a.leg,
              provider: a.provider,
              model: a.model,
              actualProvider: a.actualProvider,
              actualModel: a.actualModel,
              status: a.status,
              text: a.text,
              failure: a.failure,
              latencyMs: a.latencyMs,
            }),
          );
      });
    },
    event(turn: string, event: HistoryEvent) {
      exists(turn);
      const count = Number(
        db
          .prepare("SELECT count(*) AS n FROM history_events WHERE turn = ?")
          .get(turn)!.n,
      );
      if (count >= 256) {
        repo.incomplete(turn);
        throw new Error("Event bound reached");
      }
      db.prepare(
        "INSERT INTO history_events(turn, ordinal, document) VALUES (?, ?, ?)",
      ).run(
        turn,
        count + 1,
        JSON.stringify({
          stage: event.stage,
          outcome: event.outcome,
          at: event.at,
          origin: event.origin,
          ...(event.snapshot
            ? {
                snapshot: {
                  course: event.snapshot.course,
                  commit: event.snapshot.commit,
                },
              }
            : {}),
          ...(event.leg ? { leg: event.leg } : {}),
          ...(event.durationMs !== undefined
            ? { durationMs: event.durationMs }
            : {}),
        }),
      );
    },
    feedback(
      conversation: string,
      turn: string,
      value: Omit<HistoryFeedback, "updated">,
    ) {
      binding(conversation, turn, value.leg);
      if (value.vote && !value.leg)
        throw new HistoryValidationError("An answer leg is required for votes");
      if (value.vote) {
        const answer = JSON.parse(
          String(
            db
              .prepare(
                "SELECT document FROM history_answers WHERE turn = ? AND leg = ?",
              )
              .get(turn, value.leg)!.document,
          ),
        ) as HistoryAnswer;
        if (answer.status !== "COMPLETED")
          throw new HistoryValidationError("No answer to rate");
      }
      db.prepare(
        "INSERT INTO history_feedback(turn, leg, vote, report, reason, updated) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(turn, leg) DO UPDATE SET vote = coalesce(excluded.vote, history_feedback.vote), report = max(excluded.report, history_feedback.report), reason = CASE WHEN excluded.reason = '' THEN history_feedback.reason ELSE excluded.reason END, updated = excluded.updated",
      ).run(
        turn,
        value.leg,
        value.vote,
        Number(value.report),
        value.reason,
        new Date().toISOString(),
      );
    },
    review(
      conversation: string,
      turn: string,
      value: Pick<
        HistoryTurn,
        "review" | "note" | "suspected" | "suspicionReason"
      >,
    ) {
      if (scope?.role === "student")
        throw new HistoryValidationError("Owner review unavailable");
      binding(conversation, turn, "");
      db.prepare(
        "UPDATE history_turns SET review = ?, note = ?, suspected = ?, suspicion_reason = ?, suspicion_source = ? WHERE id = ?",
      ).run(
        value.review,
        value.note,
        Number(value.suspected),
        value.suspicionReason,
        value.suspected ? "OWNER" : null,
        turn,
      );
    },
    safety(turn: string) {
      exists(turn);
      db.prepare(
        "UPDATE history_turns SET suspected = 1, suspicion_reason = 'Existing input guard rejected excluded or invalid input; not a confirmed violation.', suspicion_source = 'SAFETY' WHERE id = ?",
      ).run(turn);
    },
    diagnostic(reference: string): HistoryDiagnostic | null {
      if (scope?.role !== "admin") throw new HistoryValidationError();
      const matches = db
        .prepare(
          `SELECT id, outcome, recording FROM history_turns
           WHERE ordinal > (SELECT coalesce(max(ordinal), 0) - 2000 FROM history_turns)
             AND correlation = ? LIMIT 2`,
        )
        .all(reference);
      if (matches.length !== 1) return null;
      const { id, recording, outcome } = matches[0]!;
      const checkedOutcome = historyOutcomes.find((value) => value === outcome);
      if (
        typeof id !== "string" ||
        (recording !== "RECORDED" && recording !== "INCOMPLETE") ||
        checkedOutcome === undefined
      )
        return null;

      const events = db
        .prepare(
          `SELECT json_extract(document, '$.stage') AS stage,
                  json_extract(document, '$.origin') AS origin
           FROM history_events WHERE turn = ? ORDER BY ordinal LIMIT 256`,
        )
        .all(id);
      const stages: Pick<HistoryEvent, "stage" | "origin">[] = [];
      for (const { stage, origin } of events) {
        const checkedStage = historyStages.find((value) => value === stage);
        if (
          checkedStage === undefined ||
          (origin !== "SERVER" && origin !== "BROWSER")
        )
          return null;
        stages.push({ stage: checkedStage, origin });
      }
      return { recording, outcome: checkedOutcome, stages };
    },
    sampleQuestions(
      since: string,
      until: string,
      includeText: boolean,
      grant?: DemoHistoryGrant,
    ) {
      const context = scope?.context;
      if (scope?.role !== "student" || !context)
        throw new HistoryValidationError("Student History unavailable");
      if (!grant && !scope.principal && /^[a-f0-9]{64}$/u.test(context))
        return sampleQuestions("", context, since, until, includeText);
      if (
        !grant ||
        grant.course !== context ||
        scope.principal !== "demo-student" ||
        !/^[A-Z0-9]{1,32}$/u.test(context)
      )
        throw new HistoryValidationError("Student History unavailable");
      // Read both grants and the questions from one SQLite snapshot so a
      // concurrent credential or membership update cannot mix their versions.
      db.exec("BEGIN");
      try {
        const auth = createOwnerAuthRepository(db);
        const teacher = auth.demoMembership("demo-teacher", context);
        const student = auth.demoMembership("demo-student", context);
        if (
          !teacher?.active ||
          teacher.revision !== grant.teacher.revision ||
          teacher.credentialRevision !== grant.teacher.credentialRevision ||
          !student?.active ||
          student.revision !== grant.student.revision ||
          student.credentialRevision !== grant.student.credentialRevision
        )
          throw new HistoryValidationError("Student History unavailable");
        const result = sampleQuestions(
          scope.principal,
          context,
          since,
          until,
          includeText,
        );
        db.exec("COMMIT");
        return result;
      } finally {
        if (db.isTransaction) db.exec("ROLLBACK");
      }
    },
    list(filter: HistoryFilter): HistoryPage {
      const conditions = ["t.ordinal < ?"],
        args: SQLInputValue[] = [filter.before ?? Number.MAX_SAFE_INTEGER];
      const add = (sql: string, ...values: SQLInputValue[]) => {
        conditions.push(sql);
        args.push(...values);
      };
      if (scope) {
        add(
          `EXISTS (SELECT 1 FROM history_conversations c WHERE c.id = t.conversation AND ${visibility})`,
          ...visibilityArgs,
        );
      }
      if (filter.search)
        add(
          "(instr(lower(coalesce(t.text, '')), lower(?)) > 0 OR EXISTS (SELECT 1 FROM history_answers a WHERE a.turn = t.id AND instr(lower(json_extract(a.document, '$.text')), lower(?)) > 0))",
          filter.search,
          filter.search,
        );
      for (const [key, column] of [
        ["inputType", "input_type"],
        ["course", "course"],
        ["lab", "lab"],
        ["outcome", "outcome"],
        ["review", "review"],
      ] as const)
        if (filter[key]) add(`t.${column} = ?`, filter[key]!);
      if (filter.since) add("t.created >= ?", filter.since);
      if (filter.until) add("t.created <= ?", filter.until);
      if (filter.provider)
        add(
          "EXISTS (SELECT 1 FROM history_answers a WHERE a.turn = t.id AND json_extract(a.document, '$.provider') = ?)",
          filter.provider,
        );
      if (filter.model)
        add(
          "EXISTS (SELECT 1 FROM history_answers a WHERE a.turn = t.id AND json_extract(a.document, '$.model') = ?)",
          filter.model,
        );
      if (filter.feedback)
        add(
          filter.feedback === "REPORT"
            ? "EXISTS (SELECT 1 FROM history_feedback f WHERE f.turn = t.id AND f.report = 1)"
            : "EXISTS (SELECT 1 FROM history_feedback f WHERE f.turn = t.id AND f.vote = ?)",
          ...(filter.feedback === "REPORT" ? [] : [filter.feedback]),
        );
      if (filter.suspected !== undefined)
        add("t.suspected = ?", Number(filter.suspected));
      if (filter.problems)
        add(
          `(${Object.values(signals)
            .map((sql) => `(${sql})`)
            .join(" OR ")})`,
        );
      const limit = Math.max(1, Math.min(50, filter.limit ?? 20));
      const rows = db
        .prepare(
          `SELECT t.id, t.ordinal, t.conversation, t.created, substr(t.text, 1, 160) AS text, t.input_type AS inputType, t.outcome, t.recording, t.course, t.lab, t.review, t.suspected, ${Object.entries(
            signals,
          )
            .map(([name, sql]) => `(${sql}) AS ${name}`)
            .join(
              ", ",
            )} FROM history_turns t WHERE ${conditions.join(" AND ")} ORDER BY t.ordinal DESC LIMIT ?`,
        )
        .all(...args, limit + 1);
      const more = rows.length > limit;
      rows.splice(limit);
      const providerStmt = db.prepare(
        "SELECT json_extract(document, '$.provider') AS provider, json_extract(document, '$.model') AS model, json_extract(document, '$.actualProvider') AS actualProvider, json_extract(document, '$.actualModel') AS actualModel FROM history_answers WHERE turn = ? ORDER BY rowid LIMIT 4",
      );
      return {
        items: rows.map((row) => {
          const { ...summary } = row;
          const problemSignals = (
            Object.keys(signals) as (keyof typeof signals)[]
          ).filter((key) => row[key] === 1);
          for (const key of Object.keys(signals)) delete summary[key];
          // Bounded attribution only; do not fetch full answers or traces for a list.
          const providers = providerStmt.all(row.id!);
          return {
            ...summary,
            suspected: row.suspected === 1,
            providers,
            problemSignals,
          };
        }) as unknown as HistoryPage["items"],
        next: more ? Number(rows.at(-1)!.ordinal) : null,
      };
    },
    conversation(id: string, after = 0): ConversationPage {
      allowed(id);
      const rows = db
        .prepare(
          "SELECT * FROM history_turns WHERE conversation = ? AND ordinal > ? ORDER BY ordinal LIMIT 6",
        )
        .all(id, after);
      const more = rows.length > 5;
      rows.splice(5);
      const turns = rows.map((row) => readTurn(row, true));
      return { turns, next: more ? turns.at(-1)!.ordinal : null };
    },
  };
  return Object.freeze(repo);
}
export type HistoryRepository = ReturnType<typeof createHistoryRepository>;
