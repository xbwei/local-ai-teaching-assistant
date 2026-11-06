/** Role selection is a request; only the server-issued HttpOnly session is authority. */
export async function requireOwnerSession(): Promise<boolean> {
  const request = (route: string, body?: object) =>
    fetch(`/api/v1/auth/${route}`, {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      mode: "same-origin",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(45_000),
      headers: body ? { "content-type": "application/json" } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  let session: { role: string; source: string } | undefined;
  try {
    const response = await request("session");
    const value: unknown = response.ok ? await response.json() : undefined;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const data = value as Record<string, unknown>;
      if (
        Object.keys(data).sort().join(",") === "role,source" &&
        typeof data.role === "string" &&
        ["admin", "teacher", "student"].includes(data.role) &&
        (data.source === "local" || data.source === "canvas")
      )
        session = { role: data.role, source: data.source };
    }
  } catch {
    /* Unavailable/malformed status returns to the local sign-in screen. */
  }
  if (session) {
    const bar = document.createElement("nav");
    bar.setAttribute("aria-label", "Owner role");
    bar.className = "owner-role";
    const label = document.createElement("span");
    label.textContent = `Owner · ${session.role === "admin" ? "Admin" : session.role === "teacher" ? "Teacher" : "Student"}${session.source === "canvas" ? " · Canvas" : ""} `;
    const logout = document.createElement("button");
    logout.type = "button";
    logout.textContent = "Sign out / change role";
    logout.onclick = async () => {
      const r = await request("logout", {});
      if (r.ok) window.location.assign("/login");
    };
    bar.append(label, logout);
    const target =
      window.location.pathname === "/history"
        ? document.body
        : document.querySelector<HTMLElement>(".app")!;
    target.prepend(bar);
    document.body.dataset.ownerRole = session.role;
    return true;
  }
  document.querySelector<HTMLElement>(".app")!.hidden = true;
  const main = document.createElement("main");
  main.className = "owner-login";
  main.innerHTML =
    '<h1>LAITA · Owner sign in</h1><p>One Owner operates all three local roles. These are not separate participant accounts.</p><form><label>Role <select name="role"><option value="teacher">Teacher</option><option value="student">Student</option><option value="admin">Admin</option></select></label><label>Owner passphrase <input name="passphrase" type="password" autocomplete="off" required maxlength="1024"></label><button type="submit">Sign in</button></form><p role="status"></p><p>First use or recovery: stop LAITA and run <code>npm run owner:setup</code> in your Terminal with the same operator configuration. No default password is installed.</p>';
  document.body.prepend(main);
  const form = main.querySelector("form")!,
    status = main.querySelector<HTMLElement>('[role="status"]')!,
    password = main.querySelector<HTMLInputElement>('[name="passphrase"]')!,
    role = main.querySelector<HTMLSelectElement>('[name="role"]')!;
  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = form.querySelector("button")!;
    button.disabled = true;
    try {
      const pending = request("login", {
        role: role.value,
        passphrase: password.value,
      });
      password.value = "";
      const result = await pending;
      if (result.ok)
        window.location.assign(
          window.location.pathname === "/history" ? "/history" : "/",
        );
      else
        status.textContent =
          result.status === 503
            ? "Local credentials or configuration unavailable. Initialize credentials in Terminal."
            : result.status === 429
              ? "Too many attempts. Wait one minute and retry."
              : "Sign in failed.";
    } catch {
      status.textContent =
        "Sign in unavailable. Check the configured HTTPS entry.";
    } finally {
      password.value = "";
      button.disabled = false;
    }
  };
  return false;
}
