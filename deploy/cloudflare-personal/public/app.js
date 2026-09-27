"use strict";
const node = (id) => document.getElementById(id);
const state = { projects: [], selected: null, milestones: [], items: [] };
function status(message) { node("message").textContent = message; }
async function api(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin",
    headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) }, ...options });
  const value = await response.json();
  if (!response.ok) throw new Error(response.status === 409 ? "他の更新が先に保存されました。画面を読み直してください。" :
    response.status === 401 ? "ログインが必要です。画面を開き直してください。" : `操作できませんでした (${value.error})`);
  return value;
}
function element(tag, value, className) {
  const result = document.createElement(tag);
  result.textContent = value;
  if (className) result.className = className;
  return result;
}
function formData(form) { return Object.fromEntries(new FormData(form)); }
async function loadProjects() {
  const result = await api("/api/projects");
  state.projects = result.projects;
  node("project-count").textContent = `${state.projects.length} 件`;
  const list = node("projects");
  list.replaceChildren();
  for (const project of state.projects) {
    const button = element("button", "", "project");
    button.type = "button";
    button.dataset.projectId = project.id;
    button.setAttribute("aria-current", project.id === state.selected ? "true" : "false");
    button.append(element("strong", project.name));
    button.append(element("span", `${project.scope === "hybrid" ? "個人と会社で利用" : "個人"} · 未完了 ${project.open_count || 0} 件`, "muted"));
    button.addEventListener("click", () => selectProject(project.id));
    list.append(button);
  }
  if (state.selected && !state.projects.some((project) => project.id === state.selected)) state.selected = null;
  if (state.selected) await selectProject(state.selected);
}
async function selectProject(id) {
  state.selected = id;
  const project = state.projects.find((entry) => entry.id === id);
  if (!project) return;
  node("detail").hidden = false;
  node("detail-title").textContent = project.name;
  node("detail-meta").textContent = `版 ${project.version}`;
  node("purpose").textContent = project.purpose || "目的は未記入です。";
  const repo = node("repository");
  repo.replaceChildren();
  if (project.repository_url) {
    const link = element("a", project.repository_url);
    link.href = project.repository_url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    repo.append(link);
  }
  const form = node("project-edit-form");
  for (const key of ["name", "purpose", "repository_url", "scope"]) form.elements[key].value = project[key];
  const [milestoneResult, itemResult] = await Promise.all([
    api(`/api/projects/${id}/milestones`), api(`/api/projects/${id}/items`)]);
  if (state.selected !== id) return;
  state.milestones = milestoneResult.milestones;
  state.items = itemResult.items;
  renderMilestones();
  renderItems();
  updateSelection();
}
function updateSelection() {
  for (const button of node("projects").querySelectorAll("button")) {
    button.setAttribute("aria-current", button.dataset.projectId === state.selected ? "true" : "false");
  }
}
function renderMilestones() {
  const list = node("milestones");
  const select = node("item-milestone");
  list.replaceChildren();
  select.replaceChildren(new Option("紐付けなし", ""));
  if (!state.milestones.length) list.append(element("p", "マイルストーンはまだありません。", "muted"));
  for (const milestone of state.milestones) {
    select.append(new Option(milestone.goal, milestone.id));
    const card = element("article", "", "item");
    const head = element("div", "", "item-head");
    head.append(element("strong", milestone.goal), element("span", milestone.state, "muted"));
    card.append(head);
    if (milestone.acceptance) card.append(element("p", milestone.acceptance));
    if (milestone.check_date) card.append(element("span", `確認日 ${milestone.check_date}`, "muted"));
    const button = element("button", "編集");
    button.type = "button";
    button.addEventListener("click", () => editMilestone(milestone));
    card.append(button);
    list.append(card);
  }
}
async function editMilestone(milestone) {
  const goal = prompt("目標", milestone.goal);
  if (goal === null) return;
  const acceptance = prompt("受入条件", milestone.acceptance);
  if (acceptance === null) return;
  const checkDate = prompt("確認日 (YYYY-MM-DD、空欄可)", milestone.check_date);
  if (checkDate === null) return;
  const nextState = prompt("状態: 未確認 / 進行中 / 待ち / 完了 / 保留", milestone.state);
  if (nextState === null) return;
  try {
    await api(`/api/milestones/${milestone.id}`, { method: "PATCH", body: JSON.stringify({
      goal, acceptance, check_date: checkDate, state: nextState,
      expected_version: milestone.version }) });
    status("マイルストーンを保存しました。");
    await loadProjects();
    await loadEvents();
  } catch (error) { status(error.message); }
}
function renderItems() {
  const list = node("items");
  list.replaceChildren();
  if (!state.items.length) list.append(element("p", "次の行動はまだありません。", "muted"));
  for (const item of state.items) {
    const card = element("article", "", "item");
    const head = element("div", "", "item-head");
    head.append(element("strong", item.title), element("span", item.state, "muted"));
    card.append(head);
    if (item.next_action) card.append(element("p", item.next_action));
    const linked = state.milestones.find((milestone) => milestone.id === item.milestone_id);
    if (linked) card.append(element("span", `目標: ${linked.goal}`, "muted"));
    if (item.check_date) card.append(element("span", `確認日 ${item.check_date}`, "muted"));
    const button = element("button", "編集");
    button.type = "button";
    button.addEventListener("click", () => editItem(item));
    card.append(button);
    list.append(card);
  }
}
async function editItem(item) {
  const title = prompt("題名", item.title);
  if (title === null) return;
  const next = prompt("次にすること", item.next_action);
  if (next === null) return;
  const date = prompt("確認日 (YYYY-MM-DD、空欄可)", item.check_date);
  if (date === null) return;
  const nextState = prompt("状態: 未確認 / 進行中 / 待ち / 完了 / 保留", item.state);
  if (nextState === null) return;
  try {
    await api(`/api/items/${item.id}`, { method: "PATCH", body: JSON.stringify({
      title, next_action: next, check_date: date, state: nextState,
      milestone_id: item.milestone_id || "", expected_version: item.version }) });
    status("行動を保存しました。");
    await loadProjects();
  } catch (error) { status(error.message); }
}
async function loadEvents() {
  const result = await api("/api/events");
  const list = node("events");
  list.replaceChildren();
  for (const event of result.events) list.append(element("p", `${event.at_utc} · ${event.entity_type} · ${event.operation} · ${event.entity_id}`));
}
node("project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const created = await api("/api/projects", { method: "POST", body: JSON.stringify(formData(event.currentTarget)) });
    event.currentTarget.reset();
    node("project-details").open = false;
    status("案件を追加しました。");
    await loadProjects();
    await selectProject(created.id);
    await loadEvents();
  } catch (error) { status(error.message); }
});
node("project-edit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const project = state.projects.find((entry) => entry.id === state.selected);
  if (!project) return;
  try {
    await api(`/api/projects/${project.id}`, { method: "PATCH", body: JSON.stringify({
      ...formData(event.currentTarget), expected_version: project.version }) });
    node("project-edit-details").open = false;
    status("案件を保存しました。");
    await loadProjects();
    await loadEvents();
  } catch (error) { status(error.message); }
});
node("item-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selected) return;
  try {
    await api(`/api/projects/${state.selected}/items`, { method: "POST", body: JSON.stringify(formData(event.currentTarget)) });
    event.currentTarget.reset();
    node("item-details").open = false;
    status("行動を追加しました。");
    await loadProjects();
    await loadEvents();
  } catch (error) { status(error.message); }
});
node("milestone-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selected) return;
  try {
    await api(`/api/projects/${state.selected}/milestones`, { method: "POST",
      body: JSON.stringify(formData(event.currentTarget)) });
    event.currentTarget.reset();
    node("milestone-details").open = false;
    status("マイルストーンを追加しました。");
    await loadProjects();
    await loadEvents();
  } catch (error) { status(error.message); }
});
Promise.all([api("/api/me"), loadProjects(), loadEvents()]).then(([me]) => {
  node("identity").textContent = me.email;
}).catch((error) => status(error.message));
