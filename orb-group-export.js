/* ===========================================================================
   orb-group-export.js  -  "Download" buttons for groups and app assignments
   ---------------------------------------------------------------------------
   Adds a Download button to three admin toolbars, then exports the group list,
   membership, or assignment list as a CSV with admin-chosen columns.

     PAGE                                        TOOLBAR ANCHOR
     /admin/groups                               in front of "Add group"
     /admin/group/<groupId>                      between the "..." dropdown
       People tab                                and "Assign people"
     /admin/app/<name>/instance/<appId>          between "Assign" and
       #tab-assignments                          "Convert assignments"

   These toolbars float their controls, and in the group People case the DOM
   order is the reverse of what you see on screen. Inserting our button BETWEEN
   the two neighbouring nodes therefore lands it between them visually as well,
   whichever way the console floats them. Where there is only one neighbour to
   sit beside, as on the groups list, the float direction is read at inject
   time to work out which side of it the left-hand slot actually is. We also
   copy the neighbour's computed float so the button joins the same row instead
   of dropping below it.

   ---------------------------------------------------------------------------
   WHY THIS IS FAST  (four changes borrowed from rockstar.js)

   An earlier build of this file paged every row BEFORE showing the column
   picker, so it could offer exactly the attributes the data carried. That is
   accurate and very slow. rockstar's export is quick because it does the
   opposite in four places, and this build now matches it:

     1. COLUMNS COME FROM THE SCHEMA, NOT THE DATA. One small read of
        /api/v1/meta/schemas/user/default enumerates every base and custom
        attribute in the org, so the picker paints immediately and nothing is
        fetched until the admin clicks Generate. Discovering the same list from
        the data meant scanning the whole group first.

     2. NO expand=user UNLESS IT IS ASKED FOR. Asking Okta to join a full user
        record onto every app assignment is the single most expensive thing a
        page can do. rockstar never asks, and reads the app-side fields
        instead. Here the Okta user columns still exist, but selecting one is
        what turns the expand on, so the default export stays cheap.

     3. BIG PAGES. Round-trip latency dominates, so page size is close to what
        each endpoint allows rather than a flat 200. Group members go 1,000 at
        a time and app users 500, which is roughly five and two and a half
        times fewer requests.

     4. STREAM ROWS INTO CSV TEXT. Because the columns are known before the
        fetch starts, each page converts straight to CSV lines and the raw JSON
        is dropped. Nothing accumulates a full copy of the directory in memory.

   Also adopted from rockstar: when a response reports fewer than
   RATE_LIMIT_FLOOR requests remaining, wait for the reset the header names
   rather than pressing on into a 429.

   ---------------------------------------------------------------------------
   EXPORT DESCRIPTORS

   Group members and app assignments share the overlay, the picker, the paging
   loop, and the CSV writer, and differ only in what they read and which
   columns they offer. Each page contributes a descriptor:

       {
         heading, filePart, subjectFallback,
         resolveName,      // fn -> Promise<string|null>
         sources: [ {
           id, label, filePart,
           noun,           // fn(count) -> "member" / "members"
           columnGroups,   // fn(ctx) -> [ { label, columns, note } ]
           stream,         // fn(st, chosen, emit) -> Promise
         } ]
       }

   Columns are plain descriptors, { key, header, path }, where `path` is a
   dotted lookup into the row. The CSV writer never needs to know whether a
   value came from a user record, a profile, or an assignment.

   ---------------------------------------------------------------------------
   ENDPOINTS

       GET /api/v1/meta/schemas/user/default
       GET /api/v1/meta/schemas/group/default
       GET /api/v1/meta/schemas/apps/{appId}/default
       GET /api/v1/groups?limit=1000[&expand=stats]
       GET /api/v1/groups/{groupId}/users?limit=1000
       GET /api/v1/apps/{appId}/users?limit=500[&expand=user]
       GET /api/v1/apps/{appId}/groups?limit=200&expand=group

   The list endpoints are Link-header paginated, so one paging helper covers
   them. If an org rejects an oversized limit, the helper retries that request
   once at a conservative size rather than failing the export.

   Load order in the extension manifest / injected scripts:
       1. okta-rule-builder.js
       2. oel-preview.js
       3. orb-rule-viewer.js
       4. orb-group-export.js   (this file, defines window.orbExport)
       5. orb-plugin.js         (mounts it)

   Exposes: window.orbExport.inject(host)
            window.orbGroupExport  (alias, kept for older mount code)

     host = {
       getJSON:        fn(url)->Promise,   // optional, host GET
       getLinks:       fn(header)->{},     // optional, host Link-header parser
       loadUserSchema: fn()->Promise,      // optional, host's cached schema
     }

   All are optional. Without them the module falls back to its own fetch()
   implementations against location.origin, so it also runs standalone.
=========================================================================== */
(function () {
  "use strict";

  /* =========================================================================
     TUNABLES
  ========================================================================= */
  // Page sizes, per endpoint, sized to what each one allows. Latency per
  // request dominates a large export, so these matter more than anything else
  // in this file. FALLBACK_LIMIT is what a request retries at if an org
  // rejects the larger value.
  const LIMIT_GROUP_USERS = 1000;
  const LIMIT_APP_USERS = 500;
  const LIMIT_APP_GROUPS = 200;
  const LIMIT_GROUPS = 1000;
  const FALLBACK_LIMIT = 200;

  // Pause paging when a response says this few requests are left in the
  // window, then resume once the reset time the header names has passed.
  const RATE_LIMIT_FLOOR = 10;
  const RATE_LIMIT_MAX_WAIT_MS = 65000;

  // Parallel reads when backfilling group names that came back without an
  // embedded group. Kept low, since this is a fallback path.
  const BACKFILL_CONCURRENCY = 8;

  /* =========================================================================
     SELECTORS AND MARKERS
  ========================================================================= */
  const GROUP_ID_RE = /^\/admin\/group\/([^\/?#]+)/;
  const APP_ID_RE = /^\/admin\/app\/[^\/?#]+\/instance\/([^\/?#]+)/;
  // The groups LIST page, not a single group. Anchored at the end so it never
  // collides with GROUP_ID_RE above.
  const GROUPS_LIST_RE = /^\/admin\/groups\/?$/;
  const MARK = "orb-export-button";

  const _headers = { "X-Okta-User-Agent-Extended": "orb-plugin" };

  let _host = {};
  let _observer = null;
  let _tick = false;

  /* =========================================================================
     HTTP  -  host helpers when supplied, otherwise plain fetch
  ========================================================================= */
  // Paging needs the Link header, and the rate-limit pause needs two more, so
  // this returns the response headers alongside the parsed body. A JSON-only
  // getJSON discards all three, which is why paging always uses fetch here.
  function fetchPage(url) {
    return fetch(location.origin + url, {
      headers: _headers,
      credentials: "include",
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (body) {
          const err = new Error(errFrom(res.status, body));
          err.status = res.status;
          throw err;
        });
      }
      return res.json().then(function (data) {
        return {
          data: data,
          linkHeader: res.headers.get("Link"),
          rateRemaining: res.headers.get("X-Rate-Limit-Remaining"),
          rateReset: res.headers.get("X-Rate-Limit-Reset"),
        };
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

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /* =========================================================================
     PAGING

     Follows rel=next until it runs out, handing each page straight to `emit`
     so the caller can turn rows into CSV text and drop the JSON. Three details
     matter for speed and reliability:

       - `buildUrl(limit)` lets one request retry at a smaller page size if the
         org rejects the large one, instead of failing the whole export.
       - The rate-limit headers are honoured, so a big export slows down rather
         than dying on a 429.
       - st.cancelled is checked between pages, so closing the overlay stops a
         long scan instead of leaving it running in the background.
  ========================================================================= */
  async function pageAll(buildUrl, limit, st, emit) {
    let url = buildUrl(limit);
    let firstRequest = true;

    while (url) {
      if (st.cancelled) return;

      let page;
      try {
        page = await fetchPage(url);
      } catch (e) {
        // One retry at a conservative page size, but only for the first
        // request. Later pages come from Okta's own next link, which already
        // carries a limit Okta issued.
        if (firstRequest && limit > FALLBACK_LIMIT && /limit/i.test(e.message || "")) {
          limit = FALLBACK_LIMIT;
          url = buildUrl(limit);
          page = await fetchPage(url);
        } else {
          throw e;
        }
      }
      firstRequest = false;

      const rows = Array.isArray(page.data) ? page.data : [];
      await emit(rows);
      if (st.cancelled) return;

      const links = parseLinks(page.linkHeader);
      if (!links.next) return;

      // Back off when the window is nearly spent, the way rockstar does.
      const remaining = parseInt(page.rateRemaining, 10);
      if (!isNaN(remaining) && remaining < RATE_LIMIT_FLOOR) {
        const resetAt = parseInt(page.rateReset, 10);
        let waitMs = isNaN(resetAt) ? 1000 : resetAt * 1000 - Date.now() + 500;
        waitMs = Math.max(0, Math.min(waitMs, RATE_LIMIT_MAX_WAIT_MS));
        if (waitMs) {
          st.waiting = true;
          if (st.onTick) st.onTick();
          await sleep(waitMs);
          st.waiting = false;
          if (st.cancelled) return;
        }
      }

      const next = new URL(links.next);
      url = next.pathname + next.search;
    }
  }

  // Bounded-concurrency map, used only by the group-name backfill.
  async function mapLimit(items, limit, fn) {
    let cursor = 0;
    const width = Math.min(limit, items.length);
    const workers = [];
    for (let w = 0; w < width; w++) {
      workers.push((async function () {
        while (cursor < items.length) {
          const idx = cursor++;
          await fn(items[idx], idx);
        }
      })());
    }
    await Promise.all(workers);
  }

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

  function tabButton(label, active, onClick) {
    return h("button", {
      onClick: onClick,
      style: {
        background: active ? C.accent : C.panel,
        color: active ? C.text_light : C.text,
        border: "1px solid " + C.border, borderRadius: 8,
        cursor: active ? "default" : "pointer",
        fontSize: 12, padding: "6px 14px", fontWeight: 700,
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

  function sectionLabel(text) {
    return h("div", {
      style: {
        fontSize: 12, textTransform: "uppercase", letterSpacing: "1px",
        color: C.dim, fontWeight: 600, margin: "14px 0 6px",
      },
    }, text);
  }

  function noteLine(text) {
    return h("div", {
      style: { fontSize: 12, color: C.dim, margin: "0 0 6px", lineHeight: 1.5 },
    }, text);
  }

  /* =========================================================================
     CSV
  ========================================================================= */
  // Dotted lookup, so a column can name credentials.userName or
  // _links.group.name without a bespoke getter. Same idea as rockstar's dot().
  function dot(obj, path) {
    let o = obj;
    const parts = path.split(".");
    for (let i = 0; i < parts.length; i++) {
      if (o == null) return undefined;
      o = o[parts[i]];
    }
    return o;
  }

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

  function esc(v) {
    return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
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

  // One row of CSV text. Every field is quoted and embedded quotes are
  // doubled, per RFC 4180, so values containing commas, quotes, or newlines
  // survive intact.
  function csvLine(row, columns) {
    return columns.map(function (c) {
      return esc(csvCellValue(c.get ? c.get(row) : dot(row, c.path)));
    }).join(",") + "\r\n";
  }

  function csvHeaderLine(columns) {
    return dedupeHeaders(columns.map(function (c) { return c.header; }))
      .map(esc).join(",") + "\r\n";
  }

  function safeName(s) {
    return String(s || "")
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  }

  // A leading BOM makes Excel open the file as UTF-8. Blob takes the array of
  // line strings directly, so the whole CSV is never concatenated into one
  // giant string first.
  function downloadLines(lines, parts) {
    const blob = new Blob(["\uFEFF"].concat(lines), { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const name = parts.map(safeName).filter(Boolean).concat(stamp).join("-");
    const a = h("a", { href: url, download: name + ".csv" });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  function formatBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  /* =========================================================================
     SCHEMAS  -  where the column list comes from

     Reading the schema instead of the data is what lets the picker open
     instantly. The user schema is the same document orb-plugin already caches
     for the Rule Builder, so on a group page it is usually free.
  ========================================================================= */

  // Okta's base-schema order, used only when the schema read fails, which
  // happens on accounts without permission to read it.
  const FALLBACK_PROFILE_ATTRS = [
    "login", "email", "secondEmail", "firstName", "lastName", "middleName",
    "honorificPrefix", "honorificSuffix", "title", "displayName", "nickName",
    "profileUrl", "primaryPhone", "mobilePhone", "streetAddress", "city",
    "state", "zipCode", "countryCode", "postalAddress", "preferredLanguage",
    "locale", "timezone", "userType", "employeeNumber", "costCenter",
    "organization", "division", "department", "managerId", "manager",
  ];
  const PROFILE_DEFAULTS = new Set(["login", "email", "firstName", "lastName", "displayName"]);

  // Base properties first, in the order Okta lists them, then custom ones.
  function schemaAttrs(schema) {
    const out = [];
    if (!schema || !schema.definitions) return out;
    ["base", "custom"].forEach(function (part) {
      const def = schema.definitions[part];
      const props = def && def.properties;
      for (const p in props) {
        if (!Object.prototype.hasOwnProperty.call(props, p)) continue;
        out.push(p);
      }
    });
    return out;
  }

  function loadUserSchema() {
    if (typeof _host.loadUserSchema === "function") {
      return Promise.resolve(_host.loadUserSchema()).catch(function () { return null; });
    }
    return getJSON("/api/v1/meta/schemas/user/default").catch(function () { return null; });
  }

  function loadAppUserSchema(appId) {
    return getJSON("/api/v1/meta/schemas/apps/" + encodeURIComponent(appId) + "/default")
      .catch(function () { return null; });
  }

  // The org's GROUP profile schema. Directory-sourced groups (AD, LDAP) carry
  // extra profile attributes beyond name and description, and this is where
  // they are named. Not every org exposes the endpoint, so a failure is fine.
  function loadGroupSchema() {
    return getJSON("/api/v1/meta/schemas/group/default")
      .catch(function () { return null; });
  }

  // Fallback for the app profile when its schema is unreadable. One row is
  // enough to learn the attribute names, and it costs a single tiny request.
  function sampleAppUserProfile(appId) {
    return getJSON("/api/v1/apps/" + encodeURIComponent(appId) + "/users?limit=1")
      .then(function (rows) {
        const p = rows && rows[0] && rows[0].profile;
        return p ? Object.keys(p).sort() : [];
      })
      .catch(function () { return []; });
  }

  /* =========================================================================
     COLUMN BUILDING BLOCKS
  ========================================================================= */
  // Fixed fields. Entries are [key, header, path] plus an optional trailing
  // true to check the box by default.
  function recordGroup(label, defs, note) {
    return {
      label: label,
      note: note,
      columns: defs.map(function (d) {
        return { key: d[0], header: d[1], path: d[2], checked: !!d[3] };
      }),
    };
  }

  // Attributes named by a schema. `root` is the dotted prefix they hang off,
  // so the same helper serves a user's own profile, an app user's profile, and
  // an expanded Okta user nested under _embedded.
  function attrGroup(label, attrs, opts) {
    const o = opts || {};
    return {
      label: label,
      note: o.note,
      emptyText: o.emptyText,
      expandsUser: !!o.expandsUser,
      columns: attrs.map(function (a) {
        return {
          key: (o.keyPrefix || "attr:") + a,
          header: (o.headerPrefix || "") + a,
          path: o.root + "." + a,
          checked: !!(o.defaults && o.defaults.has(a)),
          expandsUser: !!o.expandsUser,
        };
      }),
    };
  }

  function plural(n, one, many) { return n === 1 ? one : many; }

  /* =========================================================================
     DESCRIPTOR  -  group members

     One source. /api/v1/groups/{id}/users returns whole user records, so no
     expand is needed and every schema attribute is already present on the row.
  ========================================================================= */
  function groupMembersDescriptor(groupId) {
    return {
      heading: "Download group members",
      filePart: "group-members",
      subjectFallback: "this group",
      resolveName: function () {
        return getJSON("/api/v1/groups/" + encodeURIComponent(groupId))
          .then(function (g) { return (g && g.profile && g.profile.name) || null; })
          .catch(function () { return null; });
      },
      sources: [{
        id: "members",
        label: "People",
        filePart: "",
        noun: function (n) { return plural(n, "member", "members"); },
        prepare: function () {
          return loadUserSchema().then(function (schema) {
            const attrs = schemaAttrs(schema);
            return {
              attrs: attrs.length ? attrs : FALLBACK_PROFILE_ATTRS,
              schemaFailed: !attrs.length,
            };
          });
        },
        columnGroups: function (ctx) {
          return [
            recordGroup("User record", [
              ["rec:id", "id", "id"],
              ["rec:status", "status", "status", true],
              ["rec:type", "userType", "type.id"],
              ["rec:created", "created", "created"],
              ["rec:activated", "activated", "activated"],
              ["rec:statusChanged", "statusChanged", "statusChanged"],
              ["rec:lastLogin", "lastLogin", "lastLogin"],
              ["rec:lastUpdated", "lastUpdated", "lastUpdated"],
              ["rec:passwordChanged", "passwordChanged", "passwordChanged"],
              ["rec:provider", "credentialProvider", "credentials.provider.type"],
            ]),
            attrGroup("Profile attributes", ctx.attrs, {
              root: "profile",
              keyPrefix: "prof:",
              defaults: PROFILE_DEFAULTS,
              note: ctx.schemaFailed
                ? "The org's profile schema could not be read, so only the " +
                  "standard base attributes are listed. Custom attributes need " +
                  "an account with permission to read the user schema."
                : null,
            }),
          ];
        },
        stream: function (st, chosen, emit) {
          return pageAll(function (limit) {
            return "/api/v1/groups/" + encodeURIComponent(groupId) +
              "/users?limit=" + limit;
          }, LIMIT_GROUP_USERS, st, emit);
        },
      }],
    };
  }

  /* =========================================================================
     DESCRIPTOR  -  every group in the org

     One source, reading /api/v1/groups from the groups LIST page.

     Member counts are cheap here, which is worth spelling out because the
     equivalent option on the app export is not. usersCount and appsCount come
     from expand=stats, which is a single query parameter that Okta fills in
     server side as it builds each page. It costs no extra requests, so unlike
     expand=user there is no per-row join to pay for, and rockstar pages it
     1,000 at a time the same way. usersCount is therefore checked by default.
     It still sets a flag rather than being hardcoded into the URL, so clearing
     both count boxes drops the parameter and the export gets marginally
     cheaper again.

     name and description live at profile.name and profile.description, so the
     profile section below filters them out to avoid offering the same column
     twice.
  ========================================================================= */
  const GROUP_PROFILE_SKIP = new Set(["name", "description"]);

  function allGroupsDescriptor() {
    return {
      heading: "Download all groups",
      filePart: "all-groups",
      subjectFallback: "this org",
      resolveName: function () {
        return getJSON("/api/v1/org")
          .then(function (o) { return (o && o.companyName) || null; })
          .catch(function () { return null; });
      },
      sources: [{
        id: "groups",
        label: "Groups",
        filePart: "",
        noun: function (n) { return plural(n, "group", "groups"); },
        prepare: function () {
          return loadGroupSchema().then(function (schema) {
            const attrs = schemaAttrs(schema).filter(function (a) {
              return !GROUP_PROFILE_SKIP.has(a);
            });
            return { attrs: attrs };
          });
        },
        columnGroups: function (ctx) {
          const stats = recordGroup("Member and app counts", [
            ["stat:users", "usersCount", "_embedded.stats.usersCount", true],
            ["stat:apps", "appsCount", "_embedded.stats.appsCount"],
          ], "These come from expand=stats, which Okta fills in as it builds " +
             "each page. Unlike the app export's Okta user columns, this adds " +
             "no extra requests, so leaving usersCount ticked is inexpensive.");
          // Flagged rather than hardcoded, so the parameter is only sent when
          // one of these columns is actually selected.
          stats.columns.forEach(function (c) { c.expandsStats = true; });

          return [
            recordGroup("Group record", [
              ["rec:id", "id", "id", true],
              ["rec:name", "name", "profile.name", true],
              ["rec:description", "description", "profile.description", true],
              ["rec:type", "type", "type", true],
              ["rec:created", "created", "created"],
              ["rec:lastUpdated", "lastUpdated", "lastUpdated"],
              ["rec:lastMembershipUpdated", "lastMembershipUpdated", "lastMembershipUpdated"],
              ["rec:objectClass", "objectClass", "objectClass"],
            ]),
            stats,
            attrGroup("Group profile attributes", ctx.attrs, {
              root: "profile",
              keyPrefix: "gprof:",
              emptyText: "This org exposes no group profile attributes beyond " +
                "name and description, which are listed above.",
            }),
          ];
        },
        stream: function (st, chosen, emit) {
          const wantsStats = chosen.some(function (c) { return c.expandsStats; });
          return pageAll(function (limit) {
            return "/api/v1/groups?limit=" + limit +
              (wantsStats ? "&expand=stats" : "");
          }, LIMIT_GROUPS, st, emit);
        },
      }],
    };
  }

  /* =========================================================================
     DESCRIPTOR  -  app assignments

     PEOPLE  reads app users. An app user is an assignment record and not an
       Okta user, so its own `profile` holds the APP profile (whatever the
       app's user mappings produce, often a role or an app username) and
       `credentials.userName` is the app username. `scope` reports whether the
       assignment is direct (USER) or inherited from a group (GROUP), and
       `_links.group.name` names that group.

       The Okta user attributes section is the one expensive option here. It
       needs expand=user, so selecting anything in it turns that on and the
       section says so. Leave it alone and the export runs at rockstar's speed.

     GROUPS  reads app group assignments, which carry a group ID, a priority,
       and an app profile. expand=group embeds the group so we can show its
       name. Anything that arrives without an embedded group is backfilled with
       an individual read, because a CSV of bare group IDs is not much use.
  ========================================================================= */
  function appAssignmentsDescriptor(appId) {
    return {
      heading: "Download app assignments",
      filePart: "app-assignments",
      subjectFallback: "this app",
      resolveName: function () {
        return getJSON("/api/v1/apps/" + encodeURIComponent(appId))
          .then(function (a) { return (a && (a.label || a.name)) || null; })
          .catch(function () { return null; });
      },
      sources: [
        {
          id: "people",
          label: "People",
          filePart: "people",
          noun: function (n) { return plural(n, "assignment", "assignments"); },
          prepare: function () {
            return Promise.all([
              loadAppUserSchema(appId),
              loadUserSchema(),
            ]).then(function (both) {
              const appAttrs = schemaAttrs(both[0]);
              const userAttrs = schemaAttrs(both[1]);
              // Only sample a row if the app schema was unreadable.
              const appAttrsPromise = appAttrs.length
                ? Promise.resolve(appAttrs)
                : sampleAppUserProfile(appId);
              return appAttrsPromise.then(function (resolvedAppAttrs) {
                return {
                  appAttrs: resolvedAppAttrs,
                  userAttrs: userAttrs.length ? userAttrs : FALLBACK_PROFILE_ATTRS,
                };
              });
            });
          },
          columnGroups: function (ctx) {
            return [
              recordGroup("Assignment record", [
                ["rec:scope", "scope", "scope", true],
                ["rec:status", "status", "status", true],
                ["rec:appUserName", "appUserName", "credentials.userName", true],
                ["rec:viaGroup", "assignedViaGroup", "_links.group.name", true],
                ["rec:id", "appUserId", "id"],
                ["rec:externalId", "externalId", "externalId"],
                ["rec:syncState", "syncState", "syncState"],
                ["rec:created", "created", "created"],
                ["rec:lastUpdated", "lastUpdated", "lastUpdated"],
                ["rec:statusChanged", "statusChanged", "statusChanged"],
                ["rec:lastSync", "lastSync", "lastSync"],
                ["rec:passwordChanged", "passwordChanged", "passwordChanged"],
              ]),
              attrGroup("App profile attributes", ctx.appAttrs, {
                root: "profile",
                keyPrefix: "app:",
                headerPrefix: "app.",
                emptyText: "This app's user schema could not be read and the " +
                  "sample assignment carried no profile attributes.",
              }),
              attrGroup("Okta user attributes", ctx.userAttrs, {
                root: "_embedded.user.profile",
                keyPrefix: "prof:",
                expandsUser: true,
                note: "Selecting any of these asks Okta to join the full user " +
                  "record onto every assignment, which is much slower on a " +
                  "large app. Leave them unchecked for the quick export.",
              }),
            ];
          },
          stream: function (st, chosen, emit) {
            // The expensive parameter is only sent when a column needs it.
            const wantsUser = chosen.some(function (c) { return c.expandsUser; });
            return pageAll(function (limit) {
              return "/api/v1/apps/" + encodeURIComponent(appId) +
                "/users?limit=" + limit + (wantsUser ? "&expand=user" : "");
            }, LIMIT_APP_USERS, st, emit);
          },
        },
        {
          id: "groups",
          label: "Groups",
          filePart: "groups",
          noun: function (n) { return plural(n, "group assignment", "group assignments"); },
          prepare: function () {
            return loadAppUserSchema(appId).then(function (schema) {
              return { appAttrs: schemaAttrs(schema) };
            });
          },
          columnGroups: function (ctx) {
            return [
              recordGroup("Group assignment", [
                ["rec:name", "groupName", "_embedded.group.profile.name", true],
                ["rec:id", "groupId", "id", true],
                ["rec:description", "groupDescription", "_embedded.group.profile.description", true],
                ["rec:type", "groupType", "_embedded.group.type"],
                ["rec:priority", "priority", "priority"],
                ["rec:lastUpdated", "lastUpdated", "lastUpdated"],
              ]),
              attrGroup("App profile attributes", ctx.appAttrs, {
                root: "profile",
                keyPrefix: "app:",
                headerPrefix: "app.",
                emptyText: "This app's user schema could not be read.",
              }),
            ];
          },
          stream: function (st, chosen, emit) {
            return pageAll(function (limit) {
              return "/api/v1/apps/" + encodeURIComponent(appId) +
                "/groups?limit=" + limit + "&expand=group";
            }, LIMIT_APP_GROUPS, st, async function (rows) {
              // Backfill names for any row Okta returned without an embedded
              // group, then hand the page on. Doing it per page keeps the
              // streaming shape intact.
              const missing = rows.filter(function (r) {
                return !(r && r._embedded && r._embedded.group);
              });
              if (missing.length && !st.cancelled) {
                await mapLimit(missing, BACKFILL_CONCURRENCY, function (r) {
                  return getJSON("/api/v1/groups/" + encodeURIComponent(r.id))
                    .then(function (g) {
                      r._embedded = r._embedded || {};
                      r._embedded.group = g;
                    })
                    .catch(function () { /* leave the name blank */ });
                });
              }
              return emit(rows);
            });
          },
        },
      ],
    };
  }

  /* =========================================================================
     OVERLAY

     The picker opens immediately, because the columns come from the schema
     rather than from the data. Nothing is fetched until Generate is clicked,
     at which point the overlay switches to a running phase that reports rows
     and approximate size as pages stream in.

     Checkbox state lives in st.checks, keyed by source and then column key, so
     switching between People and Groups and back preserves the selection.
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

  function subjectOf(st) {
    return st.contextName ? '"' + st.contextName + '"' : st.desc.subjectFallback;
  }

  function activeSource(st) {
    return st.desc.sources.filter(function (s) { return s.id === st.sourceId; })[0] ||
      st.desc.sources[0];
  }

  function overlayHeader(st) {
    return h("div", {
      style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
    },
      h("h2", { style: { fontSize: 18, margin: 0, fontWeight: 700 } }, st.desc.heading),
      h("button", {
        onClick: closeOverlay, title: "Close",
        style: {
          background: "transparent", border: "none", cursor: "pointer",
          fontSize: 20, lineHeight: 1, color: C.dim,
        },
      }, "\u00D7")
    );
  }

  function subtitleText(st) {
    if (st.phase === "error") {
      return "Okta rejected the request for " + subjectOf(st) + ".";
    }
    if (st.phase === "running") {
      return "Generating export of " + activeSource(st).label.toLowerCase() + " from " +
        subjectOf(st) + "." + " This may take some time - do not close.";
    }
    if (st.phase === "preparing") {
      return "Reading the profile schema for " + subjectOf(st) + ".";
    }
    return "Select the columns to include, then generate the file. " +
      "Rows are read from " + subjectOf(st) + " when you click Generate.";
  }

  function subtitleNode(st) {
    return h("p", {
      id: "orb-ex-subtitle",
      style: { color: C.dim, fontSize: 13, margin: "0 0 12px" },
    }, subtitleText(st));
  }

  function paintSubtitle(st) {
    const el = _panelEl && _panelEl.querySelector("#orb-ex-subtitle");
    if (el) el.textContent = subtitleText(st);
  }

  function progressText(st) {
    const src = activeSource(st);
    let line = st.count.toLocaleString() + " " + src.noun(st.count) +
      "  \u2022  " + formatBytes(st.bytes);
    if (st.waiting) line += "  \u2022  waiting out the API rate limit";
    return line;
  }

  function paintProgress(st) {
    const el = _panelEl && _panelEl.querySelector("#orb-ex-progress");
    if (el) el.textContent = progressText(st);
  }

  function sourceTabs(st, enabled) {
    if (st.desc.sources.length < 2) return null;
    return h("div", { style: { display: "flex", gap: 8, margin: "0 0 12px" } },
      st.desc.sources.map(function (s) {
        return tabButton(s.label, s.id === st.sourceId, function () {
          if (!enabled || s.id === st.sourceId) return;
          st.sourceId = s.id;
          openSource(st);
        });
      }));
  }

  function preparingBody(st) {
    return [
      subtitleNode(st),
      sourceTabs(st, false),
      h("div", {
        style: { fontSize: 13, color: C.dim, fontWeight: 600, padding: "10px 0 4px" },
      }, "Loading the column list"),
      h("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: 16 } },
        linkBtn("Cancel", closeOverlay)),
    ];
  }

  function runningBody(st) {
    return [
      subtitleNode(st),
      h("div", {
        id: "orb-ex-progress",
        style: {
          fontSize: 13, color: C.dim, fontWeight: 600,
          padding: "10px 0 4px", lineHeight: 1.6,
        },
      }, progressText(st)),
      h("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: 16 } },
        linkBtn("Cancel", closeOverlay)),
    ];
  }

  function errorBody(st) {
    return [
      subtitleNode(st),
      errorBox(st.error),
      h("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: 16 } },
        linkBtn("Close", closeOverlay)),
    ];
  }

  function emptyBody(st) {
    const src = activeSource(st);
    return [
      h("p", { style: { color: C.dim, fontSize: 13, margin: "0 0 12px" } },
        "Okta returned no " + src.noun(0) + " for " + subjectOf(st) +
        ", so there is nothing to export."),
      sourceTabs(st, true),
      h("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: 16 } },
        linkBtn("Close", closeOverlay)),
    ];
  }

  function pickerBody(st) {
    const src = activeSource(st);
    const groups = src.columnGroups(st.ctx[src.id]);
    const allCols = [];
    groups.forEach(function (g) {
      g.columns.forEach(function (c) { allCols.push(c); });
    });

    if (!st.checks[src.id]) st.checks[src.id] = {};
    const checks = st.checks[src.id];
    allCols.forEach(function (c) {
      if (Object.prototype.hasOwnProperty.call(checks, c.key)) c.checked = checks[c.key];
      checks[c.key] = c.checked;
    });

    const boxStyle = {
      display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
      borderRadius: 8, cursor: "pointer", fontSize: 16, color: C.text,
    };
    const gridStyle = {
      display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
      gap: 4, overflowY: "auto", maxHeight: "32vh",
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

    const grids = [];
    const nodes = [];
    groups.forEach(function (g) {
      nodes.push(sectionLabel(g.label));
      if (g.note) nodes.push(noteLine(g.note));
      const grid = h("div", { style: gridStyle },
        g.columns.length
          ? g.columns.map(checkbox)
          : h("p", { style: { color: C.dim, fontSize: 13, margin: 0, lineHeight: 1.5 } },
              g.emptyText || "Nothing to show here.")
      );
      grids.push(grid);
      nodes.push(grid);
    });

    const setAll = function (val) {
      allCols.forEach(function (c) { checks[c.key] = val; });
      grids.forEach(function (g) {
        g.querySelectorAll("input[type=checkbox]").forEach(function (cb) { cb.checked = val; });
      });
    };

    return [
      subtitleNode(st),
      sourceTabs(st, true),
      h("div", { style: { display: "flex", gap: 12, marginBottom: 8 } },
        linkBtn("Select all", function () { setAll(true); }),
        linkBtn("Clear all", function () { setAll(false); })),
      nodes,
      h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 } },
        primaryButton("Generate .csv", IconDownload(15), function () {
          const chosen = allCols.filter(function (c) { return checks[c.key]; });
          if (!chosen.length) return;
          runExport(st, chosen);
        }, true)),
    ];
  }

  function renderOverlay(st) {
    if (!_panelEl) return;
    _panelEl.textContent = "";
    appendChildren(_panelEl, [overlayHeader(st)]);
    const body =
      st.phase === "preparing" ? preparingBody(st) :
      st.phase === "running" ? runningBody(st) :
      st.phase === "error" ? errorBody(st) :
      st.phase === "empty" ? emptyBody(st) :
      pickerBody(st);
    appendChildren(_panelEl, body);
  }

  function mountOverlay(st) {
    _panelEl = h("div", {
      onClick: function (e) { e.stopPropagation(); },
      style: {
        background: C.panel, color: C.text, border: "1px solid " + C.border,
        borderRadius: 14, padding: 20, width: "min(680px, 92vw)",
        maxHeight: "92vh", overflowY: "auto",
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
     FLOW

     openExport   opens the overlay and prepares the first source
     openSource   prepares one source's column list, cached per source
     runExport    pages the chosen source, streaming rows into CSV lines
  ========================================================================= */
  function openSource(st) {
    const src = activeSource(st);
    if (st.ctx[src.id]) {
      st.phase = "picker";
      renderOverlay(st);
      return;
    }
    st.phase = "preparing";
    renderOverlay(st);
    Promise.resolve(src.prepare())
      .then(function (ctx) {
        if (st.cancelled || _state !== st) return;
        st.ctx[src.id] = ctx || {};
        st.phase = "picker";
        renderOverlay(st);
      })
      .catch(function (e) {
        if (st.cancelled || _state !== st) return;
        st.error = describeError(e);
        st.phase = "error";
        renderOverlay(st);
      });
  }

  function runExport(st, chosen) {
    const src = activeSource(st);
    st.phase = "running";
    st.count = 0;
    st.bytes = 0;
    st.waiting = false;
    st.onTick = function () { paintProgress(st); };
    renderOverlay(st);

    const header = csvHeaderLine(chosen);
    const lines = [header];
    st.bytes = header.length;

    // Repaint at most once per frame. A 50,000-row export would otherwise
    // spend real time updating a counter nobody is reading that closely.
    let dirty = false;
    const tick = function () {
      if (dirty) return;
      dirty = true;
      requestAnimationFrame(function () {
        dirty = false;
        if (!st.cancelled && _state === st) paintProgress(st);
      });
    };

    src.stream(st, chosen, function (rows) {
      for (let i = 0; i < rows.length; i++) {
        const line = csvLine(rows[i], chosen);
        lines.push(line);
        st.bytes += line.length;
      }
      st.count += rows.length;
      tick();
    })
      .then(function () {
        if (st.cancelled || _state !== st) return;
        if (!st.count) {
          st.phase = "empty";
          renderOverlay(st);
          return;
        }
        downloadLines(lines, [st.desc.filePart, st.contextName || st.contextId, src.filePart]);
        closeOverlay();
      })
      .catch(function (e) {
        if (st.cancelled || _state !== st) return;
        st.error = describeError(e);
        st.phase = "error";
        renderOverlay(st);
      });
  }

  function openExport(desc, contextId) {
    closeOverlay();
    const st = {
      desc: desc,
      contextId: contextId,
      contextName: null,
      phase: "preparing",
      sourceId: desc.sources[0].id,
      ctx: {},
      checks: {},
      count: 0,
      bytes: 0,
      waiting: false,
      error: null,
      cancelled: false,
    };
    _state = st;
    mountOverlay(st);

    // The display name only feeds the heading and the filename, so a failure
    // here is not worth surfacing.
    desc.resolveName().then(function (name) {
      if (st.cancelled || _state !== st || !name) return;
      st.contextName = name;
      paintSubtitle(st);
    });

    openSource(st);
  }

  /* =========================================================================
     INJECTION TARGETS

     Each target reports whether the current URL is its page, finds its
     toolbar, and says where in that toolbar the button belongs:

       anchor      element whose Okta button classes we copy for styling
       layoutFrom  element whose computed float we copy, which is not always
                   the anchor. In the group toolbar the <a> floats itself. In
                   the app toolbar the floating element is the .dropdown box
                   wrapping the <a>.
       before      insert ahead of this node, or null to append
  ========================================================================= */
  const TARGETS = [
    {
      id: "groups-list",
      title: "Download every group in this org as a CSV",
      // Nothing to scope this export to, so any truthy value works as the
      // context. It is only used for the filename, which falls back to the org
      // name when that reads successfully.
      contextId: function () {
        return GROUPS_LIST_RE.test(location.pathname) ? "org" : null;
      },
      wrapSel: ".advanced-search-component-wrap",
      locate: function (wrap) {
        const add = wrap.querySelector("a.add-group-button");
        if (!add) return null;
        // "In front of" means to the left of Add group. This toolbar shares a
        // wrapper class with the group People toolbar, which floats its
        // controls right and so reverses DOM order against what you see. With
        // only one neighbour here we cannot infer the direction from sibling
        // order, so read it: floated right means the left-hand slot is the
        // node AFTER Add group, otherwise it is the node before it.
        const dir = window.getComputedStyle(add).float;
        return {
          anchor: add,
          layoutFrom: add,
          before: dir === "right" ? add.nextSibling : add,
        };
      },
      descriptor: allGroupsDescriptor,
    },
    {
      id: "group-people",
      title: "Download every user in this group as a CSV",
      contextId: function () {
        const m = GROUP_ID_RE.exec(location.pathname);
        return m ? m[1] : null;
      },
      wrapSel: ".advanced-search-component-wrap",
      locate: function (wrap) {
        const assign = wrap.querySelector("a.assign-people-button");
        const dropdown = wrap.querySelector(".group-member-toolbar-dropdown");
        // Both are People-tab controls. Requiring one of them keeps the button
        // off the group's other tabs, which reuse the same wrapper class.
        if (!assign && !dropdown) return null;
        return {
          anchor: assign,
          layoutFrom: assign || dropdown,
          before: dropdown || (assign ? assign.nextSibling : null),
        };
      },
      descriptor: groupMembersDescriptor,
    },
    {
      id: "app-assignments",
      title: "Download every assignment for this app as a CSV",
      contextId: function () {
        const m = APP_ID_RE.exec(location.pathname);
        return m ? m[1] : null;
      },
      wrapSel: ".assignment-btns-wrap",
      locate: function (wrap) {
        // "Assign" is the primary dropdown and "Convert assignments" the
        // second. Both are <a> links inside their own .dropdown box, so we
        // insert between the boxes rather than between the links.
        const convertLink = wrap.querySelector("a.convert-assignments-dropdown");
        const convertBox = convertLink ? convertLink.closest(".dropdown") : null;
        const assignLink = wrap.querySelector("a.button-primary");
        const assignBox = assignLink ? assignLink.closest(".dropdown") : null;
        if (!assignBox && !convertBox) return null;
        return {
          anchor: assignLink,
          layoutFrom: assignBox || convertBox,
          before: convertBox,
        };
      },
      descriptor: appAssignmentsDescriptor,
    },
  ];

  /* =========================================================================
     PROVENANCE BADGE

     A small white dot on the top-right corner, marking a button as ORB's
     rather than one of Okta's own. Three details keep it from misbehaving:

       - The dot is a child of the button, so it needs position: relative on
         the button and overflow: visible in case an Okta button class clips
         its content. Both are set explicitly rather than assumed.
       - pointer-events: none, so the dot can never swallow a click that was
         meant for the button underneath it.
       - A border, because a white dot on its own would vanish against any
         pale button. The border keeps it legible on both the blue primary
         buttons and a light one.

     It is decorative, so it is hidden from assistive tech. The button's title
     attribute is what actually explains the button.
  ========================================================================= */
  const BADGE_SIZE = 9;

  function addOrbBadge(btn) {
    const cs = window.getComputedStyle(btn);
    if (cs.position === "static") btn.style.position = "relative";
    btn.style.overflow = "visible";

    btn.appendChild(h("span", {
      className: MARK + "-badge",
      "aria-hidden": "true",
      style: {
        position: "absolute",
        top: -Math.round(BADGE_SIZE / 3),
        right: -Math.round(BADGE_SIZE / 3),
        width: BADGE_SIZE,
        height: BADGE_SIZE,
        borderRadius: "50%",
        background: "#ffffff",
        border: "1px solid rgba(0,0,0,0.35)",
        boxSizing: "content-box",
        pointerEvents: "none",
        zIndex: 1,
      },
    }));
  }

  function buildButton(target, contextId, spot) {
    // Reusing Okta's own button-primary and link-button classes is what makes
    // this match its neighbour exactly, including hover and focus states. We
    // deliberately leave off the console's behaviour hooks, meaning
    // assign-people-button and the option-selected / icon-dm dropdown classes,
    // since this is a plain button and not a dropdown.
    const btn = h("a", {
      href: "#",
      "data-se": "button",
      className: "button-primary link-button " + MARK,
      title: target.title + " (added by the ORB extension)",
    }, "Download");

    // Copy the neighbour's float so the button joins the same row. Horizontal
    // margin on both sides keeps the spacing even whichever neighbour ends up
    // on which side.
    if (spot.layoutFrom) {
      const f = window.getComputedStyle(spot.layoutFrom).float;
      if (f && f !== "none") btn.style.float = f;
    }
    btn.style.margin = "0 8px";

    btn.addEventListener("click", function (e) {
      e.preventDefault();
      // Built per click so a stale descriptor never outlives an SPA
      // navigation to a different group or app.
      openExport(target.descriptor(contextId), contextId);
    });
    return btn;
  }

  function tryInject() {
    TARGETS.forEach(function (target) {
      const contextId = target.contextId();
      if (!contextId) return;

      // A page can render more than one node matching wrapSel, and the console
      // reuses .advanced-search-component-wrap across several screens, so take
      // the first wrapper that actually contains the controls we anchor to
      // rather than assuming it is the first in the document.
      const wraps = document.querySelectorAll(target.wrapSel);
      for (let i = 0; i < wraps.length; i++) {
        const wrap = wraps[i];
        if (wrap.querySelector("." + MARK)) return; // already added

        const spot = target.locate(wrap);
        if (!spot) continue;

        const btn = buildButton(target, contextId, spot);
        if (spot.before) wrap.insertBefore(btn, spot.before);
        else wrap.appendChild(btn);
        // After insertion, so getComputedStyle reports real values. A detached
        // element has no resolved position to check.
        addOrbBadge(btn);
        return;
      }
    });
  }

  // The console re-renders these toolbars on tab switches, search, and paging,
  // so watch for them instead of injecting once. Coalesced onto a single frame
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
    const api = {
      inject: inject,
      // Exposed for manual testing from the console.
      openExport: openExport,
      // Exposed so the other ORB modules can mark their own injected buttons
      // with the same dot. Call it after the button is in the DOM.
      addOrbBadge: addOrbBadge,
      csvLine: csvLine,
      csvHeaderLine: csvHeaderLine,
      dot: dot,
      schemaAttrs: schemaAttrs,
      descriptors: {
        allGroups: allGroupsDescriptor,
        groupMembers: groupMembersDescriptor,
        appAssignments: appAssignmentsDescriptor,
      },
    };
    window.orbExport = api;
    window.orbGroupExport = api; // alias, kept for older mount code
  }
})();
