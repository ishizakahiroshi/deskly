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
  let workspaceRole = null;
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
  let selectedContactId = null;
  const contactOperationIds = new Map();
  const contactLinkNotices = new Map();
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
      if (member.role !== "owner") {
        if (member.active) {
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
        }
        if (member.active || member.credential_revocation_pending) {
          const recovering = !member.active;
          const deactivate = text("button", recovering ? "残った資格情報を失効" : "メンバーを無効化",
            "secondary-button");
          deactivate.type = "button";
          const reason = document.createElement("input");
          reason.placeholder = recovering ? "失効確認の理由" : "無効化の理由";
          reason.maxLength = 240;
          reason.setAttribute("aria-label", `${member.name}の${recovering ? "資格情報失効" : "無効化"}理由`);
          deactivate.addEventListener("click", async () => {
            if (!reason.value.trim()) { el("workspace-access-message").textContent = "理由を入力してください"; return; }
            const confirmation = recovering
              ? `${member.name}の残存資格情報を失効し、確認記録を追加します。続けますか？`
              : `${member.name}を無効化します。担当中の仕事は管理者へ引き継がれます。続けますか？`;
            if (!window.confirm(confirmation)) return;
            deactivate.disabled = true;
            try {
              await api(`/api/workspaces/${workspaceId}/access/members/${member.member_id}/deactivate`, {
                method: "POST", body: JSON.stringify({ expected_version: member.version,
                  operation_id: crypto.randomUUID(), reason: reason.value }),
              });
              await refreshAccess();
              el("workspace-access-message").textContent = recovering
                ? "資格情報を失効し、確認を記録しました"
                : "メンバーを無効化しました";
            } catch (error) {
              await refreshAccess().catch(() => {});
              el("workspace-access-message").textContent = error.status === 409
                ? "状態が変わりました。台帳を再読込して確認してください。"
                : "無効化または資格情報の失効を完了できませんでした。状態を確認してください。";
            } finally { deactivate.disabled = false; }
          });
          box.append(reason, deactivate);
        }
      }
      list.append(box);
    }
    await refreshSourceAccess();
  }
  async function refreshSourceAccess() {
    const container = el("workspace-source-access-list");
    container.replaceChildren();
    try {
      const state = await api(`/api/workspaces/${workspaceId}/access/sources`);
      if (!state.sources.length) {
        container.append(text("p", "登録済みの接続元はありません。"));
        return;
      }
      for (const source of state.sources) {
        const cardBox = text("article", "", "workspace-card workspace-source-access-card");
        cardBox.append(text("h4", `${source.label} · ${source.adapter}`));
        field(cardBox, "設定名", source.binding);
        const activeMembers = state.members.filter((member) => member.active && member.role !== "owner");
        if (!activeMembers.length) cardBox.append(text("p", "権限を設定できる有効なメンバーはいません。"));
        for (const member of activeMembers) {
          const grant = state.grants.find((item) => item.source_id === source.id && item.member_id === member.member_id);
          const form = document.createElement("form");
          form.className = "workspace-source-access-row";
          const label = text("label", `${member.name}にこの接続元を許可 `);
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = grant?.allowed === true;
          label.append(checkbox);
          const reasonLabel = text("label", "変更理由 ");
          const reason = document.createElement("input");
          reason.required = true;
          reason.maxLength = 240;
          reasonLabel.append(reason);
          const save = text("button", "接続元権限を保存");
          save.type = "submit";
          form.append(label, reasonLabel, save);
          let operation = null;
          form.addEventListener("submit", async (event) => {
            event.preventDefault();
            if (checkbox.checked === (grant?.allowed === true)) {
              el("workspace-access-message").textContent = "接続元権限に変更はありません";
              return;
            }
            const payload = { source_id: source.id, member_id: member.member_id, allowed: checkbox.checked,
              expected_version: grant?.version || 0, reason: reason.value.trim() };
            const fingerprint = JSON.stringify(payload);
            if (!operation || operation.fingerprint !== fingerprint) {
              operation = { fingerprint, id: crypto.randomUUID() };
            }
            save.disabled = true;
            try {
              await api(`/api/workspaces/${workspaceId}/access/source-grants`, { method: "POST",
                body: JSON.stringify({ ...payload, operation_id: operation.id }) });
              await refreshAccess();
              el("workspace-access-message").textContent = "接続元権限を保存しました。許可・取消は次の取得から反映されます。";
            } catch (error) {
              el("workspace-access-message").textContent = error.status === 403
                ? "権限を変更できません。ownerとして再ログインしてください。"
                : error.status === 409
                  ? "権限が他の操作で変更されました。最新状態を読み直します。"
                  : "接続元権限を保存できませんでした。通信状態を確認して再試行してください。";
              if (error.status === 409) await refreshAccess();
            } finally { save.disabled = false; }
          });
          cardBox.append(form);
        }
        container.append(cardBox);
      }
    } catch (error) {
      container.append(text("p", error.status === 403
        ? "接続元の権限設定はownerだけが確認できます。"
        : "接続元の権限設定を読み込めませんでした。再読込してください."));
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
    const [all, mine, counts] = await Promise.all([
      api(`${base}/projects`), api(`${base}/my-work`), api(`${base}/counts`),
    ]);
    memberId = all.member_id;
    memberName = all.member_name;
    sources = all.sources;
    projects = all.projects;
    el("workspace-status").textContent = `${all.workspace_name} · ${window.DesklySharedMode ? "共有" : "個人用"}`;
    const allBox = el("workspace-all");
    allBox.replaceChildren(text("h3", "全体"));
    const summary = text("section", "", "workspace-summary");
    summary.setAttribute("aria-label", "表示できる案件の集計");
    for (const [label, value] of [["案件", counts.projects], ["作業", counts.work_items],
      ["マイルストーン", counts.milestones], ["未確認", counts.unconfirmed_work_items]]) {
      const item = text("p", "", "workspace-summary-item");
      item.append(text("strong", value), text("span", label));
      summary.append(item);
    }
    const searchForm = text("form", "", "workspace-search");
    const searchLabel = text("label", "案件と作業を検索");
    const searchInput = document.createElement("input");
    searchInput.required = true;
    searchInput.maxLength = 100;
    searchInput.placeholder = "案件名、作業名、次の行動など";
    searchLabel.append(searchInput);
    const searchButton = text("button", "検索");
    searchButton.type = "submit";
    const searchResults = text("div", "", "workspace-search-results");
    searchResults.setAttribute("aria-live", "polite");
    searchForm.append(searchLabel, searchButton);
    searchForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      searchButton.disabled = true;
      searchResults.replaceChildren(text("p", "検索しています…"));
      try {
        const found = await api(`${base}/search/${encodeURIComponent(searchInput.value)}`);
        searchResults.replaceChildren();
        if (!found.results.length) searchResults.append(text("p", "一致する項目はありません。"));
        for (const row of found.results) {
          const button = text("button", `${row.project_name} · ${row.label}`, "workspace-search-result");
          button.type = "button";
          button.addEventListener("click", () => {
            projectId = row.project_id;
            selectedContactId = null;
            showTab("detail");
            refreshDetail();
          });
          searchResults.append(button);
        }
        if (found.truncated) searchResults.append(text("p", "先頭100件を表示しています。"));
      } catch { searchResults.replaceChildren(text("p", "検索できませんでした。")); }
      finally { searchButton.disabled = false; }
    });
    allBox.append(summary, searchForm, searchResults);
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
        selectedContactId = null;
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
    if (projectId && !all.projects.some((project) => project.id === projectId)) {
      projectId = null;
      selectedContactId = null;
    }
    if (!projectId && all.projects.length) {
      projectId = all.projects[0].id;
      selectedContactId = null;
    }
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
    if (window.DesklySharedMode) await renderSharedContacts(box, base, detail.project);
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
  async function renderSharedContacts(box, projectBase, project) {
    const section = document.createElement("section");
    section.className = "workspace-contacts";
    section.append(text("h4", "連絡"));
    const state = text("p", "連絡を読み込んでいます。", "workspace-contact-state");
    state.setAttribute("role", "status");
    state.setAttribute("aria-live", "polite");
    const layout = document.createElement("div");
    layout.className = "workspace-contact-layout";
    const list = document.createElement("div");
    list.className = "workspace-contact-list";
    const detailBox = document.createElement("article");
    detailBox.className = "workspace-contact-detail workspace-card";
    detailBox.append(text("p", "一覧から連絡を選んでください。", "muted"));
    section.append(state, layout);
    layout.append(list, detailBox);
    box.append(section);

    const ownerTools = configRoleOwner() ? buildContactOwnerTools(project.id) : null;
    if (ownerTools) section.append(ownerTools);

    try {
      const result = await api(`${projectBase}/contacts`);
      const messages = {
        no_references: "この案件には連絡の紐付けがありません。",
        not_connected: "連絡台帳に接続できていません。",
        not_found: "紐付け先の連絡が見つかりません。",
        fetch_failed: "連絡台帳の取得に失敗しました。再読込して確認してください。",
        partial: "一部の連絡を表示できません。接続状態を確認してください。",
      };
      if (result.status !== "connected" && result.status !== "partial") {
        state.textContent = messages[result.status] || "連絡を表示できません。";
        return;
      }
      list.replaceChildren();
      if (!result.contacts?.length) {
        state.textContent = messages[result.status] || "表示できる連絡はありません。";
        return;
      }
      state.textContent = result.status === "partial"
        ? messages.partial : `連絡 ${result.contacts.length} 件`;
      for (const contact of result.contacts) {
        const button = text("button", "", "workspace-contact-row");
        button.type = "button";
        button.setAttribute("aria-pressed", contact.id === selectedContactId ? "true" : "false");
        button.append(text("strong", `${contact.recipient || "宛先なし"} · ${contact.channel || "方法不明"}`));
        field(button, "送信日時", contact.sent_at);
        field(button, "状態", contact.state);
        field(button, "約束期限", contact.due);
        button.addEventListener("click", async () => {
          selectedContactId = contact.id;
          for (const row of list.children) row.setAttribute("aria-pressed", row === button ? "true" : "false");
          await loadSharedContact(projectBase, contact.id, detailBox);
        });
        list.append(button);
      }
      if (selectedContactId && result.contacts.some((contact) => contact.id === selectedContactId)) {
        await loadSharedContact(projectBase, selectedContactId, detailBox);
      } else {
        selectedContactId = null;
      }
    } catch (error) {
      state.textContent = error.status === 404
        ? "案件または連絡が見つかりません。権限が変更された可能性があります。"
        : "連絡の取得に失敗しました。再読込して確認してください。";
    }
    if (ownerTools) await refreshContactSources(ownerTools);
  }
  function configRoleOwner() { return workspaceRole === "owner"; }
  function operationIdFor(key, payload) {
    const fingerprint = JSON.stringify(payload);
    const prior = contactOperationIds.get(key);
    if (prior?.fingerprint === fingerprint) return prior.id;
    const id = crypto.randomUUID();
    contactOperationIds.set(key, { fingerprint, id });
    return id;
  }
  function contactRequestMessage(error, action) {
    if (error.status === 403 || error.message === "forbidden") return "この操作は管理者だけが実行できます。権限を確認してください。";
    if (error.status === 409) {
      if (error.message === "source_not_connected") return "指定した接続元は現在利用できません。設定名を確認してください。";
      if (error.message === "source_configuration_invalid") return "接続元の設定に問題があります。管理者が設定を確認してください。";
      if (error.message === "source_already_registered") return "この設定名の接続元は登録済みです。接続元一覧を再読込しました。";
      if (error.message === "contact_already_linked") return "この連絡はすでにこの案件へ紐付いています。連絡一覧を再読込しました。";
      if (error.message === "operation_conflict") return "同じ操作IDが異なる内容で使われました。入力内容を変更して再試行してください。";
      return "状態が変わったか、接続設定に問題があります。入力と一覧を再確認してください.";
    }
    if (error.status === 404) return action === "link"
      ? "案件・接続元・連絡が見つかりません。IDと権限を確認してください。"
      : "対象が見つかりません。接続元一覧を再読込してください。";
    if (!error.status) return "通信に失敗しました。入力を保持しています。同じ操作を再試行できます。";
    return action === "link"
      ? "紐付けに失敗しました。連絡一覧を再読込して確認してください。"
      : "接続元を登録できませんでした。設定名と接続設定を確認してください.";
  }
  function buildContactOwnerTools(currentProjectId) {
    const panel = document.createElement("div");
    panel.className = "workspace-contact-link";
    panel.append(text("h5", "連絡台帳の接続と案件への紐付け"));
    const sourceState = text("p", "接続元を読み込んでいます。", "workspace-contact-source-state");
    sourceState.setAttribute("role", "status");
    sourceState.setAttribute("aria-live", "polite");
    const sourceSelectLabel = text("label", "接続元 ");
    const sourceSelect = document.createElement("select");
    sourceSelect.setAttribute("aria-label", "連絡の接続元");
    sourceSelectLabel.append(sourceSelect);

    const registerForm = document.createElement("form");
    registerForm.className = "workspace-contact-register-form";
    registerForm.append(text("h6", "未登録の接続元を追加"));
    registerForm.append(text("p", "設定済みのbinding名を正確に入力してください。連絡台帳の設定候補一覧は取得しません。", "muted"));
    const bindingLabel = text("label", "設定名（binding） ");
    const binding = document.createElement("input");
    binding.type = "text";
    binding.maxLength = 64;
    binding.required = true;
    binding.autocomplete = "off";
    bindingLabel.append(binding);
    const sourceLabel = text("label", "接続元の表示名 ");
    const sourceName = document.createElement("input");
    sourceName.type = "text";
    sourceName.maxLength = 120;
    sourceName.required = true;
    sourceLabel.append(sourceName);
    const registerReasonLabel = text("label", "登録理由 ");
    const registerReason = document.createElement("input");
    registerReason.type = "text";
    registerReason.maxLength = 240;
    registerReason.required = true;
    registerReason.value = "会社Webで連絡を参照するため";
    registerReasonLabel.append(registerReason);
    const registerButton = text("button", "接続元を登録");
    registerButton.type = "submit";
    const registerState = text("p", "", "workspace-contact-operation-state");
    registerState.setAttribute("role", "status");
    registerState.setAttribute("aria-live", "polite");
    registerForm.append(bindingLabel, sourceLabel, registerReasonLabel, registerButton, registerState);

    const linkForm = document.createElement("form");
    linkForm.className = "workspace-contact-link-form";
    linkForm.append(text("h6", "既存の連絡をこの案件へ紐付け"));
    const contactIdLabel = text("label", "連絡ID ");
    const contactId = document.createElement("input");
    contactId.type = "text";
    contactId.maxLength = 80;
    contactId.required = true;
    contactId.autocomplete = "off";
    contactIdLabel.append(contactId);
    const contactLabelLabel = text("label", "表示名 ");
    const contactLabel = document.createElement("input");
    contactLabel.type = "text";
    contactLabel.maxLength = 160;
    contactLabel.required = true;
    contactLabelLabel.append(contactLabel);
    const linkReasonLabel = text("label", "紐付け理由 ");
    const linkReason = document.createElement("input");
    linkReason.type = "text";
    linkReason.maxLength = 240;
    linkReason.required = true;
    linkReason.value = "会社Webから案件に関連する連絡を参照するため";
    linkReasonLabel.append(linkReason);
    const linkButton = text("button", "選択した連絡を紐付け");
    linkButton.type = "submit";
    const linkState = text("p", "", "workspace-contact-operation-state");
    linkState.setAttribute("role", "status");
    linkState.setAttribute("aria-live", "polite");
    linkState.textContent = contactLinkNotices.get(currentProjectId) || "";
    linkForm.append(contactIdLabel, contactLabelLabel, linkReasonLabel, linkButton, linkState);

    registerForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      registerButton.disabled = true;
      const payload = { label: sourceName.value.trim(), binding: binding.value.trim(), reason: registerReason.value.trim() };
      const operation_id = operationIdFor("register-contact-source", payload);
      try {
        await api(`/api/workspaces/${workspaceId}/sources/contact`, {
          method: "POST", body: JSON.stringify({ ...payload, operation_id }),
        });
        contactOperationIds.delete("register-contact-source");
        registerState.textContent = "接続元を登録しました。";
        await panel._refreshSources();
      } catch (error) {
        registerState.textContent = contactRequestMessage(error, "register");
        if (error.status === 409) await panel._refreshSources();
      } finally { registerButton.disabled = false; }
    });
    linkForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!sourceSelect.value) {
        linkState.textContent = "先に連絡の接続元を登録してください。";
        return;
      }
      linkButton.disabled = true;
      const payload = { source_id: sourceSelect.value, contact_id: contactId.value.trim(),
        label: contactLabel.value.trim(), reason: linkReason.value.trim() };
      const key = `link-contact:${currentProjectId}`;
      const operation_id = operationIdFor(key, payload);
      try {
        const result = await api(`/api/workspaces/${workspaceId}/projects/${currentProjectId}/contacts/link`, {
          method: "POST", body: JSON.stringify({ ...payload, operation_id }),
        });
        contactOperationIds.delete(key);
        const notice = result.status === "linked" ? "連絡を案件へ紐付けました。" : "紐付け結果を確認してください。";
        contactLinkNotices.set(currentProjectId, notice);
        linkState.textContent = notice;
        await refreshDetail();
      } catch (error) {
        const notice = contactRequestMessage(error, "link");
        contactLinkNotices.set(currentProjectId, notice);
        linkState.textContent = notice;
        if (error.message === "contact_already_linked") {
          contactOperationIds.delete(key);
          await refreshDetail();
        }
      } finally { linkButton.disabled = false; }
    });

    panel.append(sourceState, sourceSelectLabel, registerForm, linkForm);
    panel._refreshSources = async () => {
      sourceSelect.replaceChildren(new Option("接続元を選択", ""));
      try {
        const result = await api(`/api/workspaces/${workspaceId}/sources/contact`);
        const sourceItems = result.sources || [];
        for (const source of sourceItems) {
          const option = new Option(`${source.label} · ${source.binding}`, source.id);
          sourceSelect.append(option);
        }
        sourceState.textContent = sourceItems.length
          ? `登録済みの連絡接続元 ${sourceItems.length} 件` : "連絡接続元は未登録です。設定済みbinding名を入力して登録してください。";
      } catch (error) {
        sourceState.textContent = error.status === 403
          ? "接続元一覧はownerだけが確認できます。権限を再確認してください。"
          : error.status === 409 ? "連絡台帳に接続できていません。構成を確認してください。"
            : "接続元一覧を取得できませんでした。再読込してください。";
      }
    };
    return panel;
  }
  async function refreshContactSources(panel) { await panel._refreshSources(); }
  async function loadSharedContact(projectBase, contactId, container) {
    container.replaceChildren(text("p", "本文を読み込んでいます。", "muted"));
    try {
      const result = await api(`${projectBase}/contacts/${encodeURIComponent(contactId)}`);
      if (result.status === "not_connected") {
        container.replaceChildren(text("p", "連絡台帳に接続できていません。"));
        return;
      }
      if (!result.contact) {
        container.replaceChildren(text("p", "連絡が見つかりません。"));
        return;
      }
      const contact = result.contact;
      container.replaceChildren(text("h5", `${contact.recipient || "宛先なし"} · ${contact.channel || "方法不明"}`));
      for (const [key, label] of [["sent_at", "送信日時"], ["state", "状態"], ["promise", "約束"],
        ["agreement", "合意"], ["basis", "根拠"], ["note", "補足"]]) {
        if (contact[key] !== undefined) field(container, label, contact[key]);
      }
      container.append(text("h6", "本文"), text("pre", contact.body || "本文はありません。", "workspace-contact-body"));
      if (contact.references) {
        field(container, "資料・参照", contact.references);
        if (isHttpsUrl(contact.references)) appendHttpsLink(container, contact.references, "資料を開く");
      }
      if (typeof contact.shared_url === "string" && contact.shared_url) {
        field(container, "共有URL", contact.shared_url);
        if (isHttpsUrl(contact.shared_url)) appendHttpsLink(container, contact.shared_url, "共有資料を開く");
      }
    } catch (error) {
      container.replaceChildren(text("p", error.status === 404
        ? "この連絡は見つからないか、閲覧権限がありません。"
        : "連絡詳細の取得に失敗しました。再読込して確認してください。"));
    }
  }
  function isHttpsUrl(value) {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" && !parsed.username && !parsed.password;
    } catch { return false; }
  }
  function appendHttpsLink(container, url, label) {
    let parsed;
    try { parsed = new URL(url); } catch { return; }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return;
    const link = text("a", label);
    link.href = parsed.href;
    link.rel = "noopener noreferrer";
    link.target = "_blank";
    container.append(link);
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
      workspaceRole = config.role;
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
