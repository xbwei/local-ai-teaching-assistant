import type { DataClassId } from "@laita/contracts";
export function classifyInput(
  text: unknown,
):
  | { dataClass: DataClassId; workflow: "COURSE_QA" | "CODING_COACH" }
  | undefined {
  if (
    typeof text !== "string" ||
    !text.trim() ||
    new TextEncoder().encode(text).length > 8192 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(
      text,
    )
  )
    return;
  // Defense in depth for the Owner-authored non-sensitive input contract.
  // A recognizer miss is not proof of anonymization or permission to submit excluded data.
  if (
    /\b(?:bearer|password|api[_ -]?key|secret|student\s*(?:id|record)|social security|gradebook|answer key|active assessment)\b|密码|密钥|学生(?:学号|记录|成绩|作业|提交)|成绩册|答案(?:密钥|键)|正在进行的考试|-----BEGIN|\bsk-[a-z0-9_-]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b\d{3}[- .]?\d{2}[- .]?\d{4}\b|\b\d{7,}\b|\bmy name is\b|\b(?:student|pupil).{0,30}\b(?:grade|score|submission)\b/iu.test(
      text,
    )
  )
    return;
  return { dataClass: "IDENTITY_MINIMIZED_USER_TEXT", workflow: "COURSE_QA" };
}
