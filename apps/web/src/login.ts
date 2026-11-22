type AuthRequest = (route: string, body?: object) => Promise<Response>;

function mountDemoAccounts(request: AuthRequest, bar: HTMLElement) {
  type Account = {
    username: string;
    role: "teacher" | "student";
    label: string;
    active: boolean;
  };
  const panel = document.createElement("details");
  const heading = document.createElement("summary");
  heading.textContent = "Practice accounts";
  const list = document.createElement("ul");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  panel.append(heading, list, status);
  bar.after(panel);
  let load = 0;
  panel.addEventListener("toggle", async () => {
    const current = ++load;
    if (!panel.open) return;
    list.replaceChildren();
    status.textContent = "";
    try {
      const response = await request("demo-accounts");
      if (!response.ok) throw new Error();
      const { accounts } = (await response.json()) as { accounts: Account[] };
      if (current !== load) return;
      if (!accounts.length)
        status.textContent =
          "Initialize practice accounts with npm run demo:setup in Terminal.";
      for (let account of accounts) {
        const row = document.createElement("li");
        const identity = document.createElement("p");
        const form = document.createElement("form");
        const label = document.createElement("label");
        const name = document.createElement("input");
        name.maxLength = 80;
        name.required = true;
        label.append("Display name ", name);
        const rename = document.createElement("button");
        rename.textContent = "Save display name";
        const toggle = document.createElement("button");
        toggle.type = "button";
        const revoke = document.createElement("button");
        revoke.type = "button";
        revoke.textContent = "Revoke sessions";
        let busy = false;
        function display() {
          identity.textContent = `${account.username} · ${account.role === "teacher" ? "Teacher" : "Student"} · ${account.active ? "Active" : "Disabled"}`;
          toggle.textContent = account.active
            ? "Disable account"
            : "Enable account";
          name.disabled =
            rename.disabled =
            revoke.disabled =
              busy || !account.active;
          toggle.disabled = busy;
        }
        name.value = account.label;
        display();
        async function mutate(change: object, success: string) {
          if (busy) return;
          busy = true;
          display();
          status.textContent = "";
          try {
            const response = await request("demo-accounts", {
              username: account.username,
              ...change,
            });
            if (!response.ok) throw new Error();
            account = (await response.json()) as Account;
            name.value = account.label;
            if (current === load) status.textContent = success;
          } catch {
            if (current === load)
              status.textContent =
                "Account update unavailable. Reopen this panel to check the current state.";
          } finally {
            busy = false;
            display();
          }
        }
        form.onsubmit = (event) => {
          event.preventDefault();
          if (account.active)
            void mutate(
              { action: "rename", label: name.value },
              "Display name saved.",
            );
        };
        toggle.onclick = () =>
          void mutate(
            { action: "active", active: !account.active },
            account.active
              ? "Account disabled and sessions revoked."
              : "Account enabled.",
          );
        revoke.onclick = () =>
          void mutate({ action: "revoke-sessions" }, "Sessions revoked.");
        form.append(label, rename, toggle, revoke);
        row.append(identity, form);
        list.append(row);
      }
    } catch {
      if (current === load)
        status.textContent = "Practice accounts unavailable.";
    }
  });
}

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
  const grant = document.createElement("form");
  const account = document.createElement("select");
  const course = document.createElement("select");
  const accountLabel = document.createElement("label");
  const courseLabel = document.createElement("label");
  const submit = document.createElement("button");
  accountLabel.append("Practice account ", account);
  courseLabel.append("Course to grant ", course);
  submit.textContent = "Grant course";
  grant.append(accountLabel, courseLabel, submit);
  grant.hidden = true;
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  panel.append(heading, list, grant, status);
  bar.after(panel);
  let memberships: Membership[] = [];
  let courses: string[] = [];
  let savingGrant = false;
  const availableCourses = (username: string) =>
    courses.filter(
      (id) =>
        !memberships.some(
          (row) => row.username === username && row.course === id,
        ),
    );
  function updateGrantCourses() {
    const available = availableCourses(account.value);
    course.replaceChildren(...available.map((id) => new Option(id, id)));
    submit.disabled = savingGrant || !available.length;
  }
  account.onchange = updateGrantCourses;
  async function load() {
    grant.hidden = true;
    try {
      const response = await request("demo-memberships");
      if (!response.ok) throw new Error();
      const data = (await response.json()) as {
        memberships: Membership[];
        courses: string[];
      };
      ({ memberships, courses } = data);
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
            `${button.textContent} ${membership.username} · ${membership.course}`,
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
      const usernames = [
        ...new Set(memberships.map((row) => row.username)),
      ].filter((name) => availableCourses(name).length);
      account.replaceChildren(
        ...usernames.map((name) => new Option(name, name)),
      );
      updateGrantCourses();
      grant.hidden = !usernames.length;
    } catch {
      list.replaceChildren();
      status.textContent = "Demo memberships unavailable.";
    }
  }
  panel.addEventListener("toggle", () => {
    if (!panel.open) return;
    status.textContent = "";
    void load();
  });
  grant.onsubmit = async (event) => {
    event.preventDefault();
    if (savingGrant || !course.value) return;
    savingGrant = account.disabled = course.disabled = submit.disabled = true;
    status.textContent = "";
    try {
      const response = await request("demo-memberships", {
        action: "grant",
        username: account.value,
        course: course.value,
      });
      if (!response.ok) throw new Error();
      const saved = (await response.json()) as Membership;
      status.textContent = saved.active
        ? "Course granted."
        : "This membership is revoked. Use Restore to reactivate it.";
      await load();
    } catch {
      status.textContent =
        "Grant unavailable. Reopen this panel to check memberships.";
    } finally {
      savingGrant = account.disabled = course.disabled = false;
      updateGrantCourses();
    }
  };
}

async function mountDemoCourse(
  request: AuthRequest,
  bar: HTMLElement,
  current: string,
) {
  try {
    const response = await request("course");
    if (!response.ok) return;
    const { courses } = (await response.json()) as { courses: string[] };
    if (courses.length < 2 || !courses.includes(current)) return;
    const label = document.createElement("label");
    const select = document.createElement("select");
    const status = document.createElement("span");
    status.setAttribute("role", "status");
    select.replaceChildren(...courses.map((id) => new Option(id, id)));
    select.value = current;
    label.append("Current course ", select);
    bar.append(label, status);
    select.onchange = async () => {
      select.disabled = true;
      try {
        const updated = await request("course", { course: select.value });
        if (!updated.ok) throw new Error();
        window.location.reload();
      } catch {
        select.value = current;
        status.textContent =
          "Course switch unavailable. Reload to check the current course.";
      } finally {
        select.disabled = false;
      }
    };
  } catch {
    // The current course remains usable if the course list is unavailable.
  }
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
    | {
        role: string;
        source: string;
        sample?: true;
        course?: string;
        label?: string;
      }
    | undefined;
  try {
    const response = await request("session");
    const value: unknown = response.ok ? await response.json() : undefined;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const data = value as Record<string, unknown>;
      const keys = Object.keys(data).sort().join(",");
      if (
        (keys === "role,source" ||
          ((keys === "course,role,source" ||
            (keys === "course,label,role,source" &&
              typeof data.label === "string")) &&
            (data.role === "teacher" || data.role === "student") &&
            typeof data.course === "string" &&
            /^[A-Z0-9]{1,32}$/u.test(data.course)) ||
          (keys === "role,sample,source" &&
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
          ...(typeof data.label === "string" ? { label: data.label } : {}),
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
    label.textContent = `${session.label ?? (session.course ? "Demo" : "Owner")} · ${session.role === "admin" ? "Admin" : session.role === "teacher" ? "Teacher" : "Student"}${session.course ? ` · ${session.course}` : ""}${session.source === "canvas" ? " · Canvas" : session.sample ? " · Test Student sample" : ""} `;
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
    if (session.role === "admin") {
      mountDemoMemberships(request, bar);
      mountDemoAccounts(request, bar);
    }
    if (session.source === "local" && session.course)
      void mountDemoCourse(request, bar, session.course);
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
