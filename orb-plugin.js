/* ===========================================================================
   orb-plugin.js — Okta Rule Builder + OEL Preview, standalone host
   ---------------------------------------------------------------------------
   This is the glue that USED to live inside rockstar.js. It replaces every
   dependency the two modules previously borrowed from the rockstar script so
   that "okta-rule-builder.js" and "oel-preview.js" can ship as their own
   Chrome extension with no rockstar (and no jQuery) present.

   What rockstar.js used to provide, and where it now lives here:

     rockstar helper            ->  orb-plugin replacement
     -------------------------      ----------------------------------------
     createPopup(title)         ->  createPopup(title)      (vanilla DOM)
     getJSON(url)               ->  getJSON(url)            (fetch)
     postJSON({url,data})       ->  postJSON({url,data})    (fetch + XSRF)
     getLinks(linkHeader)       ->  getLinks(linkHeader)
     $("#_xsrfToken")/ajaxSetup ->  getXsrfToken()          (reads the DOM node)
     injectGroupRuleModalButton ->  injectGroupRuleModalButton()
     page routing (/admin/...)  ->  boot()

   Load order in the extension manifest / injected scripts:
       1. okta-rule-builder.js   (defines window.createGroupRuleBuilder)
       2. oel-preview.js         (defines window.createOelPreview)
       3. orb-plugin.js          (this file — mounts them)

   The two modules already carry native-fetch fallbacks, so this file does NOT
   depend on jQuery. It only hands OEL Preview a postJSON + getLinks so the
   internal expression-eval endpoint receives the admin console's XSRF token.
=========================================================================== */
(function () {
  "use strict";

  // Shared header the modules and rockstar both send on Okta API calls.
  const OKTA_HEADERS = { "X-Okta-User-Agent-Extended": "orb-plugin" };

  /* =========================================================================
     XSRF — rockstar read #_xsrfToken once via jQuery and installed it with
     $.ajaxSetup. We read the same DOM node on demand instead, so a token that
     appears after load (SPA navigation) is still picked up.
  ========================================================================= */
  function getXsrfToken() {
    const el = document.getElementById("_xsrfToken");
    return el && el.textContent ? el.textContent.trim() : null;
  }

  /* =========================================================================
     HTTP helpers — vanilla-fetch equivalents of rockstar's jQuery ajax
     wrappers. Same relative-URL + headers convention (callers pass a path
     beginning with "/"; we prefix location.origin).
  ========================================================================= */
  function getJSON(url) {
    return fetch(location.origin + url, {
      headers: OKTA_HEADERS,
      credentials: "include",
    }).then((res) => {
      if (!res.ok) {
        return res.text().then((body) => {
          throw new Error(errFrom(res.status, body));
        });
      }
      return res.json();
    });
  }

  /* =========================================================================
     USER SCHEMA — load the org's custom profile attributes once per page and
     cache them. Rides the same getJSON (session cookie + XSRF headers) as every
     other admin API call, so there is no separate auth path. Resolves to the
     parsed schema object, or null on failure (callers treat null as "no custom
     attributes available" and fall back to the manual free-text box).
  ========================================================================= */
  let _userSchemaPromise = null;

  function loadUserSchema() {
    // Cache the PROMISE, not just the result, so two quick clicks don't fire
    // two fetches. Cached for the page lifetime; an SPA nav that reloads the
    // page starts fresh, which is what we want if the admin switched orgs.
    if (_userSchemaPromise) return _userSchemaPromise;
    _userSchemaPromise = getJSON("/api/v1/meta/schemas/user/default").catch(
      function (err) {
        // Don't cache a failure — clear it so a later open can retry.
        _userSchemaPromise = null;
        console.warn("[orb] user schema load failed:", err && err.message);
        return null;
      }
    );
    return _userSchemaPromise;
  }

  // Mirrors rockstar's postJSON({url, data}) signature exactly, since that is
  // what oel-preview.js calls: hostPostJSON({ url, data: body }).
  function postJSON(settings) {
    const s = settings || {};
    const h = Object.assign({ "Content-Type": "application/json" }, OKTA_HEADERS);
    const token = getXsrfToken();
    if (token) h["X-Okta-XsrfToken"] = token;
    return fetch(location.origin + s.url, {
      method: "POST",
      headers: h,
      credentials: "include",
      body: JSON.stringify(s.data),
    }).then((res) => {
      if (!res.ok) {
        return res.text().then((body) => {
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

  // Link-header parser — same output shape as rockstar's getLinks
  // ({ next: url, self: url, ... }). Tolerant of optional whitespace.
  function getLinks(linkHeader) {
    const links = {};
    if (!linkHeader) return links;
    linkHeader.split(/, */).forEach((part) => {
      const m = part.match(/<(.*)>; *rel="(.*)"/);
      if (m) links[m[2]] = m[1];
    });
    return links;
  }

  /* =========================================================================
     POPUP — a dependency-free stand-in for rockstar's createPopup(title).
     Returns the popup BODY element (rockstar returned the jQuery body object;
     the modules only ever call container.appendChild / .innerHTML on it, so a
     raw element is a drop-in). A close "X" removes the whole popup.
  ========================================================================= */
  function createPopup(title) {
    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      position: "absolute",
      zIndex: 2000, // above Okta's aria-modal (z-index 1002), as rockstar did
      top: "60px",
      left: "50%",
      transform: "translateX(-50%)",
      maxHeight: "calc(100% - 100px)",
      maxWidth: "calc(100% - 25px)",
      padding: "8px",
      margin: "4px",
      overflow: "auto",
      background: "#ffffff",
      border: "1px solid #ddd",
      borderRadius: "6px",
      boxShadow: "0 8px 30px rgba(0,0,0,0.18)",
      font: "13px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif",
    });

    const bar = document.createElement("div");
    Object.assign(bar.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "12px",
      marginBottom: "8px",
    });

    const heading = document.createElement("span");
    heading.textContent = title || "";
    heading.style.fontWeight = "bold";

    const controls = document.createElement("div");

    const help = document.createElement("a");
    help.href = "https://github.com/thehedgehogpro/Okta-Rule-Builder";
    help.target = "_blank";
    help.rel = "noopener";
    help.textContent = "?";
    help.style.marginRight = "10px";
    help.style.textDecoration = "none";

    const close = document.createElement("a");
    close.textContent = "X";
    close.style.cursor = "pointer";
    close.style.fontWeight = "bold";
    close.addEventListener("click", () => wrap.remove());

    controls.appendChild(help);
    controls.appendChild(close);
    bar.appendChild(heading);
    bar.appendChild(controls);
    wrap.appendChild(bar);

    const body = document.createElement("div");
    wrap.appendChild(body);

    document.body.appendChild(wrap);
    return body;
  }

  /* =========================================================================
     MODAL INJECTOR — verbatim behaviour of rockstar's
     injectGroupRuleModalButton(), rewritten to use the helpers above. Adds the
     two launcher buttons to Okta's native Add/Edit/View Group Rule modal and
     wires them to the two modules' public APIs.
  ========================================================================= */
  function injectGroupRuleModalButton() {
    const SAVE_SEL = '.o-form-button-bar input[data-type="save"]';
    const CLOSE_SEL = '.o-form-button-bar input[data-type="cancel"]';
    const EXPR_SEL = 'textarea[name="conditions.expression.value"]';
    const MARK = "orb-rulebuilder-launcher";

    function tryInject() {
      const anchorBtn =
        document.querySelector(SAVE_SEL) || document.querySelector(CLOSE_SEL);
      if (!anchorBtn) return;
      const bar = anchorBtn.closest(".o-form-button-bar");
      if (!bar || bar.querySelector("." + MARK)) return; // already added

      /* ---- Launcher 1: Open in Rule Builder ---------------------------- */
      const launch = document.createElement("input");
      launch.type = "button";
      launch.value = "Open in Rule Builder";
      launch.className = "button " + MARK;
      launch.style.marginRight = "8px";
      anchorBtn.parentNode.insertBefore(launch, anchorBtn);

      launch.addEventListener("click", function () {
        const expr = document.querySelector(EXPR_SEL);
        if (typeof window.createGroupRuleBuilder !== "function") {
          const p = createPopup("Okta Rule Builder");
          p.textContent =
            "Okta Rule Builder failed to load. Ensure okta-rule-builder.js is included and loaded before orb-plugin.js.";
          return;
        }

        const builderPopup = createPopup("Okta Rule Builder");
        const container = builderPopup.appendChild(document.createElement("div"));
        container.style.minWidth = "820px";

        const builder = window.createGroupRuleBuilder(container);

        // Load custom attributes first, THEN import the existing expression, so
        // attributes like user.jobCode resolve to their dropdown entry instead
        // of the manual box. The schema fetch is cached, so this is instant on
        // reopen. If the schema fails/empties, importing still works — those
        // attributes just stay in the manual box (and would snap into place
        // later via the builder's reconcile step if attributes arrive).
        const advancedRadio = document.querySelector(
          'input[data-se-name="__activeBuilder__"][value="EDITOR"]'
        );
        const isAdvanced = !!(advancedRadio && advancedRadio.checked);

        function importExisting() {
          if (!(expr && expr.value.trim())) return;
          if (isAdvanced) {
            const res = builder.importExpressionText(expr.value);
            if (res && !res.ok) {
              const note = document.createElement("div");
              note.style.cssText = "color:#b00;font-size:12px;margin:8px 0;";
              note.textContent =
                "Could not parse the existing expression. (" + res.error + ")";
              container.insertBefore(note, container.firstChild);
            }
          } else {
            const res = builder.loadExpression(expr.value);
            if (!res.ok) {
              const note = document.createElement("div");
              note.style.cssText = "color:#b00;font-size:12px;margin:8px 0;";
              note.textContent =
                "Could not parse the existing expression; starting from a blank builder. (" +
                res.error +
                ")";
              container.insertBefore(note, container.firstChild);
            }
          }
        }

        loadUserSchema()
          .then(function (schema) {
            if (schema) builder.setCustomAttributesFromSchema(schema);
          })
          .finally(importExisting);

        // "Apply to Okta rule" — write the generated expression back into the
        // textarea and fire input/change so Okta's form model updates.
        const applyBar = document.createElement("div");
        applyBar.style.cssText = "margin-top:12px;text-align:right;";
        const apply = document.createElement("input");
        apply.type = "button";
        apply.className = "button button-primary";
        apply.value = "Apply to Okta rule";
        apply.addEventListener("click", function () {
          if (!expr) {
            alert("Could not find the expression field on this rule form.");
            return;
          }
          const generated = builder.getExpression();
          if (!generated) {
            alert("The builder has no complete conditions yet.");
            return;
          }
          const advanced = document.querySelector(
            'input[data-se-name="__activeBuilder__"][value="EDITOR"]'
          );
          if (advanced && !advanced.checked) advanced.click();

          expr.value = generated;
          expr.dispatchEvent(new Event("input", { bubbles: true }));
          expr.dispatchEvent(new Event("change", { bubbles: true }));
          builderPopup.parentNode.remove(); // close the popup (body -> wrap)
        });
        applyBar.appendChild(apply);
        builderPopup.appendChild(applyBar);
      });

      /* ---- Launcher 2: Preview OEL Rule -------------------------------- */
      const preview = document.createElement("input");
      preview.type = "button";
      preview.value = "Preview OEL Rule";
      preview.className = "button " + MARK + "-preview";
      preview.style.marginRight = "8px";
      anchorBtn.parentNode.insertBefore(preview, anchorBtn);

      preview.addEventListener("click", function () {
        const expr = document.querySelector(EXPR_SEL);
        if (typeof window.createOelPreview !== "function") {
          const p = createPopup("OEL Preview");
          p.textContent =
            "OEL Preview failed to load. Ensure oel-preview.js is included and loaded before orb-plugin.js.";
          return;
        }
        if (!expr || !expr.value.trim()) {
          const p = createPopup("OEL Preview");
          p.textContent =
            'There is no expression to preview. Switch the IF condition to "Use Okta Expression Language" and enter a rule first.';
          return;
        }

        const previewPopup = createPopup("OEL Preview");
        const container = previewPopup.appendChild(document.createElement("div"));
        container.style.minWidth = "820px";

        // Hand the tool our request helpers so it uses the extension's
        // headers, XSRF token, and Link-header parsing.
        window.createOelPreview(container, {
          expression: expr.value,
          getJSON,
          postJSON,
          getLinks,
        });
      });
    }

    tryInject();
    new MutationObserver(tryInject).observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  /* =========================================================================
     BOOT — rockstar only wired these launchers on admin hosts at
     /admin/groups. Preserve that guard so the observer isn't installed on
     unrelated pages. Adjust the guard if the extension's match patterns differ.
  ========================================================================= */
  function boot() {
    const isAdminHost = /-admin/.test(location.host);
    const isGroupsPage = location.pathname === "/admin/groups";
    if (!isAdminHost || !isGroupsPage) return;

    if (document.body) {
      injectGroupRuleModalButton();
    } else {
      document.addEventListener("DOMContentLoaded", injectGroupRuleModalButton, {
        once: true,
      });
    }
  }

  boot();

  // Expose the host surface so a popup UI, another script, or manual testing
  // can drive the same helpers rockstar used to own.
  if (typeof window !== "undefined") {
    window.orbPlugin = {
      createPopup,
      getJSON,
      postJSON,
      getLinks,
      getXsrfToken,
      loadUserSchema,
      injectGroupRuleModalButton,
    };
  }
})();
