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
       3. orb-rule-viewer.js     (defines window.orbRuleViewer)
       4. orb-group-export.js    (defines window.orbGroupExport)
       5. verify-mfa.js          (defines window.orbVerifyMfa)
       6. orb-plugin.js          (this file — mounts them)

   The two modules already carry native-fetch fallbacks, so this file does NOT
   depend on jQuery. It only hands OEL Preview a postJSON + getLinks so the
   internal expression-eval endpoint receives the admin console's XSRF token.
=========================================================================== */
(function () {
  "use strict";

  // Shared header the modules and rockstar both send on Okta API calls.
  const OKTA_HEADERS = { "X-Okta-User-Agent-Extended": "orb-plugin" };

  /* =========================================================================
     ORB UI — the one place any ORB-injected button gets built

     Every button this extension adds to the Okta console should look like an
     Okta button and carry the white corner dot marking it as ours. Keeping
     that in one factory means a change to the badge, or to which Okta classes
     we borrow, lands everywhere at once instead of being copy-pasted into
     each module.

     Exposed two ways, because this file and the modules need it at different
     times. window.orbUI is available to anything running after this file
     loads, and the same object goes to each module as host.ui when it is
     mounted, so a module never has to reach for a global.

     VARIANTS map to the Okta button shapes we sit beside:

       toolbar-primary   blue <a> in a page toolbar, matching "Assign people",
                         "Add group", and "Assign"
       toolbar           the quieter <a> in the same toolbars
       form              <input type="button"> in a modal's .o-form-button-bar,
                         matching Save and Cancel

     A caller needing some other shape can pass className to extend one.
  ========================================================================= */
  const ORB_MARK = "orb-injected";
  const ORB_BADGE_SIZE = 9;

  const ORB_VARIANTS = {
    "toolbar-primary": { tag: "a", className: "button-primary link-button" },
    toolbar: { tag: "a", className: "link-button" },
    form: { tag: "input", className: "button" },
  };

  const orbUI = {
    MARK: ORB_MARK,
    badgeSize: ORB_BADGE_SIZE,

    /* Build a button. Does not insert it, so pass it to place() for that.
         label       visible text
         title       tooltip. " (added by the ORB extension)" is appended, so
                     provenance is available on hover and to screen readers,
                     since the dot itself is decorative
         variant     key from ORB_VARIANTS, default "toolbar-primary"
         className   extra classes, added after the variant's own
         onClick     handler. Anchor variants get preventDefault

       The form variant comes back already wrapped in a shell, because <input>
       is a void element and cannot hold the badge as a child. Callers still
       get the input itself, so class checks and click handlers work as
       expected; place() and addBadge() find the shell via outerOf().
       ------------------------------------------------------------------- */
    createButton(opts) {
      const o = opts || {};
      const spec = ORB_VARIANTS[o.variant] || ORB_VARIANTS["toolbar-primary"];
      const el = document.createElement(spec.tag);

      if (spec.tag === "input") {
        el.type = "button";
        el.value = o.label || "";
      } else {
        el.href = "#";
        el.setAttribute("data-se", "button");
        el.textContent = o.label || "";
      }
      el.className = spec.className + " " + ORB_MARK +
        (o.className ? " " + o.className : "");
      if (o.title) el.title = o.title + " (added by the ORB extension)";

      if (typeof o.onClick === "function") {
        el.addEventListener("click", function (e) {
          if (spec.tag === "a") e.preventDefault();
          o.onClick(e);
        });
      }

      if (spec.tag === "input") orbUI._shellFor(el);
      return el;
    },

    /* The node that represents this button in layout: the shell for a form
       button, otherwise the button itself. Anything positioning, spacing, or
       inserting a button must go through this, or a form button ends up with
       its margin inside the shell and its badge measured against the wrong
       box.
       ------------------------------------------------------------------- */
    outerOf(btn) {
      return (btn && btn._orbOuter) || btn;
    },

    // inline-flex rather than inline-block, so the shell's box hugs the input
    // exactly. An inline-block leaves baseline descender space below its
    // content, which pushes the shell's top edge above the button's and the
    // badge along with it.
    _shellFor(input) {
      if (input._orbOuter) return input._orbOuter;
      const shell = document.createElement("span");
      shell.className = ORB_MARK + "-shell";
      shell.style.cssText =
        "position:relative;display:inline-flex;vertical-align:middle";
      shell.appendChild(input);
      input.style.margin = "0"; // spacing belongs to the shell
      input._orbOuter = shell;
      return shell;
    },

    /* The white corner dot. Details that keep it from misbehaving:
         - pointer-events none, so it can never intercept a click meant for
           the button underneath it
         - position and overflow set explicitly, since an Okta class could
           otherwise clip the dot or leave it positioning against a distant
           ancestor
         - a thin dark border, because pure white alone would vanish on a pale
           button
       For a bare button this must run AFTER it is in the document, since
       getComputedStyle does not resolve values for a detached element and the
       position check below would be unreliable. place() handles the ordering.
       A form button's shell is already positioned by us, so it needs no check.
       ------------------------------------------------------------------- */
    addBadge(btn) {
      if (!btn) return btn;
      const host = orbUI.outerOf(btn);
      if (host.querySelector("." + ORB_MARK + "-badge")) return btn; // already badged

      // A shell is ours and already position:relative. Only a bare button
      // needs checking, since an Okta class may have positioned it already.
      if (host === btn && getComputedStyle(host).position === "static") {
        host.style.position = "relative";
      }
      host.style.overflow = "visible";

      const offset = -Math.round(ORB_BADGE_SIZE / 3);
      const dot = document.createElement("span");
      dot.className = ORB_MARK + "-badge";
      dot.setAttribute("aria-hidden", "true");
      dot.style.cssText = [
        "position:absolute",
        "top:" + offset + "px",
        "right:" + offset + "px",
        "width:" + ORB_BADGE_SIZE + "px",
        "height:" + ORB_BADGE_SIZE + "px",
        "border-radius:50%",
        "background:#ffffff",
        "border:1px solid rgba(0,0,0,0.35)",
        "box-sizing:content-box",
        "pointer-events:none",
        "z-index:1",
      ].join(";");
      host.appendChild(dot);
      return btn;
    },

    /* Insert a button and finish it off.
         parent      container, inferred from `before` when omitted
         before      insert ahead of this node, or omit to append
         layoutFrom  copy this element's computed float, so the button joins
                     the same row rather than dropping below it. Not always
                     the neighbour itself: in Okta's app toolbar the floating
                     element is the .dropdown box wrapping the link
         margin      CSS margin, default "0 8px"

       Float, margin, and insertion all target outerOf(btn), so a form button's
       spacing lands on its shell rather than inside it. Margin sits outside
       the input's border box but inside the shell's, so 8px left on the input
       would make the shell wider than the button and slide the badge into the
       gap beside it.
       ------------------------------------------------------------------- */
    place(btn, opts) {
      const o = opts || {};
      const parent = o.parent || (o.before && o.before.parentNode);
      if (!btn || !parent) return btn;

      const node = orbUI.outerOf(btn);
      if (o.layoutFrom) {
        const f = getComputedStyle(o.layoutFrom).float;
        if (f && f !== "none") node.style.float = f;
      }
      node.style.margin = o.margin || "0 8px";

      if (o.before) parent.insertBefore(node, o.before);
      else parent.appendChild(node);

      orbUI.addBadge(btn);
      return btn;
    },
  };

  if (typeof window !== "undefined") window.orbUI = orbUI;

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
  let _modalObserver = null;

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
      const launch = orbUI.createButton({
        label: "Open in Rule Builder",
        title: "Build or edit this rule's expression visually",
        variant: "form",
        className: MARK,
      });
      orbUI.place(launch, { before: anchorBtn, margin: "0 8px 0 0" });

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
      const preview = orbUI.createButton({
        label: "Preview OEL Rule",
        title: "See which users this expression matches",
        variant: "form",
        className: MARK + "-preview",
      });
      orbUI.place(preview, { before: anchorBtn, margin: "0 8px 0 0" });

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
    if (_modalObserver) return; // boot() can run again on SPA navigation
    _modalObserver = new MutationObserver(tryInject);
    _modalObserver.observe(document.body, { childList: true, subtree: true });
  }

  /* =========================================================================
     RULE VIEWER MOUNT — orb-rule-viewer.js owns the "View Rule" buttons in a
     group's People table and the popover that shows each rule's OEL. Hand it
     the same request helpers so its API calls carry the extension's headers
     and, where needed, the console's XSRF token.
  ========================================================================= */
  function mountRuleViewer() {
    if (!window.orbRuleViewer) {
      console.warn(
        "[orb] orb-rule-viewer.js is not loaded, so the View Rule buttons were skipped."
      );
      return;
    }
    window.orbRuleViewer.inject({
      getJSON,
      postJSON,
      getLinks,
      createPopup,
      loadUserSchema,
      ui: orbUI,
    });
  }

  /* =========================================================================
     EXPORT MOUNT — orb-group-export.js owns the "Download" buttons in a
     group's People toolbar and an app's Assignments toolbar, plus the CSV
     column picker behind them. loadUserSchema matters here: the picker builds
     its column list from the org's profile schema rather than from the rows,
     so handing over the cached copy means the picker opens without a fetch
     when the Rule Builder has already loaded it.
  ========================================================================= */
  function mountExport() {
    const mod = window.orbExport || window.orbGroupExport;
    if (!mod) {
      console.warn(
        "[orb] orb-group-export.js is not loaded, so the Download buttons were skipped."
      );
      return;
    }
    mod.inject({
      getJSON,
      getLinks,
      loadUserSchema,
      ui: orbUI,
    });
  }

  /* =========================================================================
     VERIFY MFA MOUNT — verify-mfa.js owns the "Verify MFA" button in a user
     profile's toolbar and the Okta Verify challenge behind it. It needs
     postJSON specifically: the challenge is a POST to the admin API, so it
     only works with the console's XSRF token attached. No loadUserSchema
     here, since the module reads factors rather than profile attributes.
  ========================================================================= */
  function mountVerifyMfa() {
    if (!window.orbVerifyMfa) {
      console.warn(
        "[orb] verify-mfa.js is not loaded, so the Verify MFA button was skipped."
      );
      return;
    }
    window.orbVerifyMfa.inject({
      getJSON,
      postJSON,
      getLinks,
      createPopup,
      ui: orbUI,
    });
  }

  /* =========================================================================
     WORKFLOWS MOUNT — workflows.js owns the flow search bar in the Workflows
     Console header. It is the first module that runs off the admin host, so it
     gets orbUI and nothing else: its API calls go to the Workflows origin
     rather than the admin one, and it owns its own fetch so the folder crawl
     can see status codes and back off on a 429. Handing it getJSON would point
     it at the wrong error shape, not the wrong host, but the distinction is
     worth keeping explicit.
  ========================================================================= */
  function mountWorkflows() {
    if (!window.orbWorkflows) {
      console.warn(
        "[orb] workflows.js is not loaded, so the flow search bar was skipped."
      );
      return;
    }
    window.orbWorkflows.inject({ ui: orbUI });
  }

  /* =========================================================================
     GROUP ID LABEL — a group page shows the name and the description but never
     the group's ID, so an admin who needs it for an API call or a rule has to
     read it back out of the URL. We append it to the description line instead.

     The label goes INSIDE .group-desc rather than beside it, so it inherits
     the description's font, size, and colour and there is no styling of our
     own to keep in sync as Okta's changes.

     Same MutationObserver pattern as the other injectors, because the console
     renders the group header after the initial load and swaps it in place when
     the admin moves to another group. Storing the id on the label covers that
     second case: without it, a swapped-in header would keep showing the
     previous group's ID.
  ========================================================================= */
  const GROUP_ID_PATH = /^\/admin\/group\/([^\/?#]+)/;
  let _groupIdObserver = null;

  function groupIdFromPath() {
    const m = GROUP_ID_PATH.exec(location.pathname);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function injectGroupIdLabel() {
    const MARK = "orb-group-id";

    function tryInject() {
      const id = groupIdFromPath();
      if (!id) return; // the groups list, not a single group
      const desc = document.querySelector(".group-desc");
      if (!desc) return; // header not rendered yet, or the group has no description

      const existing = desc.querySelector("." + MARK);
      if (existing) {
        if (existing.dataset.orbGroupId !== id) {
          existing.dataset.orbGroupId = id;
          existing.textContent = "Group ID: " + id;
        }
        return;
      }

      const label = document.createElement("span");
      label.className = ORB_MARK + " " + MARK;
      label.dataset.orbGroupId = id;
      label.title = "Group ID (added by the ORB extension)";
      // Only space it off an actual description, so a group without one does
      // not get its label pushed in from the left edge.
      if (desc.textContent.trim()) label.style.marginLeft = "6px";
      label.textContent = "Group ID: " + id;
      desc.appendChild(label);
    }

    tryInject();
    if (_groupIdObserver) return; // start() can run again on SPA navigation
    _groupIdObserver = new MutationObserver(tryInject);
    _groupIdObserver.observe(document.body, { childList: true, subtree: true });
  }

  /* =========================================================================
     BOOT — rockstar only wired the rule-modal launchers on admin hosts at
     /admin/groups. The View Rule buttons live one level deeper, on a single
     group's People tab (/admin/group/<groupId>), and the Download buttons add
     a third and fourth shape, an app instance's Assignments tab and the People
     page (/admin/users), so the guard now covers all of them, plus a fifth:
     a single user's profile page (/admin/user/profile/view/<userId>), where the
     Verify MFA button lives. The rule-builder and rule-viewer pieces stay
     group-only, and Verify MFA stays profile-only. Everything below is
     idempotent, which lets us re-run on history changes when the console swaps
     views without a full page load.
  ========================================================================= */
  const GROUP_PATH = /^\/admin\/group(s)?(\/|$)/;
  const APP_INSTANCE_PATH = /^\/admin\/app\/[^\/?#]+\/instance\//;
  const USER_PROFILE_PATH = /^\/admin\/user\/profile\/view\/[^\/?#]+/;
  // The People page itself, anchored so it does not swallow a deeper
  // /admin/users/... screen. Distinct from USER_PROFILE_PATH above, which is
  // one user (singular /admin/user/).
  const USERS_LIST_PATH = /^\/admin\/users\/?$/;

  function start() {
    const path = location.pathname;
    const onGroup = GROUP_PATH.test(path);
    const onApp = APP_INSTANCE_PATH.test(path);
    const onUser = USER_PROFILE_PATH.test(path);
    const onUsersList = USERS_LIST_PATH.test(path);
    if (!onGroup && !onApp && !onUser && !onUsersList) return;

    if (onGroup) {
      injectGroupRuleModalButton();
      mountRuleViewer();
      injectGroupIdLabel();
    }
    if (onUser) mountVerifyMfa();
    if (onGroup || onApp || onUsersList) mountExport();
  }

  /* Two consoles, two hosts. The admin console is <org>-admin.<domain> and
     everything above targets it. The Workflows Console is a separate app at
     <org>.workflows.<domain>, so it gets its own entry point rather than being
     squeezed past the -admin guard. A host that is neither gets nothing, which
     is most of what the content script's match patterns cover: the end-user
     dashboard, the sign-in widget, and every app the org has behind Okta. */
  const WORKFLOWS_HOST = /(^|\.)workflows\./;

  function startWorkflows() {
    mountWorkflows();
  }

  function boot() {
    const onAdmin = /-admin/.test(location.host);
    const onWorkflows = WORKFLOWS_HOST.test(location.host);
    if (!onAdmin && !onWorkflows) return;

    const entry = onWorkflows ? startWorkflows : start;

    if (document.body) entry();
    else document.addEventListener("DOMContentLoaded", entry, { once: true });

    // The console changes the URL without reloading in places, so re-check.
    window.addEventListener("popstate", entry);
    window.addEventListener("hashchange", entry);
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
      injectGroupIdLabel,
      groupIdFromPath,
      mountRuleViewer,
      mountGroupExport: mountExport, // old name, kept as an alias
      mountExport,
      mountVerifyMfa,
      mountWorkflows,
    };
  }
})();
