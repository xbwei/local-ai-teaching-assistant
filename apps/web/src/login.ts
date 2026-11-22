type AuthRequest = (route: string, body?: object) => Promise<Response>;

function mountDemoMemberships(request: AuthRequest, bar: HTMLElement) {
  type Membership = {
    username: string;
    role: string;
    course: string;
    active: boolean;
  };
  const panel = document.createElement("details");
  const heading = document.createElement("summary");
  heading.textContent = "Demo memberships";
  const list = document.createElement("ul");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  panel.append(heading, list, status);
  bar.after(panel);
  panel.addEventListener("toggle", async () => {
    if (!panel.open) return;
    status.textContent = "";
    try {
      const response = await request("demo-memberships");
      if (!response.ok) throw new Error();
      const { memberships } = (await response.json()) as {
        memberships: Membership[];
      };
      list.replaceChildren();
      if (!memberships.length) {
        status.textContent =
          "Initialize demo accounts with npm run demo:setup in Terminal.";
        return;
      }
      for (const membership of memberships) {
        const row = document.createElement("li");
        const label = document.createElement("span");
        const button = document.createElement("button");
        button.type = "button";
        function display() {
          label.textContent = `${membership.username} · ${membership.course} · ${membership.active ? "Active" : "Revoked"} `;
          button.textContent = membership.active ? "Revoke" : "Restore";
          button.setAttribute(
            "aria-label",
            `${button.textContent} ${membership.username}`,
          );
        }
        display();
        button.onclick = async () => {
          button.disabled = true;
          status.textContent = "";
          try {
            const updated = await request("demo-memberships", {
              username: membership.username,
              course: membership.course,
              active: !membership.active,
            });
            if (!updated.ok) throw new Error();
            const value = (await updated.json()) as Membership;
            membership.active = value.active;
            display();
          } catch {
            status.textContent =
              "Membership update unavailable. Reopen this panel to check its current state.";
          } finally {
            button.disabled = false;
          }
        };
        row.append(label, button);
        list.append(row);
      }
    } catch {
      list.replaceChildren();
      status.textContent = "Demo memberships unavailable.";
    }
  });
}

/** The server-issued HttpOnly session is the authority for every view. */
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
  let session:
    | { role: string; source: string; sample?: true; course?: string }
    | undefined;
  try {
    const response = await request("session");
    const value: unknown = response.ok ? await response.json() : undefined;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const data = value as Record<string, unknown>;
      if (
        (Object.keys(data).sort().join(",") === "role,source" ||
          (Object.keys(data).sort().join(",") === "course,role,source" &&
            (data.role === "teacher" || data.role === "student") &&
            typeof data.course === "string" &&
            /^[A-Z0-9]{1,32}$/u.test(data.course)) ||
          (Object.keys(data).sort().join(",") === "role,sample,source" &&
            data.role === "student" &&
            data.source === "local" &&
            data.sample === true)) &&
        typeof data.role === "string" &&
        ["admin", "teacher", "student"].includes(data.role) &&
        (data.source === "local" || data.source === "canvas")
      )
        session = {
          role: data.role,
          source: data.source,
          ...(data.sample === true ? { sample: true } : {}),
          ...(typeof data.course === "string" ? { course: data.course } : {}),
        };
    }
  } catch {
    /* Unavailable/malformed status returns to the local sign-in screen. */
  }
  if (session) {
    const bar = document.createElement("nav");
    bar.setAttribute("aria-label", "Current role");
    bar.className = "owner-role";
    const label = document.createElement("span");
    label.textContent = `${session.course ? "Demo" : "Owner"} · ${session.role === "admin" ? "Admin" : session.role === "teacher" ? "Teacher" : "Student"}${session.course ? ` · ${session.course}` : ""}${session.source === "canvas" ? " · Canvas" : session.sample ? " · Test Student sample" : ""} `;
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
    if (session.role === "admin") mountDemoMemberships(request, bar);
    document.body.dataset.ownerRole = session.role;
    document.body.dataset.ownerSource = session.source;
    if (session.course) document.body.dataset.demoCourse = session.course;
    return true;
  }
  document.querySelector<HTMLElement>(".app")!.hidden = true;
  const main = document.createElement("main");
  main.className = "owner-login";
  main.innerHTML =
    '<h1>LAITA sign in</h1><form><label>Account <select name="role"><optgroup label="Owner"><option value="teacher">Owner · Teacher</option><option value="student">Owner · Student</option><option value="admin">Admin</option></optgroup><optgroup label="Synthetic demo"><option value="demo-teacher">Demo Teacher</option><option value="demo-student">Demo Student</option></optgroup></select></label><label id="sample-option" hidden><input name="sample" type="checkbox"> Test Student sample (if configured)</label><label>Passphrase <input name="passphrase" type="password" autocomplete="off" required maxlength="1024"></label><button type="submit">Sign in</button></form><p role="status"></p><p>First use or recovery: stop LAITA and run <code>npm run owner:setup</code> with the same operator configuration. Set up separate practice accounts with <code>npm run demo:setup</code>.</p>';
  document.body.prepend(main);
  const form = main.querySelector("form")!,
    status = main.querySelector<HTMLElement>('[role="status"]')!,
    password = main.querySelector<HTMLInputElement>('[name="passphrase"]')!,
    role = main.querySelector<HTMLSelectElement>('[name="role"]')!,
    sample = main.querySelector<HTMLInputElement>('[name="sample"]')!,
    sampleOption = main.querySelector<HTMLElement>("#sample-option")!;
  const showSample = () => {
    sampleOption.hidden = role.value !== "student";
    if (sampleOption.hidden) sample.checked = false;
  };
  role.onchange = showSample;
  showSample();
  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = form.querySelector("button")!;
    button.disabled = true;
    try {
      const pending = request("login", {
        ...(role.value.startsWith("demo-") || role.value === "admin"
          ? { username: role.value }
          : { role: role.value }),
        passphrase: password.value,
        ...(role.value === "student" && sample.checked ? { sample: true } : {}),
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
              : result.status === 400 && sample.checked
                ? "The Test Student sample is unavailable. Check the local configuration or clear the sample option."
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
