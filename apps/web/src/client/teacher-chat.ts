import { ClientError, type InputApi } from "./api.ts";

export interface TeacherChatTool {
  id: string;
  label: string;
  scope: string;
  limit: number;
  localModel: boolean;
  ask: (question: string, signal: AbortSignal) => Promise<string>;
  signIn: string;
  unavailable: string;
}

export async function teacherChatTools(
  api: InputApi,
  source: string | undefined,
): Promise<TeacherChatTool[]> {
  if (source === "local") {
    if (!(await api.teacherHistoryEnabled())) return [];
    return [
      {
        id: "history",
        label: "History (Local)",
        scope:
          "Ask for a question count or summary from the configured Test Student sample.",
        limit: 200,
        localModel: true,
        ask: (question, signal) => api.teacherHistory(question, signal),
        signIn: "Sign in again as the local Teacher.",
        unavailable:
          "History Chat is unavailable. Check the local setup and try again.",
      },
    ];
  }
  if (source !== "canvas") return [];

  const local = await api.canvasChatEnabled("local").catch((error: unknown) => {
    if (error instanceof ClientError && [404, 503].includes(error.status))
      return false;
    throw error;
  });
  if (!local && !(await api.canvasChatEnabled())) return [];

  const routes = local ? (["local", "direct"] as const) : (["direct"] as const);
  return routes.map((route) => ({
    id: `canvas-${route}`,
    label: route === "local" ? "Canvas (Local)" : "Canvas (Direct)",
    scope:
      route === "local"
        ? "Ask for a count or score for the configured Canvas Test Student. Use one approved assignment’s unambiguous full title."
        : "For the configured Canvas Test Student, ask “How many submissions for [full title]?” or “What is the score for [full title]?”",
    limit: 280,
    localModel: route === "local",
    ask: (question, signal) => api.canvasChat(question, signal, route),
    signIn: "Launch LAITA from the configured Canvas course as the Teacher.",
    unavailable:
      "Canvas Chat is unavailable. Check the Test Student, assignment permissions and REST setup, then try again.",
  }));
}
