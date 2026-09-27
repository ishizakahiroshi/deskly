"use strict";

const byId = (id) => document.getElementById(id);
const loginView = byId("login-view");
const dashboardView = byId("dashboard-view");
const loginForm = byId("login-form");
const loginNameInput = byId("login-name");
const passwordInput = byId("password-input");
const connectionStatus = byId("connection-status");
let sharedMode = false;

function clearChildren(node) {
  node.replaceChildren();
}

function setText(id, value) {
  byId(id).textContent = value;
}

function textNode(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  return node;
}

function displayText(value, maxLength = 160) {
  if (typeof value !== "string") return "—";
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  return cleaned.slice(0, maxLength) || "—";
}

function displayLabel(value) {
  const cleaned = displayText(value, 240);
  if (cleaned === "—") return cleaned;
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1].slice(0, 120) || "—";
}

function displayCount(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
  return Math.trunc(value).toLocaleString("ja-JP");
}

function displayDuration(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
  const seconds = Math.trunc(value);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours.toLocaleString("ja-JP")}時間 ${String(minutes).padStart(2, "0")}分`;
}

function appendField(parent, label, value) {
  const field = document.createElement("p");
  const name = document.createElement("strong");
  name.textContent = `${label}: `;
  field.append(name, document.createTextNode(value));
  parent.append(field);
}

function showLogin(message) {
  dashboardView.hidden = true;
  if (typeof window !== "undefined") byId("workspace-view").hidden = true;
  loginView.hidden = false;
  connectionStatus.textContent = message;
  (sharedMode ? loginNameInput : passwordInput).focus();
}

function showDashboard() {
  loginView.hidden = true;
  dashboardView.hidden = false;
  connectionStatus.textContent = "ログイン済み · 読み取り専用";
  if (typeof window !== "undefined" && window.DesklyWorkspace) window.DesklyWorkspace.load();
}

function setSectionState(id, section) {
  const status = section && typeof section.status === "string" ? section.status : "error";
  const messages = {
    not_configured: "未設定です",
    disconnected: "接続されていません",
    not_connected: "接続されていません",
    error: "読み込みに失敗しました",
    timeout: "読み込みに失敗しました",
    invalid_json: "読み込みに失敗しました",
    invalid_schema: "読み込みに失敗しました",
    execution_error: "読み込みに失敗しました",
    auth_error: "読み込みに失敗しました",
    network_error: "読み込みに失敗しました",
    schema_error: "読み込みに失敗しました",
    config_error: "読み込みに失敗しました",
    ledger_error: "読み込みに失敗しました",
  };
  if (Object.hasOwn(messages, status)) {
    setText(id, messages[status]);
    return false;
  }
  if (status !== "connected" && status !== "ok" && status !== "empty") {
    setText(id, "状態を確認できません");
    return false;
  }
  const rows = section && Array.isArray(section.rows) ? section.rows : [];
  const projects = section && Array.isArray(section.projects) ? section.projects : [];
  const total = section && typeof section.total_count === "number" ? section.total_count : 0;
  if (status === "empty" || (rows.length === 0 && projects.length === 0 && total === 0)) {
    setText(id, "表示できる項目はありません");
    return true;
  }
  setText(id, section.truncated === true ? "接続済み · 一覧の一部を表示" : "接続済み");
  return true;
}

function appendWaitingRows(rows) {
  const list = byId("waiting-rows");
  clearChildren(list);
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = document.createElement("li");
    item.className = "data-card";
    item.append(textNode("h3", "", displayText(row.project)));
    appendField(item, "番", displayText(row.turn));
    appendField(item, "期限", displayText(row.due));
    appendField(item, "件数", displayCount(row.count));
    if (row.overdue === true) appendField(item, "状態", "期限超過");
    if (Array.isArray(row.states) && row.states.length > 0) {
      appendField(item, "連絡状態", row.states.map((value) => displayText(value, 80)).join("・"));
    }
    if (Array.isArray(row.ledger_names) && row.ledger_names.length > 0) {
      appendField(item, "台帳", row.ledger_names.map(displayLabel).join("、"));
    }
    list.append(item);
  }
}

function appendCaseRows(rows) {
  const list = byId("case-rows");
  clearChildren(list);
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = document.createElement("li");
    item.className = "data-card";
    item.append(textNode("h3", "", `${displayText(row.number)} · ${displayText(row.title)}`));
    appendField(item, "状態", displayText(row.status));
    appendField(item, "承認", displayText(row.approval_state));
    appendField(item, "予定期限", displayText(row.promised_due));
    appendField(item, "保留期限", displayText(row.hold_until));
    appendField(item, "番", displayText(row.turn));
    appendField(item, "関連連絡", displayCount(row.linked_count));
    list.append(item);
  }
}

function appendWorklogRows(projects) {
  const list = byId("worklog-rows");
  clearChildren(list);
  for (const project of projects) {
    if (!project || typeof project !== "object") continue;
    const item = document.createElement("li");
    item.className = "data-card";
    item.append(textNode("h3", "", displayLabel(project.project)));
    appendField(item, "合計", displayDuration(project.total_seconds));
    list.append(item);
  }
}

function renderDashboard(data) {
  setText("generated-at", `更新日時 (UTC): ${displayText(data.generated_at_utc)}`);

  const waiting = data.waiting;
  const waitingReady = setSectionState("waiting-summary", waiting);
  setText("waiting-count", waitingReady ? displayCount(waiting.count) : "—");
  setText("waiting-overdue", waitingReady ? `期限超過: ${displayCount(waiting.overdue_count)}` : "");
  const waitingRows = waitingReady && Array.isArray(waiting.rows) ? waiting.rows : [];
  const nextDue = waitingRows
    .filter((row) => row && row.overdue !== true && typeof row.due === "string" && row.due)
    .map((row) => row.due)
    .sort()[0];
  setText("waiting-next-due", nextDue ? `次の期限: ${displayText(nextDue)}` : "次の期限: —");
  appendWaitingRows(waitingRows);

  const cases = data.cases;
  const casesReady = setSectionState("cases-summary", cases);
  setText("cases-count", casesReady ? displayCount(cases.count) : "—");
  setText("cases-unlinked", casesReady ? `未関連: ${displayCount(cases.unlinked_count)}` : "");
  appendCaseRows(casesReady && Array.isArray(cases.rows) ? cases.rows : []);

  const worklog = data.worklog;
  const worklogReady = setSectionState("worklog-summary", worklog);
  const worklogTotalSeconds = worklogReady && Array.isArray(worklog.projects)
    ? worklog.projects.reduce((total, project) => {
      const seconds = project && typeof project.total_seconds === "number"
        ? project.total_seconds
        : 0;
      return total + (Number.isFinite(seconds) && seconds > 0 ? seconds : 0);
    }, 0)
    : null;
  setText(
    "worklog-total",
    worklogReady
      ? `${worklog.truncated === true ? "表示分合計" : "合計"}: ${displayDuration(worklogTotalSeconds)}`
      : "—",
  );
  const range = worklogReady
    ? `${displayText(worklog.range_from)} – ${displayText(worklog.range_to)} (UTC)`
    : "";
  setText("worklog-range", range);
  appendWorklogRows(
    worklogReady && Array.isArray(worklog.projects) ? worklog.projects : [],
  );
}

async function request(url, options) {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers: { Accept: "application/json", ...(options.headers || {}) },
  });
  if (!response.ok) {
    const error = new Error("request failed");
    error.status = response.status;
    throw error;
  }
  return response;
}

async function requestJson(url, options) {
  const response = await request(url, options);
  return response.json();
}

function clearDashboardData() {
  for (const id of ["waiting-rows", "case-rows", "worklog-rows"]) {
    clearChildren(byId(id));
  }
  for (const id of [
    "waiting-count",
    "cases-count",
    "worklog-total",
    "notification-waiting-count",
    "notification-overdue-count",
  ]) {
    setText(id, "—");
  }
  for (const id of [
    "waiting-overdue",
    "waiting-next-due",
    "cases-unlinked",
    "worklog-range",
    "notification-as-of",
  ]) {
    setText(id, "");
  }
  for (const id of ["waiting-summary", "cases-summary", "worklog-summary", "notification-summary"]) {
    setText(id, "読み込み待ち");
  }
  setText("generated-at", "更新日時: —");
}

async function refreshNotificationPreview() {
  const summary = byId("notification-summary");
  setText("notification-waiting-count", "—");
  setText("notification-overdue-count", "—");
  setText("notification-as-of", "");
  try {
    const preview = await requestJson("/api/notification-preview", { method: "GET" });
    if (preview.preview_only !== true) throw new Error("invalid preview");
    setText("notification-waiting-count", displayCount(preview.waiting_count));
    setText("notification-overdue-count", displayCount(preview.overdue_count));
    setText("notification-as-of", `確認時刻 (UTC): ${displayText(preview.as_of_utc)}`);
    summary.textContent = "プレビューのみ · 通知は送信されません";
  } catch (error) {
    if (error && error.status === 401) {
      clearDashboardData();
      showLogin("ログインしてください");
      setText("login-message", "セッションを確認できません。ログインしてください。");
      return;
    }
    summary.textContent = "件数を読み込めませんでした";
  }
}

async function refreshDashboard() {
  setText("dashboard-message", "更新しています…");
  try {
    const data = await requestJson("/api/dashboard", { method: "GET" });
    if (!data || typeof data !== "object" || !data.waiting || !data.cases || !data.worklog) {
      throw new Error("invalid dashboard");
    }
    renderDashboard(data);
    setText("dashboard-message", "");
    showDashboard();
    await refreshNotificationPreview();
  } catch (error) {
    if (error && error.status === 401) {
      clearDashboardData();
      showLogin("ログインしてください");
      setText("login-message", "セッションを確認できません。ログインしてください。");
      return;
    }
    if (dashboardView.hidden) {
      showLogin("Deskly に接続できません");
      setText("login-message", "接続を確認できません。Deskly を起動してから再度お試しください。");
    } else {
      setText("dashboard-message", "更新できませんでした。時間をおいて再度お試しください。");
    }
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setText("login-message", "ログインしています…");
  const password = passwordInput.value;
  try {
    await request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sharedMode ? { login: loginNameInput.value.trim(), password } : { password }),
    });
    passwordInput.value = "";
    setText("login-message", "");
    if (sharedMode) {
      window.location.reload();
      return;
    }
    await refreshDashboard();
  } catch {
    setText("login-message", "ログインできませんでした。入力内容を確認してください。");
  } finally {
    passwordInput.value = "";
  }
});

byId("refresh-button").addEventListener("click", refreshDashboard);
byId("notification-refresh-button").addEventListener("click", refreshNotificationPreview);

async function logoutDashboard() {
  if (sharedMode) {
    try {
      await request("/logout", { method: "POST" });
      window.location.reload();
    } catch {
      setText("workspace-status", "ログアウトできませんでした。もう一度お試しください。");
    }
    return;
  }
  try {
    await request("/logout", { method: "POST" });
  } catch {
    // The local view still closes when the session endpoint is unavailable.
  }
  clearDashboardData();
  setText("login-message", "ログアウトしました");
  showLogin("ログアウトしました");
}

byId("logout-button").addEventListener("click", logoutDashboard);
byId("workspace-logout").addEventListener("click", logoutDashboard);

async function startDashboard() {
  try {
    const mode = await requestJson("/api/mode", { method: "GET" });
    sharedMode = mode.mode === "shared";
  } catch {
    // Older personal servers do not expose the mode endpoint.
  }
  if (!sharedMode) {
    await refreshDashboard();
    return;
  }
  window.DesklySharedMode = true;
  byId("login-name-row").hidden = false;
  byId("workspace-logout").hidden = false;
  loginNameInput.required = true;
  setText("login-help", "ログイン名とパスワードを入力してください。");
  document.querySelector(".site-header .muted").textContent = "許可された案件と自分の仕事を確認します。";
  document.querySelector(".site-footer").textContent = "Deskly · 共有 workspace";
  dashboardView.hidden = true;
  try {
    const workspace = await requestJson("/api/workspace", { method: "GET" });
    if (!workspace.configured) throw new Error("workspace unavailable");
    loginView.hidden = true;
    window.DesklyWorkspace.load();
  } catch (error) {
    if (error && error.status === 401) {
      showLogin("ログインしてください");
    } else {
      showLogin("案件台帳を確認できません");
      setText("login-message", "接続を確認できません。時間をおいて再度お試しください。");
    }
  }
}

startDashboard();
