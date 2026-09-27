"use strict";

// The legacy dashboard remains available when a personal workspace is not initialized.
window.DesklyWorkspace = (() => {
  const root = document.getElementById("workspace-view");
  const el = (id) => document.getElementById(id);
  const schemas = {
    source: [["label", "接続元の名前"], ["adapter", "接続元の種類", ["contact", "external_case"]], ["binding", "設定名"]],
    project: [["name", "案件名"], ["purpose", "目的"], ["state", "状態", ["未確認", "進行中", "保留", "終了"]]],
    milestone: [["goal", "目標"], ["acceptance", "受入条件"], ["assignee_id", "担当", "member"], ["check_date", "確認日", "date"], ["state", "状態", ["未確認", "進行中", "待ち", "完了", "保留"]]],
    work_item: [["kind", "分野", ["開発", "営業", "運営"]], ["title", "題名"], ["assignee_id", "担当", "member"], ["next_action", "次の行動"], ["check_date", "確認日", "date"], ["waiting_reason", "待ち理由"], ["state", "状態", ["未確認", "進行中", "待ち", "完了", "保留"]], ["milestone_id", "マイルストーンID"]],
    reference: [["kind", "参照種別", ["md", "https", "contact", "external_case"]], ["target", "参照先"], ["label", "説明"], ["source_id", "接続元", "source"], ["linked_id", "関連項目ID"]],
  };
  let workspaceId = null;
  let memberId = null;
  let memberName = "自分";
  let sources = [];
  let projects = [];
  let projectId = null;
  let editing = null;
  let preview = null;
  let tab = "all";
  let loading = false;
  let formBaseline = "";
  // Keep fetched rows through refreshDetail's DOM rebuild; clear on project or ledger changes.
  let lastFetchProjectId = null;
  let lastFetchResults = null;
  const formState = () => JSON.stringify({ kind: el("workspace-type").value, id: editing?.id || null,
    values: [...new FormData(el("workspace-form")).entries()] });
  const text = (tag, value, className) => {
    const node = document.createElement(tag);
    node.textContent = String(value ?? "");
    if (className) node.className = className;
    return node;
  };
  const field = (parent, label, value) => {
    const row = document.createElement("p");
    row.append(text("strong", `${label}: `), text("span", value === "" || value === null || value === undefined ? "—" : value));
    parent.append(row);
  };
  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: "same-origin", cache: "no-store",
      headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) }, ...options });
    const value = await response.json();
    if (!response.ok) {
      if (response.status === 401 && window.DesklySharedMode) {
        root.hidden = true;
        workspaceId = null;
        preview = null;
        editing = null;
        formBaseline = "";
        window.location.reload();
      }
      const error = new Error(value.error || "request_failed");
      error.status = response.status;
      throw error;
    }
    return value;
  }
  function showTab(next) {
    tab = next;
    for (const name of ["all", "detail", "mine", "access"]) el(`workspace-${name}`).hidden = name !== next;
    for (const button of root.querySelectorAll("[data-workspace-tab]")) {
      button.setAttribute("aria-current", button.dataset.workspaceTab === next ? "page" : "false");
    }
  }
  async function refreshAccess() {
    const state = await api(`/api/workspaces/${workspaceId}/access/members`);
    const list = el("workspace-access-list");
    list.replaceChildren();
    for (const member of state.members) {
      const box = text("article", "", "workspace-card");
      box.append(text("h4", `${member.name} · ${member.role === "owner" ? "管理者" : member.active ? "有効" : "無効"}`));
      if (member.role !== "owner" && member.active) {
        for (const project of projects.filter((item) => !item.archived)) {
          const grant = state.grants.find((item) => item.member_id === member.member_id && item.project_id === project.id);
          const form = document.createElement("form");
          form.className = "workspace-fields";
          const roleLabel = text("label", `${project.name} `);
          const role = document.createElement("select");
          for (const [value, label] of [["", "権限なし"], ["viewer", "閲覧"], ["editor", "編集"]]) role.append(new Option(label, value));
          role.value = grant?.role || "";
          roleLabel.append(role);
          const reasonLabel = text("label", "変更理由 ");
          const reason = document.createElement("input");
          reason.required = true;
          reason.maxLength = 240;
          reasonLabel.append(reason);
          const save = text("button", "権限を保存");
          save.type = "submit";
          form.append(roleLabel, reasonLabel, save);
          form.addEventListener("submit", async (event) => {
            event.preventDefault();
            if (role.value === (grant?.role || "")) { el("workspace-access-message").textContent = "権限に変更はありません"; return; }
            save.disabled = true;
            try {
              await api(`/api/workspaces/${workspaceId}/access/grants`, { method: "POST", body: JSON.stringify({
                project_id: project.id, member_id: member.member_id, role: role.value || null,
                expected_version: grant?.version || 0, operation_id: crypto.randomUUID(), reason: reason.value,
              }) });
              await refreshAccess();
              el("workspace-access-message").textContent = "案件権限を保存しました";
            } catch (error) {
              el("workspace-access-message").textContent = error.status === 409
                ? "競合または担当中の仕事があります。台帳を再読込して確認してください。"
                : "保存できませんでした。入力を確認してください。";
            } finally { save.disabled = false; }
          });
          box.append(form);
        }
        const deactivate = text("button", "メンバーを無効化", "secondary-button");
        deactivate.type = "button";
        const reason = document.createElement("input");
        reason.placeholder = "無効化の理由";
        reason.maxLength = 240;
        reason.setAttribute("aria-label", `${member.name}を無効化する理由`);
        deactivate.addEventListener("click", async () => {
          if (!reason.value.trim()) { el("workspace-access-message").textContent = "無効化の理由を入力してください"; return; }
          if (!window.confirm(`${member.name}を無効化します。担当中の仕事は管理者へ引き継がれます。続けますか？`)) return;
          deactivate.disabled = true;
          try {
            await api(`/api/workspaces/${workspaceId}/access/members/${member.member_id}/deactivate`, {
              method: "POST", body: JSON.stringify({ expected_version: member.version,
                operation_id: crypto.randomUUID(), reason: reason.value }),
            });
            await refreshAccess();
            el("workspace-access-message").textContent = "メンバーを無効化しました";
          } catch (error) {
            el("workspace-access-message").textContent = error.status === 409
              ? "状態が変わりました。台帳を再読込して確認してください。"
              : "無効化できませんでした。管理者が状態を確認してください。";
          } finally { deactivate.disabled = false; }
        });
        box.append(reason, deactivate);
      }
      list.append(box);
    }
  }
  function renderFields() {
    const kind = el("workspace-type").value;
    const box = el("workspace-fields");
    box.replaceChildren();
    for (const [name, title, widget] of schemas[kind]) {
      if (window.DesklySharedMode && kind === "reference" && name === "source_id") continue;
      const label = text("label", `${title} `);
      let control;
      if (widget === "source") {
        control = document.createElement("select");
        control.append(new Option("なし（md・HTTPS）", ""));
        for (const source of sources.filter((entry) => !entry.archived)) {
          control.append(new Option(`${source.label} (${source.adapter})`, source.id));
        }
      } else if (Array.isArray(widget)) {
        control = document.createElement("select");
        const choices = window.DesklySharedMode && kind === "reference" && name === "kind"
          ? widget.filter((choice) => choice === "md" || choice === "https") : widget;
        for (const choice of choices) {
          const option = document.createElement("option");
          option.value = choice;
          option.textContent = choice;
          control.append(option);
        }
      } else {
        control = document.createElement("input");
        control.type = widget === "date" ? "date" : "text";
        control.maxLength = ["purpose", "acceptance", "next_action", "waiting_reason", "target"].includes(name) ? 500 : 120;
      }
      control.name = name;
      if (editing && editing.type === kind) control.value = editing[name] || "";
      else if (widget === "member" || name === "owner_id") control.value = memberId || "";
      if (name === "owner_id") control.readOnly = true;
      label.append(control);
      box.append(label);
    }
    formBaseline = formState();
  }
  function edit(item) {
    editing = item;
    el("workspace-type").value = item.type;
    renderFields();
    el("workspace-preview").hidden = true;
    el("workspace-message").textContent = `編集中: ${item.title || item.goal || item.name || item.label}`;
    el("workspace-form").scrollIntoView({ behavior: "smooth", block: "center" });
  }
  function card(item, title) {
    const box = text("article", "", "workspace-card");
    box.append(text("h4", title));
    for (const [name, label] of [["purpose", "目的"], ["goal", "目標"], ["acceptance", "受入条件"], ["adapter", "接続元の種類"], ["binding", "設定名"], ["kind", "分野"], ["state", "状態"], ["owner_id", "主担当"], ["assignee_id", "担当"], ["next_action", "次の行動"], ["check_date", "確認日"], ["waiting_reason", "待ち理由"]]) {
      if (item.type === "project" && ["next_action", "check_date", "waiting_reason"].includes(name)) continue;
      if (item[name]) field(box, label, (name === "owner_id" || name === "assignee_id") && item[name] === memberId ? memberName : item[name]);
    }
    if (!item.archived) {
      const button = text("button", "編集", "secondary-button");
      button.type = "button";
      button.addEventListener("click", () => edit(item));
      box.append(button);
    }
    const archive = text("button", item.archived ? "アーカイブ解除" : "アーカイブ", "secondary-button");
    archive.type = "button";
    archive.addEventListener("click", async () => {
      try {
        preview = await api(`/api/workspaces/${workspaceId}/commands/preview`, {
          method: "POST", body: JSON.stringify({ operation_id: crypto.randomUUID(),
            action: item.archived ? "restore" : "archive",
            type: item.type, id: item.id, project_id: item.type === "project" ? null : item.project_id,
            version: item.version, data: null,
            reason: item.archived ? "画面からアーカイブ解除" : "画面からアーカイブ" }) });
        showDiff();
      } catch { el("workspace-message").textContent = "変更を確認できませんでした"; }
    });
    box.append(archive);
    return box;
  }
  async function refresh() {
    if (!workspaceId) return;
    const base = `/api/workspaces/${workspaceId}`;
    const [all, mine] = await Promise.all([api(`${base}/projects`), api(`${base}/my-work`)]);
    memberId = all.member_id;
    memberName = all.member_name;
    sources = all.sources;
    projects = all.projects;
    el("workspace-status").textContent = `${all.workspace_name} · ${window.DesklySharedMode ? "共有" : "個人用"}`;
    const allBox = el("workspace-all");
    allBox.replaceChildren(text("h3", "全体"));
    if (!all.projects.length) allBox.append(text("p", "案件はありません。下のフォームから作成できます。"));
    for (const project of all.projects) {
      const box = card(project, project.name);
      field(box, "次のマイルストーン", project.next_milestone);
      field(box, "次の行動", project.next_action);
      field(box, "確認日", project.check_date);
      field(box, "待ち理由", project.waiting_reason);
      field(box, "未確認件数", project.unconfirmed_count);
      const button = text("button", "詳細を見る");
      button.type = "button";
      button.addEventListener("click", () => {
        projectId = project.id;
        lastFetchProjectId = null;
        lastFetchResults = null;
        showTab("detail");
        refreshDetail();
      });
      box.append(button);
      allBox.append(box);
    }
    if (all.archived_projects.length) {
      allBox.append(text("h4", "アーカイブ済み案件"));
      for (const project of all.archived_projects) allBox.append(card(project, project.name));
    }
    if (sources.length && !window.DesklySharedMode) {
      allBox.append(text("h4", "接続元"));
      for (const source of sources) allBox.append(card(source, source.label));
    }
    const mineBox = el("workspace-mine");
    mineBox.replaceChildren(text("h3", "自分の仕事"));
    if (!mine.items.length) mineBox.append(text("p", "担当する未完了作業はありません。"));
    for (const item of mine.items) mineBox.append(card(item, `${item.project_name} · ${item.title}`));
    if (projectId && !all.projects.some((project) => project.id === projectId)) projectId = null;
    if (!projectId && all.projects.length) projectId = all.projects[0].id;
    await refreshDetail();
    renderFields();
  }
  async function refreshDetail() {
    const box = el("workspace-detail");
    if (!projectId) {
      box.replaceChildren(text("h3", "案件詳細"), text("p", "案件を選んでください。"));
      return;
    }
    const base = `/api/workspaces/${workspaceId}/projects/${projectId}`;
    const [detail, history] = await Promise.all([api(base), api(`${base}/history`)]);
    box.replaceChildren(text("h3", "案件詳細"));
    box.append(card(detail.project, detail.project.name));
    for (const [key, title] of [["milestones", "マイルストーン"], ["work_items", "作業"], ["references", "参照"]]) {
      box.append(text("h4", title));
      const active = detail[key].filter((item) => !item.archived);
      if (!active.length) box.append(text("p", "登録はありません。"));
      for (const item of active) {
        if (key !== "references") box.append(card(item, item.goal || item.title));
        else {
          const row = card(item, item.label);
          field(row, "参照先", item.target);
          if (item.kind === "https") {
            const link = text("a", "資料を開く");
            link.href = item.target;
            link.rel = "noopener noreferrer";
            link.target = "_blank";
            row.append(" ", link);
          } else if (item.kind === "md") {
            const copy = text("button", "参照をコピー", "secondary-button");
            copy.type = "button";
            copy.addEventListener("click", () => navigator.clipboard.writeText(item.target));
            row.append(" ", copy);
          }
          box.append(row);
        }
      }
      const archived = detail[key].filter((item) => item.archived);
      if (archived.length) {
        box.append(text("h4", `${title} · アーカイブ済み`));
        for (const item of archived) box.append(card(item, item.goal || item.title || item.label));
      }
    }
    const linked = detail.references.filter((item) => !item.archived && ["contact", "external_case"].includes(item.kind));
    if (!window.DesklySharedMode) {
      const externalStatus = detail.external.status === "not_connected"
        ? "未接続" : detail.external.observations.length ? "取得結果あり" : "未取得";
      field(box, "外部情報", externalStatus);
      for (const observation of detail.external.observations) {
        const reference = linked.find((item) => item.id === observation.reference_id);
        field(box, `${reference?.label || "参照"}の前回取得`,
          `${observation.status} · 試行 ${observation.last_attempt_at_utc || "なし"} · 成功 ${observation.last_success_at_utc || "なし"}`);
      }
    }
    if (linked.length && !window.DesklySharedMode) {
      const fetchButton = text("button", "参照先を取得", "secondary-button");
      fetchButton.type = "button";
      const results = text("div", "未取得。接続元を確認してから取得してください。", "workspace-source-results");
      if (lastFetchProjectId === projectId && lastFetchResults) {
        renderFetchResults(results, lastFetchResults, linked);
      }
      fetchButton.addEventListener("click", async () => {
        fetchButton.disabled = true;
        try {
          const fetched = await api(`/api/workspaces/${workspaceId}/sources/fetch`, {
            method: "POST", body: JSON.stringify({ project_id: projectId }) });
          lastFetchProjectId = projectId;
          lastFetchResults = fetched.references;
          await refreshDetail();
        } catch {
          results.textContent = "取得に失敗しました。表示中の管理項目は変更していません。";
          el("workspace-message").textContent = "取得または表示の更新に失敗しました。台帳の管理項目は変更していません。";
        }
        finally { fetchButton.disabled = false; }
      });
      box.append(fetchButton, results);
    }
    box.append(text("h4", "変更履歴"));
    for (const event of history.events) field(box, event.at_utc, `${event.reason} · ${event.entity_id}`);
  }
  function renderFetchResults(container, entries, linked) {
    container.replaceChildren();
    for (const entry of entries) {
      const reference = linked.find((item) => item.id === entry.reference_id);
      const row = text("p", `${reference?.label || "参照"}: ${entry.status}`);
      if (entry.as_of_utc) row.append(` · 取得時点 ${entry.as_of_utc}`);
      else if (entry.attempted_at_utc) row.append(` · 試行時点 ${entry.attempted_at_utc}`);
      if (entry.data) row.append(` · ${Object.entries(entry.data).map(([key, value]) => `${key}: ${value ?? "—"}`).join(" / ")}`);
      container.append(row);
    }
  }
  async function load() {
    if (loading) return;
    if (workspaceId && (preview || formState() !== formBaseline)) {
      el("workspace-message").textContent = "未保存の入力があるため案件台帳は再読込していません。台帳を再読込する場合は確認してください。";
      return;
    }
    loading = true;
    try {
      const config = await api("/api/workspace");
      if (!config.configured) { root.hidden = true; return; }
      if (window.DesklySharedMode) el("workspace-type").querySelector('option[value="source"]')?.remove();
      workspaceId = config.workspace_id;
      el("workspace-access-tab").hidden = !window.DesklySharedMode || config.role !== "owner";
      if (tab === "access" && el("workspace-access-tab").hidden) tab = "all";
      root.hidden = false;
      document.querySelector(".site-header .muted").textContent = window.DesklySharedMode
        ? "許可された案件と自分の仕事を確認します。"
        : "個人の案件管理と、連絡・外部情報の読み取りビューです。";
      el("connection-status").textContent = window.DesklySharedMode
        ? "ログイン済み · 共有 workspace" : "ログイン済み · 個人用 workspace";
      document.querySelector(".site-footer").textContent = window.DesklySharedMode
        ? "Deskly · 共有 workspace" : "Deskly · 個人用 workspace";
      await refresh();
      if (!el("workspace-access-tab").hidden) await refreshAccess();
      showTab(tab);
    } catch (error) {
      el("workspace-status").textContent = "案件の読み込みに失敗しました";
    } finally { loading = false; }
  }
  el("workspace-type").addEventListener("change", () => { editing = null; renderFields(); });
  el("workspace-refresh").addEventListener("click", async () => {
    if (preview || formState() !== formBaseline) {
      if (!window.confirm("未保存の入力があります。破棄して台帳を再読込しますか？")) return;
    }
    try {
      await refresh();
      if (!el("workspace-access-tab").hidden) await refreshAccess();
      lastFetchProjectId = null;
      lastFetchResults = null;
      await refreshDetail();
      editing = null;
      preview = null;
      el("workspace-preview").hidden = true;
      renderFields();
      el("workspace-message").textContent = "台帳を再読込しました";
    } catch {
      el("workspace-message").textContent = "再読込に失敗しました。入力は残しています。";
    }
  });
  for (const button of root.querySelectorAll("[data-workspace-tab]")) button.addEventListener("click", async () => {
    if (button.dataset.workspaceTab === "access") {
      try { await refreshAccess(); }
      catch { el("workspace-access-message").textContent = "メンバーを読み込めませんでした"; }
    }
    showTab(button.dataset.workspaceTab);
  });
  function showDiff() {
    const diff = el("workspace-diff");
    diff.replaceChildren();
    const labels = Object.fromEntries(schemas[preview.after.type].map(([name, label]) => [name, label]));
    labels.archived = "アーカイブ";
    const displayValue = (name, value) => {
      if (name !== "source_id" || !value) return value;
      return sources.find((source) => source.id === value)?.label || "未登録の接続元";
    };
    for (const [name, label] of Object.entries(labels)) {
      const value = preview.after[name];
      if (JSON.stringify(preview.before?.[name]) === JSON.stringify(value)) continue;
      const oldValue = preview.before?.[name] ?? "—";
      const shownOld = displayValue(name, oldValue);
      const shownNew = displayValue(name, value);
      diff.append(text("dt", label), text("dd", `${shownOld === "" ? "—" : shownOld} → ${shownNew === "" ? "—" : shownNew}`));
    }
    el("workspace-preview").hidden = false;
    el("workspace-message").textContent = "差分を確認して保存してください";
    el("workspace-preview").scrollIntoView({ behavior: "smooth", block: "center" });
  }
  async function showConflict() {
    el("workspace-preview").hidden = true;
    if (!editing) { el("workspace-message").textContent = "競合しました。画面を更新してから再度確認してください。"; return; }
    try {
      const detail = editing.type === "source"
        ? await api(`/api/workspaces/${workspaceId}/projects`)
        : await api(`/api/workspaces/${workspaceId}/projects/${editing.type === "project" ? editing.id : editing.project_id}`);
      const latest = editing.type === "source" ? detail.sources.find((item) => item.id === editing.id)
        : editing.type === "project" ? detail.project
          : [...detail.milestones, ...detail.work_items, ...detail.references].find((item) => item.id === editing.id);
      if (!latest) throw new Error("missing_latest");
      const changed = schemas[editing.type].filter(([name]) => JSON.stringify(editing[name]) !== JSON.stringify(latest[name]));
      const summary = changed.map(([name, label]) => `${label}: ${editing[name] || "—"} → ${latest[name] || "—"}`).join(" / ");
      editing = { ...editing, version: latest.version };
      el("workspace-message").textContent = `競合しました。最新との差分: ${summary || "version が変わりました"}。入力を保ったまま「変更を確認」を押してください。`;
    } catch { el("workspace-message").textContent = "競合しました。入力は残しています。画面を更新してから再確認してください。"; }
  }
  el("workspace-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    preview = null;
    el("workspace-preview").hidden = true;
    const kind = el("workspace-type").value;
    if (!["project", "source"].includes(kind) && !projectId) { el("workspace-message").textContent = "先に案件を作成してください"; return; }
    const data = Object.fromEntries(new FormData(el("workspace-form")).entries());
    delete data["reason"];
    if (kind === "project") data.owner_id = memberId;
    const request = { operation_id: crypto.randomUUID(), action: editing ? "update" : "create",
      type: kind, id: editing ? editing.id : null, project_id: ["project", "source"].includes(kind) ? null : projectId,
      version: editing ? editing.version : null, data, reason: el("workspace-reason").value };
    try {
      preview = await api(`/api/workspaces/${workspaceId}/commands/preview`, { method: "POST", body: JSON.stringify(request) });
      showDiff();
    } catch (error) {
      if (error.status === 409) await showConflict();
      else el("workspace-message").textContent = "入力を確認してください。保存していません。";
    }
  });
  el("workspace-apply").addEventListener("click", async () => {
    if (!preview) return;
    try {
      const saved = await api(`/api/workspaces/${workspaceId}/commands/apply`, { method: "POST", body: JSON.stringify(preview) });
      if (saved.type === "project") projectId = saved.id;
      editing = null;
      preview = null;
      lastFetchProjectId = null;
      lastFetchResults = null;
      el("workspace-preview").hidden = true;
      el("workspace-message").textContent = "保存しました";
      await refresh();
    } catch (error) {
      if (error.status === 409) await showConflict();
      else el("workspace-message").textContent = "保存できませんでした。入力は残しています。";
    }
  });
  el("workspace-cancel").addEventListener("click", () => { preview = null; el("workspace-preview").hidden = true; });
  window.addEventListener("beforeunload", (event) => {
    if (workspaceId && (preview || formState() !== formBaseline)) event.preventDefault();
  });
  renderFields();
  return { load };
})();
