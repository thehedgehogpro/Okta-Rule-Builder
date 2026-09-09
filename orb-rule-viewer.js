/* ===========================================================================
   ORB Rule Viewer - "View Rule" popover for group membership rows
   ---------------------------------------------------------------------------
   On an Okta group's People tab, each member row shows how the membership was
   granted. Rule-driven rows render as:

       <td class="group-member-managedBy">
         <div>By rule&nbsp;<a href="/admin/groups#rules">RULE NAME</a></div>
       </td>

   Note that the anchor carries no rule id, only the rule NAME. So this module
   resolves the rule by name against the public Group Rules API:

       GET /api/v1/groups/rules?search=<name>&limit=200
           &expand=groupIdToGroupNameMap

   `search` performs a startsWith match on the rule name (Okta documents this
   as an implementation detail that may change), so we ask for the exact name,
   then filter the response down to an exact match ourselves. If that comes up
   empty we fall back to paging the full rule list and matching there, which
   also covers orgs where search behaves unexpectedly.

   Rule object shape we render from:

       { id, name, status, created, lastUpdated, type: "group_rule",
         conditions: {
           expression: { value: "<OEL>", type: "urn:okta:expression:1.0" },
           people: { users: { exclude: [] }, groups: { exclude: [] } }
         },
         actions: { assignUserToGroups: { groupIds: [ ... ] } },
         _embedded: { groupIdToGroupNameMap: { "<id>": "<name>" } } }

   PUBLIC SURFACE
       window.orbRuleViewer = {
         inject(opts)              // add buttons + watch for new rows
         openFor(anchorEl, name)   // open the popover programmatically
         findRuleByName(name)      // Promise<rule[]>, exact matches
         close()                   // close any open popover
         clearCache()              // drop cached rules (org switch / edits)
       }

   opts (all optional, supplied by orb-plugin.js so requests carry the
   extension's headers and XSRF token):
       { getJSON, getLinks, createPopup }

   Load order in the extension manifest:
       1. okta-rule-builder.js
       2. oel-preview.js
       3. orb-rule-viewer.js   (this file)
       4. orb-plugin.js        (mounts everything)
=========================================================================== */
(function () {
  "use strict";

  const HEADERS = { "X-Okta-User-Agent-Extended": "orb-plugin" };
  const MARK = "orb-view-rule-btn";
  const RULES_PAGE_LIMIT = 200; // Okta's ceiling for this endpoint
  const MAX_SCAN_PAGES = 25; // 5,000 rules before we stop paging

  /* =========================================================================
     Host integration. orb-plugin.js hands us its helpers. When this file runs
     standalone (manual console testing) we fall back to plain fetch on the
     same relative-path convention.
  ========================================================================= */
  let host = {};

  function getJSON(path) {
    if (typeof host.getJSON === "function") return host.getJSON(path);
    return fetch(location.origin + path, {
      headers: HEADERS,
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

  // Paging needs the Link header, which getJSON discards, so this always uses
  // fetch directly. Resolves to { data, linkHeader }.
  function fetchPage(path) {
    return fetch(location.origin + path, {
      headers: HEADERS,
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

  function parseLinks(linkHeader) {
    if (typeof host.getLinks === "function") return host.getLinks(linkHeader);
    const links = {};
    if (!linkHeader) return links;
    linkHeader.split(/, */).forEach(function (part) {
      const m = part.match(/<(.*)>; *rel="(.*)"/);
      if (m) links[m[2]] = m[1];
    });
    return links;
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
    if (status === 403) {
      msg += " (this admin role may not have permission to read group rules)";
    }
    return msg;
  }

  /* =========================================================================
     DOM helper, trimmed copy of the one in oel-preview.js so the two modules
     build markup the same way.
  ========================================================================= */
  const SVG_TAGS = new Set(["svg", "line", "rect", "path", "polyline", "polygon", "circle"]);
  const UNITLESS = new Set(["opacity", "fontWeight", "lineHeight", "zIndex", "flex", "flexGrow", "flexShrink", "order"]);

  function h(tag, props, ...children) {
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
        else if (key === "disabled") el.disabled = val;
        else el.setAttribute(camelToAttr(key), val);
      }
    }
    appendChildren(el, children);
    return el;
  }
  function camelToAttr(k) {
    return k === "viewBox" ? k : k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
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
  const IconEye = (s) => icon([
    h("path", { d: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" }),
    h("circle", { cx: 12, cy: 12, r: 3 }),
  ], s);
  const IconCopy = (s) => icon([
    h("rect", { x: 9, y: 9, width: 12, height: 12, rx: 2 }),
    h("path", { d: "M15 5H5a2 2 0 0 0-2 2v10" }),
  ], s);
  const IconPlay = (s) => icon([h("polygon", { points: "5 3 19 12 5 21 5 3" })], s);
  const IconRefresh = (s) => icon([
    h("path", { d: "M21 12a9 9 0 1 1-3-6.7" }),
    h("polyline", { points: "21 3 21 9 15 9" }),
  ], s);

  // Same palette as oel-preview.js and the Rule Builder. Theme and color settings.
  const C = {
    panel: "#ffffff", panel2: "#ededed",
    border: "#000000", text: "#000000", dim: "#324548",
    accent: "#4d65e2", red_accent: "#ffc4c4",
    output: "#c1ecf9", good: "#1f7a3d", text_light: "#ffffff",
  };
  const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
  const SANS = "ui-sans-serif, system-ui, -apple-system, sans-serif";

  /* =========================================================================
     Rule lookup and caching. Rule names repeat across many member rows, so a
     cache keyed on the normalized name makes every open after the first one
     instant. Only successful lookups are cached, which lets a failed request
     be retried by clicking again.
  ========================================================================= */
  const ruleCache = new Map(); // normalized name -> rule[]
  const groupNameCache = new Map(); // group id -> display name, or null if unnameable
  let allRulesPromise = null;

  // The cell renders a non-breaking space before the link, and admins
  // sometimes paste names with doubled spaces, so normalize both.
  function normalizeName(s) {
    return String(s == null ? "" : s)
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function sameName(a, b) {
    return normalizeName(a).toLowerCase() === normalizeName(b).toLowerCase();
  }

  function searchRules(name) {
    const path =
      "/api/v1/groups/rules?limit=" + RULES_PAGE_LIMIT +
      "&expand=groupIdToGroupNameMap" +
      "&search=" + encodeURIComponent(name);
    return getJSON(path).then(function (rules) {
      return Array.isArray(rules) ? rules : [];
    });
  }

  // Page the whole rule list once per page load. Used only when search misses.
  function loadAllRules() {
    if (allRulesPromise) return allRulesPromise;
    allRulesPromise = (async function () {
      const out = [];
      let path =
        "/api/v1/groups/rules?limit=" + RULES_PAGE_LIMIT +
        "&expand=groupIdToGroupNameMap";
      for (let page = 0; page < MAX_SCAN_PAGES && path; page++) {
        const res = await fetchPage(path);
        if (Array.isArray(res.data)) out.push(...res.data);
        const next = parseLinks(res.linkHeader).next;
        path = next ? next.replace(location.origin, "") : null;
      }
      return out;
    })().catch(function (err) {
      allRulesPromise = null; // let a later open retry
      throw err;
    });
    return allRulesPromise;
  }

  // Resolve a rule name to every rule that carries exactly that name. Okta
  // permits duplicate rule names, so this returns an array.
  async function findRuleByName(rawName) {
    const name = normalizeName(rawName);
    if (!name) return [];
    if (ruleCache.has(name.toLowerCase())) return ruleCache.get(name.toLowerCase());

    let matches = [];
    let searchError = null;
    try {
      const found = await searchRules(name);
      matches = found.filter((r) => sameName(r && r.name, name));
    } catch (e) {
      // A search failure is not fatal on its own, the full scan below may
      // still succeed. Keep the message in case the scan fails too.
      matches = [];
      searchError = e;
    }

    if (!matches.length) {
      try {
        const all = await loadAllRules();
        matches = all.filter((r) => sameName(r && r.name, name));
      } catch (e) {
        throw searchError || e;
      }
    }

    if (matches.length) ruleCache.set(name.toLowerCase(), matches);
    return matches;
  }

  /* =========================================================================
     GROUP NAME RESOLUTION

     Two callers need this. The "Assigns members to" row resolves the rule's
     target groups, and the expression renderer resolves every group id it
     finds inside the OEL. Both share one cache keyed on group id.

     A cached value of null means "asked Okta and could not get a name", which
     covers a deleted group and an admin role without read access. That is
     kept distinct from "not asked yet" so the expression renderer can leave
     an unresolvable id visible rather than pretending it was substituted.
  ========================================================================= */

  // id -> name, or null when Okta could not name it. In-flight lookups are
  // held separately so several spans referencing the same group share one
  // request.
  const groupNamePromises = new Map();

  function seedGroupNames(rule) {
    const embedded = (rule && rule._embedded && rule._embedded.groupIdToGroupNameMap) || {};
    for (const id in embedded) {
      if (embedded[id] && !groupNameCache.has(id)) groupNameCache.set(id, embedded[id]);
    }
  }

  // Resolves to the group's display name, or null if it cannot be named.
  function resolveGroupName(id) {
    if (groupNameCache.has(id)) return Promise.resolve(groupNameCache.get(id));
    if (groupNamePromises.has(id)) return groupNamePromises.get(id);

    const p = getJSON("/api/v1/groups/" + encodeURIComponent(id))
      .then(function (g) {
        const name = g && g.profile && g.profile.name;
        groupNameCache.set(id, name || null);
        groupNamePromises.delete(id);
        return groupNameCache.get(id);
      })
      .catch(function () {
        groupNameCache.set(id, null);
        groupNamePromises.delete(id);
        return null;
      });

    groupNamePromises.set(id, p);
    return p;
  }

  // Target group names come from the expanded map when Okta includes it,
  // otherwise they are fetched individually. An unresolvable group falls back
  // to showing its id.
  function resolveGroupNames(rule) {
    const ids =
      (rule.actions &&
        rule.actions.assignUserToGroups &&
        rule.actions.assignUserToGroups.groupIds) || [];
    seedGroupNames(rule);
    return Promise.all(
      ids.map(function (id) {
        return resolveGroupName(id).then(function (name) {
          return { id: id, name: name || id, resolved: !!name };
        });
      })
    );
  }

  /* =========================================================================
     Anchored popover. Fixed positioning against the button's viewport rect,
     flipped above or nudged inward when it would run off screen. Only one is
     ever open, and it closes on outside click, Escape, or a page scroll that
     takes the button away.
  ========================================================================= */
  let openPop = null;
  let openAnchor = null;

  function close() {
    destroyTip();
    if (openPop && openPop.parentNode) openPop.parentNode.removeChild(openPop);
    openPop = null;
    openAnchor = null;
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onOutside, true);
    window.removeEventListener("resize", reposition, true);
    window.removeEventListener("scroll", reposition, true);
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  function onOutside(e) {
    if (!openPop) return;
    if (openPop.contains(e.target)) return;
    if (openAnchor && openAnchor.contains(e.target)) return;
    close();
  }
  function reposition() {
    // A tooltip anchored to the old position would be stranded, and the
    // pointer may no longer be over the name it belonged to.
    hideTip();
    if (openPop && openAnchor) place(openPop, openAnchor);
  }

  function place(pop, anchor) {
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const pad = 8;

    let left = r.left;
    if (left + pw > window.innerWidth - pad) {
      left = Math.max(pad, window.innerWidth - pw - pad);
    }
    left = Math.max(pad, left);

    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - pad) {
      const above = r.top - ph - 6;
      top = above >= pad ? above : Math.max(pad, window.innerHeight - ph - pad);
    }

    pop.style.left = Math.round(left) + "px";
    pop.style.top = Math.round(top) + "px";
  }

  function makePopover(ruleName) {
    const body = h("div", { style: { padding: 14 } }, spinnerRow("Looking up rule"));

    const header = h("div", {
      style: {
        display: "flex", alignItems: "flex-start", justifyContent: "space-between",
        gap: 12, padding: "12px 14px", background: C.panel,
        borderBottom: `1px solid ${C.border}`,
      },
    },
      h("div", null,
        h("div", { style: { fontSize: 11, color: C.dim, fontWeight: 700, marginBottom: 2 } }, "Group rule"),
        h("div", { style: { fontSize: 14, fontWeight: 700, lineHeight: 1.3, wordBreak: "break-word" } }, ruleName)
      ),
      h("button", {
        type: "button", title: "Close", onClick: close,
        style: {
          background: "transparent", border: "none", cursor: "pointer",
          fontSize: 18, lineHeight: 1, color: C.dim, padding: 0, marginTop: 2,
        },
      }, "\u00D7")
    );

    const pop = h("div", {
      className: "orb-rule-popover",
      style: {
        position: "fixed", zIndex: 2147483000, top: "0px", left: "0px",
        width: "min(480px, 92vw)", maxHeight: "72vh", overflowY: "auto",
        background: C.panel, color: C.text, fontFamily: SANS, fontSize: 13,
        border: `1px solid ${C.border}`, borderRadius: 12,
        boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
      },
    }, header, body);

    return { pop: pop, body: body };
  }

  // A ring spun with the Web Animations API rather than a @keyframes rule, so
  // this module never injects a stylesheet. That keeps it clear of the admin
  // console's style-src CSP, which can block an appended <style> tag.
  function spinnerRow(label) {
    const ring = h("span", {
      style: {
        width: 14, height: 14, borderRadius: "50%", display: "inline-block",
        boxSizing: "border-box", flex: "0 0 auto",
        border: "2px solid " + C.panel2, borderTopColor: C.accent,
      },
    });
    if (typeof ring.animate === "function") {
      try {
        ring.animate(
          [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
          { duration: 700, iterations: Infinity, easing: "linear" }
        );
      } catch (e) {}
    }
    return h("div", { style: { display: "flex", alignItems: "center", gap: 8, color: C.dim } },
      ring,
      h("span", { style: { fontSize: 13 } }, label)
    );
  }

  /* =========================================================================
     Popover content
  ========================================================================= */
  function statusPill(status) {
    const active = String(status || "").toUpperCase() === "ACTIVE";
    return h("span", {
      style: {
        display: "inline-block", padding: "1px 8px", borderRadius: 10,
        fontSize: 11, fontWeight: 700, border: `1px solid ${C.border}`,
        background: active ? "#d8f0df" : C.panel2,
        color: active ? C.good : C.dim,
      },
    }, active ? "Active" : (status || "Unknown"));
  }

  function fieldLabel(text) {
    return h("div", {
      style: { fontSize: 11, color: C.dim, fontWeight: 700, marginBottom: 5 },
    }, text);
  }

  function copyText(text, btn) {
    const done = function () {
      if (!btn) return;
      const prev = btn.lastChild.textContent;
      btn.lastChild.textContent = "Copied";
      setTimeout(function () {
        if (btn.lastChild) btn.lastChild.textContent = prev;
      }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        legacyCopy(text);
        done();
      });
    } else {
      legacyCopy(text);
      done();
    }
  }
  function legacyCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:-1000px;left:-1000px;";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
  }

  function smallButton(label, iconEl, onClick, kind) {
    const primary = kind === "primary";
    return h("button", {
      type: "button", onClick: onClick,
      style: {
        display: "inline-flex", alignItems: "center", gap: 5,
        background: primary ? C.accent : C.panel,
        color: primary ? C.text_light : C.text,
        border: `1px solid ${C.border}`, borderRadius: 8,
        cursor: "pointer", fontSize: 12, fontWeight: 700,
        padding: "5px 10px", fontFamily: SANS,
      },
    }, iconEl, h("span", null, label));
  }

  function errorBox(text) {
    return h("div", {
      style: {
        background: C.red_accent, border: `1px solid ${C.border}`,
        borderRadius: 10, padding: 10, fontSize: 12, lineHeight: 1.5,
      },
    }, text);
  }

  function excludeSummary(rule) {
    const people = (rule.conditions && rule.conditions.people) || {};
    const users = (people.users && people.users.exclude) || [];
    const groups = (people.groups && people.groups.exclude) || [];
    if (!users.length && !groups.length) return null;
    const parts = [];
    if (users.length) parts.push(users.length + (users.length === 1 ? " user" : " users"));
    if (groups.length) parts.push(groups.length + (groups.length === 1 ? " group" : " groups"));
    return h("div", { style: { marginTop: 12 } },
      fieldLabel("Exceptions"),
      h("div", {
        title: users.concat(groups).join("\n"),
        style: { fontSize: 12, color: C.text },
      }, parts.join(" and ") + " excluded from this rule")
    );
  }

  function metaRow(rule) {
    const bits = [];
    if (rule.lastUpdated) bits.push("Rule Updated " + formatDate(rule.lastUpdated));
    else if (rule.created) bits.push("Created " + formatDate(rule.created));
    return h("div", {
      style: {
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 8, marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.panel2}`,
        fontSize: 11, color: C.dim,
      },
    },
      h("span", null, bits.join("")),
      h("span", { style: { fontFamily: MONO } }, rule.id || "")
    );
  }

  function formatDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  // Hand the expression to the two sibling modules when they are loaded.
  function handoffButtons(expression) {
    const buttons = [];
    const createPopup =
      (host && typeof host.createPopup === "function" && host.createPopup) ||
      (window.orbPlugin && window.orbPlugin.createPopup);

    if (expression && typeof window.createOelPreview === "function" && createPopup) {
      buttons.push(
        smallButton("Preview matches", IconPlay(13), function () {
          close();
          const popupBody = createPopup("OEL Preview");
          const container = popupBody.appendChild(document.createElement("div"));
          container.style.minWidth = "820px";
          window.createOelPreview(container, {
            expression: expression,
            getJSON: host.getJSON,
            postJSON: host.postJSON,
            getLinks: host.getLinks,
          });
        }, "primary")
      );
    }

    if (expression && typeof window.createGroupRuleBuilder === "function" && createPopup) {
      buttons.push(
        smallButton("Open in Rule Builder", null, function () {
          close();
          const popupBody = createPopup("Okta Rule Builder");
          const container = popupBody.appendChild(document.createElement("div"));
          container.style.minWidth = "820px";
          const builder = window.createGroupRuleBuilder(container);
          const schema =
            window.orbPlugin && window.orbPlugin.loadUserSchema
              ? window.orbPlugin.loadUserSchema()
              : Promise.resolve(null);
          schema
            .then(function (s) {
              if (s) builder.setCustomAttributesFromSchema(s);
            })
            .finally(function () {
              builder.importExpressionText(expression);
            });
        })
      );
    }

    if (!buttons.length) return null;
    return h("div", {
      style: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 },
    }, buttons);
  }

  /* =========================================================================
     EXPRESSION RENDERING

     Okta group ids are the literal string "00g" followed by exactly 17 more
     alphanumeric characters, and they turn up inside the OEL wherever a rule
     references another group, most often in isMemberOfGroup and
     isMemberOfAnyGroup. An id tells an admin nothing at a glance, so every
     one is swapped for the group's display name and tinted blue to show the
     substitution.

     The length is pinned at 17 and fenced with boundary assertions on both
     sides. Without the trailing assertion the pattern would happily match the
     first 20 characters of a longer token and substitute a name into the
     middle of something that was never an id. Only group ids are touched, so
     app ids (0oa), user ids (00u), and policy ids are left as written.

     What is rendered is not runnable OEL, which is the point. The Copy button
     still hands over the original expression with its ids intact.
  ========================================================================= */
  const GROUP_ID_RE = /(?<![a-zA-Z0-9])00g[a-zA-Z0-9]{17}(?![a-zA-Z0-9])/g;
  const MAX_ID_LOOKUPS = 60; // ids past this stay as ids, to bound the requests

  function groupIdsIn(expression) {
    const out = [];
    const seen = new Set();
    let m;
    GROUP_ID_RE.lastIndex = 0;
    while ((m = GROUP_ID_RE.exec(expression)) !== null) {
      if (!seen.has(m[0])) {
        seen.add(m[0]);
        out.push(m[0]);
      }
    }
    return out;
  }

  /* =========================================================================
     ID TOOLTIP

     One tooltip element is created lazily and reused by every substituted
     name, rather than one per span, because a single rule can reference
     dozens of groups.

     The native title attribute is deliberately not used here. It waits about
     a second before appearing, cannot be styled, and renders the id in a
     proportional face where 0 and O are hard to tell apart. This shows
     instantly in the same mono face as the expression, which is what makes
     the id readable enough to copy by eye.
  ========================================================================= */
  let tipEl = null;

  function ensureTip() {
    if (tipEl && tipEl.parentNode) return tipEl;
    tipEl = h("div", {
      className: "orb-group-tip",
      style: {
        position: "fixed", top: "0px", left: "0px",
        zIndex: 2147483001, // one above the popover
        display: "none", pointerEvents: "none", // never eats the mouse
        maxWidth: "300px",
        background: C.text, color: C.text_light,
        border: `1px solid ${C.text}`, borderRadius: 6,
        padding: "4px 7px", fontFamily: MONO, fontSize: 11, lineHeight: 1.45,
        whiteSpace: "pre-wrap", wordBreak: "break-all",
        boxShadow: "0 4px 14px rgba(0,0,0,0.28)",
      },
    });
    document.body.appendChild(tipEl);
    return tipEl;
  }

  function showTip(target) {
    const text = target.getAttribute("data-orb-tip");
    if (!text) return;
    const tip = ensureTip();
    tip.textContent = text;
    tip.style.display = "block";

    // Centre above the name, flipping below when there is no room, and clamp
    // to the viewport so a long id near an edge stays fully visible.
    const r = target.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const pad = 6;

    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(pad, Math.min(left, window.innerWidth - tw - pad));

    let top = r.top - th - 6;
    if (top < pad) top = r.bottom + 6;

    tip.style.left = Math.round(left) + "px";
    tip.style.top = Math.round(top) + "px";
  }

  function hideTip() {
    if (tipEl) tipEl.style.display = "none";
  }

  function destroyTip() {
    if (tipEl && tipEl.parentNode) tipEl.parentNode.removeChild(tipEl);
    tipEl = null;
  }

  // A substituted name is a real anchor rather than a span with a click
  // handler, so middle-click, Cmd-click, and "Open in new tab" all behave the
  // way an admin expects. The href is relative, which keeps it correct on any
  // org's admin host without having to know the subdomain.
  function groupAdminUrl(id) {
    return "/admin/group/" + encodeURIComponent(id);
  }

  // Blue and slightly heavier than the surrounding mono text, with a faint
  // underline so the substitution still reads for anyone who cannot pick out
  // the color.
  function substitutedSpan(id) {
    const span = h("a", {
      className: "orb-group-name",
      href: groupAdminUrl(id),
      target: "_blank",
      rel: "noopener noreferrer",
      tabindex: "0", // stays focusable in the unresolvable case below, where
                     // the href is stripped
      "data-orb-group-id": id,
      "data-orb-tip": "Group ID\n" + id + "\n\nClick to open group in a new tab.",
      "aria-label": "Group ID " + id + ". Opens the group in a new tab.",
      style: {
        color: C.accent, fontWeight: 700,
        textDecoration: "underline dotted",
        textUnderlineOffset: "2px",
        cursor: "pointer",
        borderRadius: 3,
      },
      onMouseenter: function () { showTip(span); },
      onMouseleave: hideTip,
      onFocus: function () { showTip(span); },
      onBlur: hideTip,
      // The name sits inside the popover, whose own handlers watch for clicks
      // landing outside it. Stop the click here so following the link never
      // races with a close.
      onClick: function (e) { e.stopPropagation(); hideTip(); },
    }, id);
    return span;
  }

  // Build the expression block. Ids render as their own spans holding the raw
  // id, then each span's text is replaced the moment its name arrives, so the
  // popover shows the real expression immediately instead of a spinner.
  function expressionBlock(expression, rule) {
    const pre = h("pre", {
      style: {
        margin: 0, background: C.panel2, border: `1px solid ${C.border}`,
        borderRadius: 10, padding: 12, fontFamily: MONO, fontSize: 12.5,
        lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word",
        maxHeight: "34vh", overflowY: "auto",
      },
    });

    const ids = groupIdsIn(expression);
    if (!ids.length) {
      pre.appendChild(document.createTextNode(expression));
      return { pre: pre, substitutions: 0 };
    }

    seedGroupNames(rule);

    // Split on the ids, keeping them, so plain text and spans interleave.
    const spansById = new Map();
    let cursor = 0;
    let m;
    GROUP_ID_RE.lastIndex = 0;
    while ((m = GROUP_ID_RE.exec(expression)) !== null) {
      if (m.index > cursor) {
        pre.appendChild(document.createTextNode(expression.slice(cursor, m.index)));
      }
      const span = substitutedSpan(m[0]);
      pre.appendChild(span);
      if (!spansById.has(m[0])) spansById.set(m[0], []);
      spansById.get(m[0]).push(span);
      cursor = m.index + m[0].length;
    }
    if (cursor < expression.length) {
      pre.appendChild(document.createTextNode(expression.slice(cursor)));
    }

    ids.slice(0, MAX_ID_LOOKUPS).forEach(function (id) {
      resolveGroupName(id).then(function (name) {
        const spans = spansById.get(id) || [];
        spans.forEach(function (span) {
          if (name) {
            span.textContent = name;
          } else {
            // Could not name it. Drop the blue so the id is not mistaken for
            // a substituted name, and remove the link, because a group Okta
            // will not name is a group whose admin page has nothing to show.
            span.textContent = id;
            span.style.color = C.dim;
            span.style.fontWeight = 400;
            span.style.textDecoration = "none";
            span.style.cursor = "help";
            span.removeAttribute("href");
            span.removeAttribute("target");
            const why =
              "Group ID\n" + id +
              "\n\nThis group could not be found. It may have been deleted, " +
              "or this admin role may not be able to read it.";
            span.setAttribute("data-orb-tip", why);
            span.setAttribute("aria-label", why.replace(/\n+/g, " "));
          }
        });
        reposition();
      });
    });

    return { pre: pre, substitutions: Math.min(ids.length, MAX_ID_LOOKUPS) };
  }

  function renderRule(body, rule) {
    const expression =
      (rule.conditions && rule.conditions.expression && rule.conditions.expression.value) || "";

    const built = expression ? expressionBlock(expression, rule) : null;

    const exprBlock = built
      ? built.pre
      : h("div", { style: { fontSize: 12, color: C.dim } },
          "This rule stores no expression. It may be a basic attribute or group-membership rule.");

    const copyBtn = smallButton("Copy", IconCopy(13), function () {
      copyText(expression, copyBtn);
    });
    copyBtn.setAttribute(
      "title",
      built && built.substitutions
        ? "Copy the original expression, with group IDs rather than names"
        : "Copy the expression"
    );

    // Only explain the blue text when there is blue text to explain.
    const substitutionNote =
      built && built.substitutions
        ? h("div", { style: { fontSize: 11, color: C.dim, marginTop: 6 } },
            built.substitutions === 1
              ? "The group ID is shown by name. Hover the blue name to see the ID."
              : built.substitutions + " group IDs above are shown by name. Hover a blue name to see its ID.")
        : null;

    const targets = h("div", { style: { marginTop: 12 } },
      fieldLabel("Assigns members to"),
      spinnerRow("Loading groups")
    );

    body.textContent = "";
    appendChildren(body, [
      h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12 } },
        statusPill(rule.status),
        h("span", { style: { fontSize: 11, color: C.dim } },
          String(rule.status || "").toUpperCase() === "ACTIVE"
            ? "Rule is running"
            : "This rule is not currently running")
      ),
      h("div", {
        style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 },
      },
        fieldLabel("Okta Expression Language"),
        expression ? copyBtn : null
      ),
      exprBlock,
      substitutionNote,
      targets,
      excludeSummary(rule),
      handoffButtons(expression),
      metaRow(rule),
    ]);

    resolveGroupNames(rule).then(function (groups) {
      targets.textContent = "";
      appendChildren(targets, [
        fieldLabel("Assigns members to"),
        groups.length
          ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
              groups.map(function (g) {
                return h("a", {
                  href: g.resolved ? groupAdminUrl(g.id) : null,
                  target: g.resolved ? "_blank" : null,
                  rel: "noopener noreferrer",
                  title: g.resolved
                    ? "Group ID " + g.id + " (opens in a new tab)"
                    : "This group could not be found",
                  style: {
                    fontSize: 12, padding: "2px 8px", borderRadius: 10,
                    border: `1px solid ${C.border}`, background: C.panel,
                    color: g.resolved ? C.accent : C.dim,
                    fontFamily: g.resolved ? SANS : MONO,
                    textDecoration: "none",
                  },
                }, g.name);
              })
            )
          : h("div", { style: { fontSize: 12, color: C.dim } }, "No target groups listed"),
      ]);
      reposition();
    });
  }

  function renderMatches(body, matches) {
    if (matches.length === 1) {
      renderRule(body, matches[0]);
      reposition();
      return;
    }
    // Duplicate rule names are legal in Okta, so let the admin pick.
    const detail = h("div", null);
    const tabButtons = [];
    const selectTab = function (i) {
      tabButtons.forEach(function (b, j) {
        b.style.background = i === j ? C.accent : C.panel;
        b.style.color = i === j ? C.text_light : C.text;
      });
      renderRule(detail, matches[i]);
    };
    matches.forEach(function (r, i) {
      const b = smallButton(
        "Rule " + (i + 1) + " (" + (r.status || "?").toLowerCase() + ")",
        null,
        function () { selectTab(i); },
        i === 0 ? "primary" : null
      );
      tabButtons.push(b);
    });
    const tabs = h("div", {
      style: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 },
    }, tabButtons);
    body.textContent = "";
    appendChildren(body, [
      h("div", { style: { fontSize: 12, color: C.dim, marginBottom: 8 } },
        matches.length + " rules share this name."),
      tabs,
      detail,
    ]);
    selectTab(0);
    reposition();
  }

  function openFor(anchorEl, ruleName) {
    // Clicking the same button again closes the popover.
    if (openAnchor === anchorEl) {
      close();
      return;
    }
    close();

    const name = normalizeName(ruleName);
    const made = makePopover(name);
    openPop = made.pop;
    openAnchor = anchorEl;
    document.body.appendChild(openPop);
    place(openPop, anchorEl);

    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onOutside, true);
    window.addEventListener("resize", reposition, true);
    window.addEventListener("scroll", reposition, true);

    const myPop = openPop;
    findRuleByName(name)
      .then(function (matches) {
        if (myPop !== openPop) return; // popover was closed or replaced
        if (!matches.length) {
          made.body.textContent = "";
          appendChildren(made.body, [
            errorBox('No group rule named "' + name + '" was found. It may have been renamed or deleted since this membership was granted.'),
            h("div", { style: { marginTop: 10 } },
              smallButton("Retry", IconRefresh(13), function () {
                ruleCache.delete(name.toLowerCase());
                allRulesPromise = null;
                close();
                openFor(anchorEl, name);
              })),
          ]);
          reposition();
          return;
        }
        renderMatches(made.body, matches);
      })
      .catch(function (err) {
        if (myPop !== openPop) return;
        made.body.textContent = "";
        appendChildren(made.body, [
          errorBox("Could not load this rule. " + (err && err.message ? err.message : "Unknown error.")),
          h("div", { style: { marginTop: 10 } },
            smallButton("Retry", IconRefresh(13), function () {
              allRulesPromise = null;
              close();
              openFor(anchorEl, name);
            })),
        ]);
        reposition();
      });
  }

  /* =========================================================================
     Injection. Add one button per rule link in the People table, then keep
     watching, because Okta re-renders the table on paging, search, and tab
     switches.
  ========================================================================= */
  const RULE_LINK_SEL = "td.group-member-managedBy a, td[class*='managedBy'] a";

  function injectButtons() {
    const links = document.querySelectorAll(RULE_LINK_SEL);
    links.forEach(function (link) {
      if (link.getAttribute("data-orb-rule-viewer") === "1") return;
      const name = normalizeName(link.textContent);
      if (!name) return;
      link.setAttribute("data-orb-rule-viewer", "1");

      const btn = h("button", {
        type: "button",
        className: MARK,
        title: 'View the Okta Expression Language for "' + name + '"',
        style: {
          display: "inline-flex", alignItems: "center", gap: 4,
          marginLeft: 6, padding: "1px 7px",
          background: C.accent, color: C.text_light,
          border: `1px solid ${C.border}`, borderRadius: 10,
          fontFamily: SANS, fontSize: 11, fontWeight: 700, lineHeight: "16px",
          cursor: "pointer", verticalAlign: "middle", whiteSpace: "nowrap",
        },
        onClick: function (e) {
          e.preventDefault();
          e.stopPropagation();
          openFor(btn, name);
        },
      }, IconEye(11), h("span", null, "View Rule"));

      // Sit directly after the rule name, inside the same line.
      if (link.nextSibling) link.parentNode.insertBefore(btn, link.nextSibling);
      else link.parentNode.appendChild(btn);
    });
  }

  let observer = null;
  function inject(opts) {
    host = opts || {};
    injectButtons();
    if (observer) return;
    observer = new MutationObserver(function () {
      injectButtons();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function clearCache() {
    ruleCache.clear();
    groupNameCache.clear();
    groupNamePromises.clear();
    allRulesPromise = null;
  }

  if (typeof window !== "undefined") {
    window.orbRuleViewer = {
      inject: inject,
      openFor: openFor,
      findRuleByName: findRuleByName,
      close: close,
      clearCache: clearCache,
    };
  }
})();
