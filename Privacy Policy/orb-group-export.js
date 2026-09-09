/* ===========================================================================
   orb-group-export.js  -  "Download" button for a group's People tab
   ---------------------------------------------------------------------------
   Adds a Download button to the People toolbar on /admin/group/<groupId>,
   sitting between the "..." more-actions dropdown and "Assign people". It
   pages through every member of the group, then opens the same column-picker
   overlay used by OEL Preview so the admin chooses which Okta profile
   attributes become CSV columns.

   Okta renders that toolbar as:

     <div class="advanced-search-component-wrap">
       <a class="assign-people-button button-primary link-button">Assign people</a>
       <div class="group-member-toolbar-dropdown"> ... </div>
     </div>

   Note the DOM order is the reverse of what you see on screen, because the
   console floats these controls. Inserting our button BETWEEN those two nodes
   therefore lands it between them visually as well, whichever way the console
   floats them. We also copy the sibling's computed float so the button joins
   the same row instead of dropping below it.

   Members come from the public list-group-members endpoint:

       GET /api/v1/groups/{groupId}/users?limit=200

   which is Link-header paginated exactly like /api/v1/users, so the paging
   loop matches oel-preview.js.

   Load order in the extension manifest / injected scripts:
       1. okta-rule-builder.js
       2. oel-preview.js
       3. orb-rule-viewer.js
       4. orb-group-export.js   (this file, defines window.orbGroupExport)
       5. orb-plugin.js         (mounts it)

   Exposes: window.orbGroupExport.inject(host)

     host = {
       getJSON:  fn(url)->Promise,   // optional, host GET
       getLinks: fn(header)->{},     // optional, host Link-header parser
     }

   Both are optional. Without them the module falls back to its own fetch()
   implementations against location.origin, so it also runs standalone.
=========================================================================== */
(function () {
  "use strict";

  /* =========================================================================
     TUNABLES
  ========================================================================= */
  // Members requested per page. Okta clamps oversized limits server side, and
  // 200 is the value the rest of ORB already pages with, so we stay consistent
  // and comfortably inside the cap. Raising it only reduces request count.
  const MEMBERS_PAGE_LIMIT = 200;

  /* =========================================================================
     SELECTORS AND MARKERS
  ========================================================================= */
  const GROUP_ID_RE = /^\/admin\/group\/([^\/?#]+)/;
  const TOOLBAR_SEL = ".advanced-search-component-wrap";
  const ASSIGN_SEL = "a.assign-people-button";
  const DROPDOWN_SEL = ".group-member-toolbar-dropdown";
  const MARK = "orb-group-export-button";

  const _headers = { "X-Okta-User-Agent-Extended": "orb-plugin" };

  let _host = {};
  let _observer = null;
  let _tick = false;

  /* =========================================================================
     HTTP  -  host helpers when supplied, otherwise plain fetch
  ========================================================================= */
  // Pagination needs the Link response header, which a JSON-only getJSON
  // discards, so member paging always goes through fetch directly. Same
  // relative-URL and headers convention as the rest of ORB.
  function fetchPage(url) {
    return fetch(location.origin + url, {
      headers: _headers,
      credentials: "include",
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (body) {
          throw new Error(errFrom(res.status, body));
        });
      }
      return res.json().then(function (data) {
        return { data: data, linkHeader: res.headers.get("Link") };
      });
    });
  }

  function getJSON(url) {
    if (typeof _host.getJSON === "function") {
      return Promise.resolve(_host.getJSON(url));
    }
    return fetch(location.origin + url, {
      headers: _headers,
      credentials: "include",
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (body) {
          throw new Error(errFrom(res.status, body));
        });
      }
      return res.json();
    });
  }

  function errFrom(status, body) {
    let msg = "HTTP " + status;
    try {
      const j = JSON.parse(body);
      if (j.errorSummary) msg = j.errorSummary;
      if (j.errorCauses && j.errorCauses.length && j.errorCauses[0].errorSummary) {
        msg = j.errorCauses[0].errorSummary;
      }
    } catch (e) {}
    return msg;
  }

  // Same shape as rockstar's getLinks, so { next: url, self: url, ... }.
  function parseLinks(linkHeader) {
    if (typeof _host.getLinks === "function") return _host.getLinks(linkHeader);
    const links = {};
    if (!linkHeader) return links;
    linkHeader.split(/, */).forEach(function (part) {
      const m = part.match(/<(.*)>; *rel="(.*)"/);
      if (m) links[m[2]] = m[1];
    });
    return links;
  }

  // Turn anything we might catch into something readable. Mirrors
  // oel-preview.js so a jqXHR-style rejection never surfaces as
  // "[object Object]".
  function describeError(e) {
    if (e == null) return "Unknown error.";
    if (typeof e === "string") return e;
    if (e instanceof Error && e.message) return e.message;
    const okta = e.responseJSON || safeParse(e.responseText);
    if (okta) {
      if (okta.errorCauses && okta.errorCauses.length && okta.errorCauses[0].errorSummary) {
        return okta.errorCauses
          .map(function (c) { return c.errorSummary; })
          .join("; ");
      }
      if (okta.errorSummary) return okta.errorSummary;
    }
    if (typeof e.status === "number") {
      const statusText = e.statusText && e.statusText !== "error" ? " " + e.statusText : "";
      return "HTTP " + e.status + statusText +
        (e.status === 0 ? " (request blocked or network error)" : "");
    }
    if (e.message) return e.message;
    try { return JSON.stringify(e); } catch (_) { return String(e); }
  }
  function safeParse(t) { try { return t ? JSON.parse(t) : null; } catch (e) { return null; } }

  /* =========================================================================
     MINIMAL DOM HELPER  (mirrors oel-preview.js's h())
  ========================================================================= */
  const SVG_TAGS = new Set(["svg", "line", "rect", "path", "polyline", "polygon", "circle"]);
  const UNITLESS = new Set(["opacity", "fontWeight", "lineHeight", "zIndex", "flex", "flexGrow", "flexShrink", "order"]);

  function h(tag, props) {
    const children = Array.prototype.slice.call(arguments, 2);
    const el = SVG_TAGS.has(tag)
      ? document.createElementNS("http://www.w3.org/2000/svg", tag)
      : document.createElement(tag);
    if (props) {
      for (const key in props) {
        const val = props[key];
        if (val == null || val === false) continue;
        if (key === "style" && typeof val === "object") applyStyle(el, val);
        else if (key === "className") el.setAttribute("class", val);
        else if (/^on[A-Z]/.test(key)) el.addEventListener(key.slice(2).toLowerCase(), val);
        else if (key === "value") el.value = val;
        else if (key === "checked") el.checked = !!val;
        else if (key === "disabled") el.disabled = val;
        else if (key === "spellcheck") el.spellcheck = val;
        else el.setAttribute(camelToAttr(key), val);
      }
    }
    appendChildren(el, children);
    return el;
  }
  function camelToAttr(k) {
    return k === "viewBox" ? k : k.replace(/[A-Z]/g, function (m) { return "-" + m.toLowerCase(); });
  }
  function applyStyle(el, styleObj) {
    for (const prop in styleObj) {
      let v = styleObj[prop];
      if (typeof v === "number" && !UNITLESS.has(prop)) v = v + "px";
      el.style[prop] = v;
    }
  }
  function appendChildren(el, children) {
    for (const child of children) {
      if (child == null || child === false || child === true) continue;
      if (Array.isArray(child)) appendChildren(el, child);
      else if (child instanceof Node) el.appendChild(child);
      else el.appendChild(document.createTextNode(String(child)));
    }
  }
  function icon(children, size) {
    return h("svg", {
      width: size || 16, height: size || 16, viewBox: "0 0 24 24", fill: "none",
      stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
    }, children);
  }
  const IconDownload = function (s) {
    return icon([
      h("path", { d: "M12 3v12" }),
      h("polyline", { points: "7 10 12 15 17 10" }),
      h("path", { d: "M5 21h14" }),
    ], s);
  };

  /* =========================================================================
     SHARED VISUAL LANGUAGE  (same palette as the Rule Builder and OEL Preview)
  ========================================================================= */
  const C = {
    bg: "#ffffff", panel: "#ffffff", panel2: "#ededed",
    border: "#000000", text: "#000000", dim: "#324548",
    and: "#0066FF", or: "#ff6f0f", red_accent: "#ffc4c4",
    accent: "#0066FF", output: "#c1ecf9", outputtext: "#000000",
    good: "#1f7a3d", text_light: "#ffffff",
  };

  function primaryButton(label, iconEl, onClick, enabled) {
    return h("button", {
      onClick: onClick,
      disabled: !enabled,
      style: {
        display: "flex", alignItems: "center", gap: 6,
        background: enabled ? C.accent : C.panel2,
        color: enabled ? C.text_light : C.dim,
        border: "1px solid " + C.border, borderRadius: 8,
        cursor: enabled ? "pointer" : "not-allowed", opacity: enabled ? 1 : 0.6,
        fontSize: 13, padding: "9px 16px", fontWeight: 700,
      },
    }, iconEl, label);
  }

  function linkBtn(label, onClick) {
    return h("button", {
      onClick: onClick,
      style: {
        background: "transparent", color: C.accent, border: "none",
        cursor: "pointer", fontSize: 12, fontWeight: 700, padding: 0,
      },
    }, label);
  }

  function errorBox(text) {
    return h("div", {
      style: {
        marginTop: 14, background: C.red_accent, border: "1px solid " + C.border,
        borderRadius: 10, padding: 12, color: C.text, fontSize: 13, lineHeight: 1.5,
      },
    }, text);
  }

  const sectionLabel = function (text) {
    return h("div", {
      style: {
        fontSize: 12, textTransform: "uppercase", letterSpacing: "1px",
        color: C.dim, fontWeight: 600, margin: "14px 0 6px",
      },
    }, text);
  };

  /* =========================================================================
     COLUMN MODEL

     Two families of column, each described by { key, header, get(user) } so
     the CSV builder does not care where a value came from:

       1. USER RECORD fields, the top-level properties of an Okta user object
          (id, status, lastLogin and friends). The People table shows Status,
          so it is checked by default.
       2. PROFILE attributes, discovered from the members themselves. This is
          the same picker OEL Preview offers.
  ========================================================================= */
  const RECORD_FIELDS = [
    { key: "rec:id", header: "id", get: function (u) { return u.id; } },
    { key: "rec:status", header: "status", get: function (u) { return u.status; } },
    { key: "rec:type", header: "userType", get: function (u) { return u.type && (u.type.id || u.type.name); } },
    { key: "rec:created", header: "created", get: function (u) { return u.created; } },
    { key: "rec:activated", header: "activated", get: function (u) { return u.activated; } },
    { key: "rec:statusChanged", header: "statusChanged", get: function (u) { return u.statusChanged; } },
    { key: "rec:lastLogin", header: "lastLogin", get: function (u) { return u.lastLogin; } },
    { key: "rec:lastUpdated", header: "lastUpdated", get: function (u) { return u.lastUpdated; } },
    { key: "rec:passwordChanged", header: "passwordChanged", get: function (u) { return u.passwordChanged; } },
  ];
  const RECORD_DEFAULTS = new Set(["rec:status"]);

  // Standard Okta base-profile attributes, in Okta's own base-schema order.
  // Any of these present on the members are pinned to the front of the column
  // list so exports lead with the familiar fields. Everything else (custom
  // schema properties) follows, sorted alphabetically for predictability.
  const STANDARD_PROFILE_ATTRS = [
    "login", "email", "secondEmail", "firstName", "lastName", "middleName",
    "honorificPrefix", "honorificSuffix", "title", "displayName", "nickName",
    "profileUrl", "primaryPhone", "mobilePhone", "streetAddress", "city",
    "state", "zipCode", "countryCode", "postalAddress", "preferredLanguage",
    "locale", "timezone", "userType", "employeeNumber", "costCenter",
    "organization", "division", "department", "managerId", "manager",
  ];
  const PROFILE_DEFAULTS = new Set(["firstName", "lastName", "displayName", "login", "email"]);

  // Collect the union of every profile attribute key present across the
  // members. Members can carry different attributes (custom schema
  // properties, optionals some users lack), so no single profile can
  // enumerate the columns on its own.
  function collectProfileAttributes(users) {
    const present = new Set();
    users.forEach(function (u) {
      const p = u.profile || {};
      for (const k in p) {
        if (Object.prototype.hasOwnProperty.call(p, k)) present.add(k);
      }
    });
    const standard = STANDARD_PROFILE_ATTRS.filter(function (k) { return present.has(k); });
    const standardSet = new Set(standard);
    const custom = Array.from(present)
      .filter(function (k) { return !standardSet.has(k); })
      .sort();
    return standard.concat(custom);
  }

  function profileColumn(attr) {
    return {
      key: "prof:" + attr,
      header: attr,
      get: function (u) { return (u.profile || {})[attr]; },
    };
  }

  /* =========================================================================
     CSV
  ========================================================================= */
  // Render one value into a single cell. Scalars pass through as strings,
  // arrays (multi-value attributes) join with "; ", and objects are
  // JSON-stringified so nothing is silently dropped.
  function csvCellValue(v) {
    if (v == null) return "";
    if (Array.isArray(v)) {
      return v.map(function (x) { return x == null ? "" : String(x); }).join("; ");
    }
    if (typeof v === "object") {
      try { return JSON.stringify(v); } catch (e) { return String(v); }
    }
    return String(v);
  }

  // A record field and a custom profile attribute can share a name, so number
  // any repeats rather than emitting two identical headers.
  function dedupeHeaders(hs) {
    const seen = Object.create(null);
    return hs.map(function (hd) {
      if (!seen[hd]) { seen[hd] = 1; return hd; }
      seen[hd] += 1;
      return hd + " (" + seen[hd] + ")";
    });
  }

  // Every field is quoted and embedded quotes are doubled, per RFC 4180, so
  // values containing commas, quotes, or newlines survive intact. A leading
  // BOM makes Excel open the file as UTF-8.
  function buildCsv(users, columns) {
    const esc = function (v) {
      return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
    };
    const rows = [dedupeHeaders(columns.map(function (c) { return c.header; }))];
    users.forEach(function (u) {
      rows.push(columns.map(function (c) { return csvCellValue(c.get(u)); }));
    });
    return "\uFEFF" + rows.map(function (r) { return r.map(esc).join(","); }).join("\r\n");
  }

  function safeName(s) {
    return String(s || "")
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  }

  function downloadCsv(users, columns, groupName, groupId) {
    if (!users.length || !columns.length) return;
    const blob = new Blob([buildCsv(users, columns)], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const label = safeName(groupName) || safeName(groupId) || "group";
    const a = h("a", { href: url, download: "group-members-" + label + "-" + stamp + ".csv" });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  /* =========================================================================
     MEMBER LOADING

     Pages /api/v1/groups/{groupId}/users, following the Link header's rel=next
     until it runs out. `st.cancelled` is checked between pages so closing the
     overlay stops a long scan instead of leaving it running in the background.
  ========================================================================= */
  async function loadMembers(groupId, st, onProgress) {
    let url = "/api/v1/groups/" + encodeURIComponent(groupId) +
      "/users?limit=" + MEMBERS_PAGE_LIMIT;
    const users = [];
    while (url) {
      if (st.cancelled) break;
      const page = await fetchPage(url);
      const data = Array.isArray(page.data) ? page.data : [];
      for (const u of data) users.push(u);
      onProgress(users.length);
      if (st.cancelled) break;
      const links = parseLinks(page.linkHeader);
      if (links.next) {
        const nextUrl = new URL(links.next);
        url = nextUrl.pathname + nextUrl.search;
      } else {
        url = null;
      }
    }
    return users;
  }

  /* =========================================================================
     OVERLAY

     Same modal shell as OEL Preview's column picker, with one extra phase in
     front of it. We cannot list the available columns until we know which
     attributes the members carry, so the overlay opens in a loading phase that
     reports progress, then swaps in the picker.
  ========================================================================= */
  let _overlay = null;
  let _panelEl = null;
  let _state = null;

  function closeOverlay() {
    if (_state) _state.cancelled = true;
    if (_overlay && _overlay.parentNode) _overlay.parentNode.removeChild(_overlay);
    _overlay = null;
    _panelEl = null;
    _state = null;
    document.removeEventListener("keydown", onOverlayKey);
  }
  function onOverlayKey(e) { if (e.key === "Escape") closeOverlay(); }

  function overlayHeader(st) {
    return h("div", {
      style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
    },
      h("h2", { style: { fontSize: 18, margin: 0, fontWeight: 700 } }, "Download group members"),
      h("button", {
        onClick: closeOverlay, title: "Close",
        style: {
          background: "transparent", border: "none", cursor: "pointer",
          fontSize: 20, lineHeight: 1, color: C.dim,
        },
      }, "\u00D7")
    );
  }

  function subtitle(st, text) {
    return h("p", {
      id: "orb-ge-subtitle",
      style: { color: C.dim, fontSize: 13, margin: "0 0 12px" },
    }, text);
  }

  function groupLabel(st) {
    return st.groupName ? '"' + st.groupName + '"' : "this group";
  }

  function loadingBody(st) {
    return [
      subtitle(st, "Reading the members of " + groupLabel(st) + " from Okta."),
      h("div", {
        id: "orb-ge-progress",
        style: { fontSize: 13, color: C.dim, fontWeight: 600, padding: "10px 0 4px" },
      }, st.fetched.toLocaleString() + " members loaded"),
      h("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: 16 } },
        linkBtn("Cancel", closeOverlay))
    ];
  }

  function errorBody(st) {
    return [
      subtitle(st, "Okta rejected the request for this group's members."),
      errorBox(st.error),
      h("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: 16 } },
        linkBtn("Close", closeOverlay))
    ];
  }

  function pickerBody(st) {
    const users = st.users;
    if (!users.length) {
      return [
        subtitle(st, "Okta returned no members for " + groupLabel(st) + ", so there is nothing to export."),
        h("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: 16 } },
          linkBtn("Close", closeOverlay))
      ];
    }

    // One flat list of column descriptors, split into the two display groups.
    const profileAttrs = collectProfileAttributes(users);
    const profileCols = profileAttrs.map(profileColumn);
    const allCols = RECORD_FIELDS.concat(profileCols);

    // Defaults mirror OEL Preview's export, plus Status because the People
    // table shows it. If none of the preferred profile attributes exist on
    // these members, fall back to checking every profile attribute so the
    // admin still gets a usable file with one click.
    const checks = {};
    RECORD_FIELDS.forEach(function (c) { checks[c.key] = RECORD_DEFAULTS.has(c.key); });
    profileCols.forEach(function (c) { checks[c.key] = PROFILE_DEFAULTS.has(c.header); });
    const anyProfileChecked = profileCols.some(function (c) { return checks[c.key]; });
    if (!anyProfileChecked) profileCols.forEach(function (c) { checks[c.key] = true; });

    const boxStyle = {
      display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
      borderRadius: 8, cursor: "pointer", fontSize: 16, color: C.text,
    };
    const gridStyle = {
      display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
      gap: 4, overflowY: "auto",
      border: "1px solid " + C.border, borderRadius: 10, padding: 10, background: "#ffffff",
    };

    const checkbox = function (col) {
      return h("label", { style: boxStyle },
        h("input", {
          type: "checkbox",
          checked: checks[col.key],
          "data-orb-col": col.key,
          onChange: function (e) { checks[col.key] = e.target.checked; },
        }),
        h("span", {
          style: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
        }, col.header)
      );
    };

    const recordGrid = h("div", { style: gridStyle }, RECORD_FIELDS.map(checkbox));
    const profileGrid = h("div",
      { style: Object.assign({}, gridStyle, { maxHeight: "40vh" }) },
      profileCols.length
        ? profileCols.map(checkbox)
        : h("p", { style: { color: C.dim, fontSize: 13, margin: 0 } },
            "No profile attributes were found on these members.")
    );

    const setAll = function (val) {
      allCols.forEach(function (c) { checks[c.key] = val; });
      [recordGrid, profileGrid].forEach(function (g) {
        g.querySelectorAll("input[type=checkbox]").forEach(function (cb) { cb.checked = val; });
      });
    };

    return [
      subtitle(st,
        "Select the columns to include. " +
        users.length.toLocaleString() + (users.length === 1 ? " member" : " members") +
        " of " + groupLabel(st) + " will be exported."),
      h("div", { style: { display: "flex", gap: 12, marginBottom: 8 } },
        linkBtn("Select all", function () { setAll(true); }),
        linkBtn("Clear all", function () { setAll(false); })),
      sectionLabel("User record"),
      recordGrid,
      sectionLabel("Profile attributes"),
      profileGrid,
      h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 } },
        primaryButton("Generate .csv", IconDownload(15), function () {
          const chosen = allCols.filter(function (c) { return checks[c.key]; });
          if (!chosen.length) return;
          downloadCsv(users, chosen, st.groupName, st.groupId);
          closeOverlay();
        }, true))
    ];
  }

  function renderOverlay(st) {
    if (!_panelEl) return;
    _panelEl.textContent = "";
    appendChildren(_panelEl, [overlayHeader(st)]);
    const body =
      st.phase === "loading" ? loadingBody(st) :
      st.phase === "error" ? errorBody(st) :
      pickerBody(st);
    appendChildren(_panelEl, body);
  }

  function mountOverlay(st) {
    _panelEl = h("div", {
      onClick: function (e) { e.stopPropagation(); },
      style: {
        background: C.panel, color: C.text, border: "1px solid " + C.border,
        borderRadius: 14, padding: 20, width: "min(680px, 92vw)",
        boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
        fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
      },
    });
    _overlay = h("div", {
      onClick: closeOverlay,
      style: {
        position: "fixed", inset: 0, zIndex: 2147483000,
        background: "rgba(0,0,0,0.45)", display: "flex",
        alignItems: "center", justifyContent: "center", padding: 20,
      },
    }, _panelEl);
    renderOverlay(st);
    document.body.appendChild(_overlay);
    document.addEventListener("keydown", onOverlayKey);
  }

  /* =========================================================================
     EXPORT FLOW
  ========================================================================= */
  function openExport(groupId) {
    closeOverlay();
    const st = {
      groupId: groupId,
      groupName: null,
      phase: "loading",
      fetched: 0,
      users: [],
      error: null,
      cancelled: false,
    };
    _state = st;
    mountOverlay(st);

    // The group's display name is only used for the heading and the filename,
    // so a failure here is not worth surfacing. Patch the subtitle in place
    // rather than re-rendering, to avoid disturbing the picker if the name
    // lands late.
    getJSON("/api/v1/groups/" + encodeURIComponent(groupId))
      .then(function (g) {
        if (st.cancelled || _state !== st) return;
        const name = g && g.profile && g.profile.name;
        if (!name) return;
        st.groupName = name;
        const sub = _panelEl && _panelEl.querySelector("#orb-ge-subtitle");
        if (sub) {
          sub.textContent = sub.textContent.replace("this group", '"' + name + '"');
        }
      })
      .catch(function () {});

    loadMembers(groupId, st, function (count) {
      st.fetched = count;
      if (st.cancelled || _state !== st) return;
      const el = _panelEl && _panelEl.querySelector("#orb-ge-progress");
      if (el) el.textContent = count.toLocaleString() + " members loaded";
    })
      .then(function (users) {
        if (st.cancelled || _state !== st) return;
        st.users = users;
        st.phase = "ready";
        renderOverlay(st);
      })
      .catch(function (e) {
        if (st.cancelled || _state !== st) return;
        st.error = describeError(e);
        st.phase = "error";
        renderOverlay(st);
      });
  }

  /* =========================================================================
     BUTTON INJECTION
  ========================================================================= */
  function currentGroupId() {
    const m = GROUP_ID_RE.exec(location.pathname);
    return m ? m[1] : null;
  }

  function buildButton(groupId, anchor) {
    // Reusing Okta's own button-primary and link-button classes is what makes
    // this match "Assign people" exactly, including hover and focus states.
    // We deliberately leave off assign-people-button, since that class is the
    // console's own hook for its click handler.
    const btn = h("a", {
      href: "#",
      "data-se": "button",
      className: "button-primary link-button " + MARK,
      title: "Download every user in this group as a CSV",
    }, "Download");

    // The console floats these controls, so copy the sibling's float to stay on
    // the same row. Horizontal margin on both sides keeps the spacing even
    // whichever neighbour ends up on which side.
    if (anchor) {
      const f = window.getComputedStyle(anchor).float;
      if (f && f !== "none") btn.style.float = f;
    }
    btn.style.margin = "0 8px";

    btn.addEventListener("click", function (e) {
      e.preventDefault();
      openExport(groupId);
    });
    return btn;
  }

  function tryInject() {
    const groupId = currentGroupId();
    if (!groupId) return;

    const wrap = document.querySelector(TOOLBAR_SEL);
    if (!wrap) return;
    if (wrap.querySelector("." + MARK)) return; // already added

    const assign = wrap.querySelector(ASSIGN_SEL);
    const dropdown = wrap.querySelector(DROPDOWN_SEL);
    // Both of these are People-tab controls. Requiring one of them keeps the
    // button off the group's other tabs, which reuse the same wrapper class.
    if (!assign && !dropdown) return;

    const btn = buildButton(groupId, assign || dropdown);
    if (dropdown) wrap.insertBefore(btn, dropdown);
    else assign.parentNode.insertBefore(btn, assign.nextSibling);
  }

  // The console re-renders this toolbar on tab switches, search, and paging,
  // so watch for it instead of injecting once. Coalesced onto a single frame
  // because a subtree observer on body fires in bursts.
  function schedule() {
    if (_tick) return;
    _tick = true;
    requestAnimationFrame(function () {
      _tick = false;
      tryInject();
    });
  }

  function inject(host) {
    _host = host || {};
    tryInject();
    if (_observer) return; // inject() can run again on SPA navigation
    _observer = new MutationObserver(schedule);
    _observer.observe(document.body, { childList: true, subtree: true });
  }

  if (typeof window !== "undefined") {
    window.orbGroupExport = {
      inject: inject,
      // Exposed for manual testing from the console.
      openExport: openExport,
      buildCsv: buildCsv,
      collectProfileAttributes: collectProfileAttributes,
    };
  }
})();
