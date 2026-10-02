import "./base.css";
import "./client/style.css";

if (window.location.pathname === "/history") {
  document.body.classList.add("history-page");
  document.querySelector<HTMLElement>(".app")!.hidden = true;
  const root = document.getElementById("history-page")!;
  root.hidden = false;
  document.title = "History & Review · LAITA";
  const [{ mountHistory }, { InputApi }] = await Promise.all([
    import("./client/history.ts"),
    import("./client/api.ts"),
  ]);
  mountHistory(new InputApi(), root);
} else {
  await import("./chat.ts");
}
