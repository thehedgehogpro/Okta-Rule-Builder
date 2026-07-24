/* ===========================================================================
   Okta OEL Preview — packaged as a mountable module for the rockstar
   extension. Given an Okta Expression Language string (the kind used in Group
   Rule conditions), it pages through the org's users and asks OKTA'S OWN
   expression engine which of them the rule matches, then lists the matches.

   Call createOelPreview(containerEl, opts) to render the UI into the given
   element (e.g. a rockstar popup body).

     opts = {
       expression: string,             // OEL to evaluate (auto-runs if present)
       getJSON:  fn(url)->Promise,      // host GET  (rockstar's getJSON)
       postJSON: fn({url,data})->Promise, // host POST (rockstar's postJSON)
       getLinks: fn(header)->{}         // host Link-header parser
     }

   If the host helpers aren't supplied, the module falls back to its own
   fetch()-based implementations using location.origin, so it also works
   standalone.

   HOW MATCHING WORKS:
   This build no longer re-implements OEL in JavaScript. Instead it calls the
   Okta Admin console's internal expression evaluator:

       POST /api/v1/internal/expression/eval
       [ { targets: { user: "<userId>" },
           value: "<expression>",
           type: "urn:okta:expression:1.0",
           operation: "CONDITION" }, ... ]

   The response is a parallel array; each element's `result` is the string
   "TRUE" or "FALSE" for the corresponding user (or an `error` object with
   errorCauses if the expression is invalid). Because this is the same engine
   the native Group Rule "Preview" uses, results match Okta exactly —
   including functions this tool never implemented (isMemberOf, getGroups,
   date/time functions, etc.).

   CAVEAT: /api/v1/internal/** is an UNDOCUMENTED, admin-console-internal
   endpoint. It isn't part of Okta's public API contract and can change or
   disappear without notice. If a future Okta release breaks it, this tool
   will surface the request error rather than silently returning wrong matches.

   Exposes: window.createOelPreview(containerEl, opts)
=========================================================================== */
function createOelPreview(_mountRoot, _opts) {
  if (!_mountRoot) throw new Error("createOelPreview: a container element is required");
  const opts = _opts || {};

  // Two independent limits:
  //  - USERS_PAGE_LIMIT is how many users we list per /api/v1/users request.
  //    Okta caps this at 200; requesting more is silently clamped, so 200 is
  //    the most we can fetch per page.
  //  - EVAL_BATCH is how many users we send in ONE POST to the internal
  //    expression evaluator. Although the endpoint accepts a larger array, it
  //    evaluates every entry server-side within a single request and times out
  //    somewhere above ~200 entries, so 200 is the safe practical ceiling.
  //    Don't raise this to "go faster" — use EVAL_CONCURRENCY instead.
  //  - EVAL_CONCURRENCY is how many of those 200-sized eval requests we run in
  //    parallel. Overlapping requests is what actually speeds up a large scan
  //    (network latency dominates), without making any single request big
  //    enough to time out.
  const USERS_PAGE_LIMIT = 100;
  const EVAL_BATCH = 100;
  const EVAL_CONCURRENCY = 10;

  /* ---- Host integration (rockstar) or standalone fallbacks --------------- */
  const _headers = { "X-Okta-User-Agent-Extended": "rockstar" };
  const hostPostJSON = typeof opts.postJSON === "function" ? opts.postJSON : null;

  // Returns a Promise resolving to { data, linkHeader }. We need the Link
  // header for pagination, so we always use fetch here (rockstar's getJSON
  // discards headers) but reuse the same relative-URL + headers convention.
  function fetchPage(url) {
    return fetch(location.origin + url, { headers: _headers }).then((res) => {
      if (!res.ok) {
        return res.text().then((body) => {
          throw new Error(errFrom(res.status, body));
        });
      }
      return res.json().then((data) => ({ data, linkHeader: res.headers.get("Link") }));
    });
  }

  // POST a JSON body and return the parsed JSON response. Uses the host's
  // postJSON when available (so the extension's XSRF token + headers apply),
  // otherwise falls back to fetch. The fallback tries to pick up the admin
  // console's XSRF token from the page, since the internal endpoint requires it.
  function postJSON(url, body) {
    if (hostPostJSON) return Promise.resolve(hostPostJSON({ url, data: body }));
    const h = Object.assign({ "Content-Type": "application/json" }, _headers);
    const tokenEl = typeof document !== "undefined" && document.getElementById("_xsrfToken");
    if (tokenEl && tokenEl.textContent) h["X-Okta-XsrfToken"] = tokenEl.textContent;
    return fetch(location.origin + url, {
      method: "POST", headers: h, credentials: "include", body: JSON.stringify(body),
    }).then((res) => {
      if (!res.ok) {
        return res.text().then((t) => { throw new Error(errFrom(res.status, t)); });
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

  // Turn anything we might catch into a readable string. rockstar's getJSON /
  // postJSON are jQuery ajax calls, so a failure rejects with a jqXHR object
  // (not an Error). Naively doing String(e) on that yields "[object Object]",
  // so pull the useful bits out of the shapes we actually see: Error, jqXHR,
  // Okta error body, or a plain string.
  function describeError(e) {
    if (e == null) return "Unknown error.";
    if (typeof e === "string") return e;
    if (e instanceof Error && e.message) return e.message;

    // jQuery jqXHR: prefer the parsed Okta error body, then raw text, then status.
    const okta = e.responseJSON || safeParse(e.responseText);
    if (okta) {
      if (okta.errorCauses && okta.errorCauses.length && okta.errorCauses[0].errorSummary) {
        return okta.errorCauses.map((c) => c.errorSummary).join("; ");
      }
      if (okta.errorSummary) return okta.errorSummary;
    }
    if (typeof e.status === "number") {
      const statusText = e.statusText && e.statusText !== "error" ? " " + e.statusText : "";
      return "HTTP " + e.status + statusText + (e.status === 0 ? " (request blocked or network error)" : "");
    }
    if (e.message) return e.message;
    // Last resort: a JSON dump beats "[object Object]".
    try { return JSON.stringify(e); } catch (_) { return String(e); }
  }
  function safeParse(t) { try { return t ? JSON.parse(t) : null; } catch (e) { return null; } }

  const parseLinks =
    typeof opts.getLinks === "function"
      ? opts.getLinks
      : function (linkHeader) {
          const links = {};
          if (!linkHeader) return links;
          linkHeader.split(/, */).forEach((part) => {
            const m = part.match(/<(.*)>; *rel="(.*)"/);
            if (m) links[m[2]] = m[1];
          });
          return links;
        };

  /* ===========================================================================
     Minimal DOM helper (mirrors the Group Rule Builder's h())
  =========================================================================== */
  function h(tag, props, ...children) {
    const el =
      tag === "svg" || SVG_TAGS.has(tag)
        ? document.createElementNS("http://www.w3.org/2000/svg", tag)
        : document.createElement(tag);
    if (props) {
      for (const key in props) {
        const val = props[key];
        if (val == null || val === false) continue;
        if (key === "style" && typeof val === "object") applyStyle(el, val);
        else if (key === "className") el.setAttribute("class", val);
        else if (/^on[A-Z]/.test(key)) el.addEventListener(key.slice(2).toLowerCase(), val);
        else if (key === "value") el.value = val; // property, so textarea/input actually shows it
        else if (key === "disabled") el.disabled = val;
        else if (key === "spellcheck") el.spellcheck = val;
        else el.setAttribute(camelToAttr(key), val);
      }
    }
    appendChildren(el, children);
    return el;
  }
  const SVG_TAGS = new Set(["svg", "line", "rect", "path", "polyline", "polygon", "circle"]);
  function camelToAttr(k) { return k === "viewBox" ? k : k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()); }
  function applyStyle(el, styleObj) {
    for (const prop in styleObj) {
      let v = styleObj[prop];
      if (typeof v === "number" && !UNITLESS.has(prop)) v = v + "px";
      el.style[prop] = v;
    }
  }
  const UNITLESS = new Set(["opacity", "fontWeight", "lineHeight", "zIndex", "flex", "flexGrow", "flexShrink", "order"]);
  function appendChildren(el, children) {
    for (const child of children) {
      if (child == null || child === false || child === true) continue;
      if (Array.isArray(child)) appendChildren(el, child);
      else if (child instanceof Node) el.appendChild(child);
      else el.appendChild(document.createTextNode(String(child)));
    }
  }
  function icon(children, size = 16) {
    return h("svg", {
      width: size, height: size, viewBox: "0 0 24 24", fill: "none",
      stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
    }, children);
  }
  const IconPlay = (s) => icon([h("polygon", { points: "5 3 19 12 5 21 5 3" })], s);
  const IconStop = (s) => icon([h("rect", { x: 6, y: 6, width: 12, height: 12, rx: 1 })], s);

  /* ===========================================================================
     Shared visual language with the Group Rule Builder
  =========================================================================== */
  const C = {
    bg: "#ffffff", panel: "#ffffff", panel2: "#E4EDFA",
    border: "#000000", text: "#000000", dim: "#324548",
    and: "#0066FF", or: "#ff6f0f", red_accent: "#ffc4c4",
    accent: "#2EEDED", output: "#c1ecf9", outputtext: "#000000",
    good: "#1f7a3d",
  };

  /* ===========================================================================
     STATE
  =========================================================================== */
  const state = {
    expression: opts.expression || "",
    inputError: null,
    running: false,
    cancelled: false,
    scanned: 0,
    matched: [],       // [{name, login}]
    error: null,
    done: false,
    evalErrors: 0,     // users Okta couldn't evaluate (e.g. missing attribute)
    lastEvalError: null,
    startedAt: 0,      // ms timestamp when the scan began
    elapsedMs: 0,      // total run time, set when the scan finishes
  };

  function validate() {
    state.inputError = null;
    if (!(state.expression || "").trim()) {
      state.inputError = "No expression provided.";
      return false;
    }
    return true;
  }

  /* ===========================================================================
     SCAN — page through users, evaluate each batch via Okta's own engine.
  =========================================================================== */
  function userDisplayName(u) {
    const p = u.profile || {};
    const first = p.firstName || "";
    const last = p.lastName || "";
    const full = (first + " " + last).trim();
    return full || p.displayName || p.login || u.id;
  }

  // Evaluate a batch of users against the expression using Okta's internal
  // expression evaluator. Returns an array of booleans parallel to `users`.
  async function evaluateBatch(users, expression) {
    const body = users.map((u) => ({
      targets: { user: u.id },
      value: expression,
      type: "urn:okta:expression:1.0",
      operation: "CONDITION",
    }));
    const resp = await postJSON("/api/v1/internal/expression/eval", body);

    // The endpoint returns an array parallel to the request. For each user the
    // entry is one of three outcomes (mirroring the native rule preview):
    //   result === "TRUE"  -> matches
    //   result === "FALSE" -> doesn't match
    //   error present       -> the expression couldn't be evaluated FOR THAT USER
    // A per-user error is NOT fatal: e.g. an expression referencing an
    // attribute the user doesn't have errors for that user but is fine for
    // others. We count those as non-matches and record why, so one bad user
    // doesn't abort a scan of thousands. (A globally-broken expression simply
    // errors on every user and yields zero matches, same as the native tool.)
    const arr = Array.isArray(resp) ? resp : (resp && Array.isArray(resp.results) ? resp.results : null);
    if (!arr) throw new Error("Unexpected response from expression evaluator.");

    return arr.map((entry) => {
      if (entry == null) return false;
      if (entry.error) {
        const causes = entry.error.errorCauses;
        const detail = Array.isArray(causes) && causes.length
          ? causes.map((c) => c.errorSummary).join("; ")
          : (entry.error.errorSummary || "Error in evaluating expression.");
        state.evalErrors++;
        state.lastEvalError = detail;
        return false;
      }
      // result is the string "TRUE"/"FALSE"; accept a real boolean too, just in case.
      return entry.result === "TRUE" || entry.result === true;
    });
  }

  async function runScan() {
    if (state.running) return;
    if (!validate()) { render(); return; }

    state.running = true;
    state.cancelled = false;
    state.scanned = 0;
    state.matched = [];
    state.error = null;
    state.done = false;
    state.evalErrors = 0;
    state.lastEvalError = null;
    state.startedAt = Date.now();
    state.elapsedMs = 0;
    render();

    const expression = state.expression.trim();

    // Evaluate one <=EVAL_BATCH buffer of users and fold results into state.
    // Each call closes over its own `buffer`, so parallel calls don't interfere
    // (the synchronous result-fold runs uninterrupted under JS's event loop).
    const flush = async (buffer) => {
      if (!buffer.length) return;
      const results = await evaluateBatch(buffer, expression);
      for (let k = 0; k < buffer.length; k++) {
        state.scanned++;
        if (results[k]) {
          const u = buffer[k];
          state.matched.push({
            name: userDisplayName(u),
            login: (u.profile && u.profile.login) || u.id,
          });
        }
      }
      renderProgress();
    };

    // Run a set of buffers as parallel eval requests, honoring cancellation.
    const flushGroup = async (buffers) => {
      if (state.cancelled || !buffers.length) return;
      await Promise.all(buffers.map(flush));
    };

    // List users 200 at a time (the hard page cap) and accumulate them. Once we
    // have enough for a full group of EVAL_CONCURRENCY batches, fire that group
    // of eval requests in parallel. Each request stays <=EVAL_BATCH so it can't
    // time out; parallelism is what provides the speed-up.
    const GROUP = EVAL_BATCH * EVAL_CONCURRENCY;
    let url = "/api/v1/users?limit=" + USERS_PAGE_LIMIT;
    let pending = [];
    try {
      while (url) {
        if (state.cancelled) break;
        const { data, linkHeader } = await fetchPage(url);
        pending = pending.concat(data);

        // Whenever we've buffered a full parallel group, evaluate it.
        while (pending.length >= GROUP) {
          if (state.cancelled) break;
          const group = pending.slice(0, GROUP);
          pending = pending.slice(GROUP);
          const buffers = [];
          for (let i = 0; i < group.length; i += EVAL_BATCH) {
            buffers.push(group.slice(i, i + EVAL_BATCH));
          }
          await flushGroup(buffers);
        }

        if (state.cancelled) break;
        const links = parseLinks(linkHeader);
        if (links.next) {
          const u = new URL(links.next);
          url = u.pathname + u.search;
        } else {
          url = null;
        }
      }

      // Evaluate whatever remains after the last page, still in parallel groups
      // of EVAL_CONCURRENCY batches at a time.
      while (!state.cancelled && pending.length) {
        const group = pending.slice(0, GROUP);
        pending = pending.slice(GROUP);
        const buffers = [];
        for (let i = 0; i < group.length; i += EVAL_BATCH) {
          buffers.push(group.slice(i, i + EVAL_BATCH));
        }
        await flushGroup(buffers);
      }
    } catch (e) {
      state.error = describeError(e);
    }

    state.running = false;
    state.done = !state.cancelled && !state.error;
    state.elapsedMs = Date.now() - state.startedAt;
    render();
  }

  /* ===========================================================================
     RENDER
  =========================================================================== */
  function panel(children, extra) {
    return h("div", {
      style: Object.assign({
        background: C.panel, border: `1px solid ${C.border}`,
        borderRadius: 14, padding: 18,
      }, extra || {}),
    }, children);
  }

  function primaryButton(label, iconEl, onClick, enabled) {
    return h("button", {
      onClick,
      disabled: !enabled,
      style: {
        display: "flex", alignItems: "center", gap: 6,
        background: enabled ? C.accent : C.panel2, color: enabled ? C.text : C.dim,
        border: `1px solid ${C.border}`, borderRadius: 8,
        cursor: enabled ? "pointer" : "not-allowed", opacity: enabled ? 1 : 0.6,
        fontSize: 13, padding: "9px 16px", fontWeight: 700,
      },
    }, iconEl, label);
  }

  function errorBox(text) {
    return h("div", {
      style: {
        marginTop: 14, background: C.red_accent, border: `1px solid ${C.border}`,
        borderRadius: 10, padding: 12, color: C.text, fontSize: 13, lineHeight: 1.5,
      },
    }, text);
  }

  // Human-friendly duration: "820 ms", "4.3 s", or "1 m 12 s".
  function formatElapsed(ms) {
    if (ms < 1000) return Math.round(ms) + " ms";
    const totalSec = ms / 1000;
    if (totalSec < 60) return totalSec.toFixed(1) + " s";
    const m = Math.floor(totalSec / 60);
    const s = Math.round(totalSec % 60);
    return m + " m " + s + " s";
  }

  function statusLine() {
    if (state.error) return errorBox("Couldn’t finish: " + state.error);
    if (state.inputError) return errorBox(state.inputError);
    const parts = [];
    parts.push(state.scanned.toLocaleString() + " users evaluated");
    parts.push(state.matched.length.toLocaleString() + " matched");
    if (state.evalErrors) parts.push(state.evalErrors.toLocaleString() + " couldn’t be evaluated");
    if (state.running) parts.push("evaluating…");
    else if (state.cancelled) parts.push("cancelled");
    else if (state.done) parts.push("done");
    // Show total run time once the scan has finished (done or cancelled).
    if (!state.running && state.elapsedMs) parts.push("time elapsed: " + formatElapsed(state.elapsedMs));
    const children = [
      h("div", { id: "oel-status", style: { fontSize: 13, color: C.dim, fontWeight: 600 } }, parts.join("  •  ")),
    ];
    // Explain the "couldn't be evaluated" bucket once, with Okta's own reason.
    // This is normal for expressions that reference an attribute some users
    // lack; those users simply don't match.
    if (state.evalErrors && state.lastEvalError) {
      children.push(h("div", {
        id: "oel-status-note",
        style: { fontSize: 12, color: C.dim, marginTop: 6, lineHeight: 1.5 },
      }, "Some users couldn’t be evaluated and were treated as non-matches — usually because the expression references an attribute they don’t have. Okta reported: “" + state.lastEvalError + "”."));
    }
    return h("div", { style: { marginTop: 14 } }, children);
  }

  const cellStyle = { padding: "8px 12px", borderTop: `1px solid ${C.border}`, color: C.text, textAlign: "left" };
  const monoCell = Object.assign({}, cellStyle, { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" });
  const headStyle = { padding: "9px 12px", textAlign: "left", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.5px", color: C.dim, fontWeight: 700 };

  function rowFor(m, idx) {
    return h("tr", { style: { background: idx % 2 ? C.panel2 : C.panel } },
      h("td", { style: cellStyle }, m.name),
      h("td", { style: monoCell }, m.login)
    );
  }

  function resultsTable() {
    if (!state.matched.length) {
      if (state.done && !state.error) {
        return h("p", { style: { color: C.dim, fontSize: 13, marginTop: 12 } },
          "No users matched this expression.");
      }
      return null;
    }
    return h("div", { style: { marginTop: 16, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" } },
      h("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: 13 } },
        h("thead", null,
          h("tr", { style: { background: C.output } },
            h("th", { style: headStyle }, "Name"),
            h("th", { style: headStyle }, "Username / Login")
          )
        ),
        h("tbody", { id: "oel-rows" }, state.matched.map(rowFor))
      )
    );
  }

  function App() {
    const canRun = !!(state.expression && state.expression.trim()) && !state.running;
    return h("div", {
      style: {
        fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
        background: C.bg, color: C.text, minHeight: "100%", padding: 24,
      },
    },
      h("div", { style: { maxWidth: 880, margin: "0 auto" } },
        h("div", { style: { marginBottom: 20 } },
          h("h1", { style: { fontSize: 22, margin: 0, fontWeight: 700 } }, "OEL Preview"),
          h("p", { style: { color: C.dim, fontSize: 13, margin: "4px 0 0" } },
            "Lists the users that match this Okta Expression Language rule. Users are evaluated by Okta’s own expression engine, so results match what the native Group Rule preview would show."),
          h("p", { style: { color: C.dim, fontSize: 12, margin: "6px 0 0" } },
            "Note: this uses an internal Okta endpoint that isn’t part of the public API, so a future Okta change could affect it."),
        ),
        panel([
          h("label", {
            style: { display: "block", fontSize: 12, textTransform: "uppercase", letterSpacing: "1px", color: C.dim, fontWeight: 600, marginBottom: 8 },
          }, "Expression"),
          h("textarea", {
            value: state.expression,
            onInput: (e) => { state.expression = e.target.value; },
            spellcheck: false,
            style: {
              width: "100%", boxSizing: "border-box", minHeight: 90,
              background: C.panel2, color: C.text, border: `1px solid ${C.border}`,
              borderRadius: 12, padding: 14, fontSize: 14, lineHeight: 1.6,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              outline: "none", resize: "vertical",
            },
          }),
          h("div", { style: { display: "flex", gap: 8, marginTop: 12, alignItems: "center" } },
            state.running
              ? primaryButton("Stop", IconStop(15), () => { state.cancelled = true; }, true)
              : primaryButton("Run preview", IconPlay(15), () => runScan(), canRun),
          ),
          statusLine(),
          resultsTable(),
        ]),
        h(
        "p",
        { style: { color: C.dim, fontSize: 10, marginTop: 8, lineHeight: 1.5 } },
        "Okta Rule Builder tool contributed by Tim McWeeny"
      )
      )
    );
  }

  // Full re-render (used on start/finish and errors).
  function render() {
    _mountRoot.textContent = "";
    _mountRoot.appendChild(App());
  }

  // Lightweight in-place update during scanning so we don't rebuild the whole
  // (potentially large) results table and lose scroll position on every tick.
  function renderProgress() {
    const status = _mountRoot.querySelector("#oel-status");
    if (status) {
      const parts = [
        state.scanned.toLocaleString() + " users evaluated",
        state.matched.length.toLocaleString() + " matched",
      ];
      if (state.evalErrors) parts.push(state.evalErrors.toLocaleString() + " couldn’t be evaluated");
      parts.push(state.running ? "evaluating…" : (state.cancelled ? "cancelled" : "done"));
      status.textContent = parts.join("  •  ");
    }
    const tbody = _mountRoot.querySelector("#oel-rows");
    if (tbody) {
      // Append only newly-added rows.
      const have = tbody.childElementCount;
      for (let idx = have; idx < state.matched.length; idx++) {
        tbody.appendChild(rowFor(state.matched[idx], idx));
      }
    } else if (state.matched.length) {
      // Table didn't exist yet (first match) — do a full render to create it.
      render();
    }
  }

  // Initial mount, then auto-run if an expression was supplied.
  render();
  if (state.expression && state.expression.trim()) {
    runScan();
  }

  // Handle for the host.
  return {
    render,
    runScan,
    get state() { return state; },
    setExpression(src) { state.expression = src || ""; render(); },
  };
}

if (typeof window !== "undefined") window.createOelPreview = createOelPreview;
