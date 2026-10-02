import type { ProviderRunResult, InputChoices } from "@laita/contracts/browser";

export function courseGroundingNoticeText(
  status: Exclude<
    NonNullable<ProviderRunResult["grounding"]>["status"],
    "GROUNDED"
  >,
  question = "",
): string {
  if (/\p{Script=Han}/u.test(question)) {
    switch (status) {
      case "LOCAL_ONLY":
        return "课程资料仅在本地模式下使用；没有向 OpenAI 发送课程摘录。请选择本地模式后重试。";
      case "SOURCES_UNAVAILABLE":
        return "已批准的公开课程资料快照不可用，或最近一次更新检查失败。我没有凭模型记忆回答。";
      case "EVIDENCE_INPUT_LIMIT":
        return "当前问题、对话和课程证据无法同时放入输入限制，因此没有生成课程答案。请缩小问题范围或开始新对话。";
      case "EVIDENCE_NOT_FOUND":
        return "在已批准的公开课程资料中没有找到足够可靠的依据，因此没有生成课程答案或引用。";
      case "EVIDENCE_AMBIGUOUS":
        return "课程问题存在歧义。请明确一门课程，必要时注明周次或实验编号；本次没有生成课程答案或引用。";
      case "EVIDENCE_CONFLICTING":
        return "已批准的课程资料含有相互冲突的相关依据。我没有擅自选择其中一种说法或生成引用；请查看课程原文。";
    }
  }
  switch (status) {
    case "LOCAL_ONLY":
      return "Course grounding is available only in Local mode. No course excerpts were sent to OpenAI. Choose Local and ask again.";
    case "SOURCES_UNAVAILABLE":
      return "The approved public-course snapshot is unavailable or its latest refresh failed. I did not answer from model memory.";
    case "EVIDENCE_INPUT_LIMIT":
      return "The course evidence cannot fit together with this question and conversation in the current input limit. No course answer was generated. Try a more focused question or a new conversation.";
    case "EVIDENCE_NOT_FOUND":
      return "I did not find reliable support for that claim in the approved public-course snapshot, so I did not generate a course answer or citation.";
    case "EVIDENCE_AMBIGUOUS":
      return "The course request is ambiguous. Name one course and, when relevant, the week or lab number; no course answer or citation was generated.";
    case "EVIDENCE_CONFLICTING":
      return "The approved course files contain conflicting relevant evidence. I did not choose one version or generate a citation; please inspect the course source.";
  }
}

/** Speech errors are fixed copy; never expose native errors or paths. */
export function speechFailureText(state: string): string | undefined {
  switch (state) {
    case "INVALID":
      return "The recorded audio could not be processed. Please try again.";
    case "TIMEOUT":
      return "Speech recognition took too long. Please try again.";
    case "FAILED":
      return "Local speech recognition could not complete this recording.";
    case "CLEANUP_FAILED":
      return "Speech recognition is temporarily unavailable while audio cleanup recovers.";
    case "CANCELLED":
      return "Cancelled. Ask whenever you’re ready.";
    default:
      return undefined;
  }
}

/** Fixed public copy only: never interpolate a provider error/body/configuration. */
export function providerFailureText(
  provider: "LOCAL" | "OPENAI",
  code: NonNullable<ProviderRunResult["legs"][number]["failure"]>["code"],
  retryable: boolean,
): string {
  const name = provider === "LOCAL" ? "Local model" : "OpenAI";
  const retry = retryable ? " You can try again." : "";
  switch (code) {
    case "TIMEOUT":
      return `${name} took too long to answer.${retry}`;
    case "MODEL_LOADING":
    case "MODEL_SWITCHING":
    case "PROVIDER_BUSY":
      return `${name} is still loading or busy.${retryable ? " Try again shortly." : ""}`;
    case "SELECTED_MODEL_UNAVAILABLE":
    case "SELECTED_PROVIDER_UNAVAILABLE":
      return provider === "LOCAL"
        ? "Selected Local model is currently unavailable."
        : "OpenAI is currently unavailable.";
    case "TEMPORARY_PROVIDER_FAILURE":
      return `${name} had a temporary problem.${retry}`;
    case "POLICY_DENIED":
    case "PROVIDER_DISABLED":
      return "This request is not available under the current policy.";
    case "OVER_BUDGET":
    case "OVER_QUOTA":
      return "This request has reached the current usage limit.";
    case "AUTHENTICATION_FAILED":
      return `${name} is unavailable because its access could not be verified.`;
    case "STALE_AUTHORIZATION":
      return "Available choices changed. Please check your selection and try again.";
    case "INPUT_LIMIT":
      return "This request exceeds the current input limit. Try a more focused question or a new conversation.";
    case "EVIDENCE_INVALID":
      return "The server could not validate the course evidence request. No model was called.";
    case "INVALID_REQUEST":
      return "This request could not be accepted. Please revise it and try again.";
    case "CANCELLED":
      return `${name} request was cancelled.`;
    case "INTERNAL_FAILURE":
    default:
      return `${name} could not finish this request.${retry}`;
  }
}

export function localResidencyText(
  model: string,
  choices?: InputChoices,
): string {
  const name = model === "llama3.1:8b" ? "Llama 8B" : "Gemma 12B";
  const local = choices?.providers.providers.find((p) => p.id === "LOCAL");
  if (!local?.models.some((m) => m.id === model))
    return `${name} — unavailable under current policy or installation.`;
  const residency =
    choices?.local?.selectedModel === model
      ? choices.local.residency
      : "UNKNOWN";
  switch (residency) {
    case "UNLOADED":
      return `${name} — installed, currently not in memory. It will load automatically when needed.`;
    case "WARM":
      return local.state === "READY"
        ? `${name} — ready, in memory.`
        : `${name} — in memory; not ready for a request.`;
    case "LOADING":
      return `${name} — loading. Please wait.`;
    case "BUSY":
      return `${name} — busy with a request.`;
    case "SWITCHING":
      return `${name} — switching models. Please wait.`;
    case "UNAVAILABLE":
      return `${name} — currently unavailable.`;
    default:
      return `${name} — current memory state is not known.`;
  }
}
