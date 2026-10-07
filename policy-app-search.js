/* ===========================================================================
   policy-app-search.js — "Search by application" on the app sign-in
   authentication policies page (/admin/authentication-policies/app-sign-in).

   Natively, the Auth Policy page only lists policies and lets you search by their names,
   but given an app, which policy governs it? Today that means opening policies one at a time and reading their Applications
   tab. This tool adds a second search field beside the existing one that searches
   apps and jumps straight to the policy it is mapped to.

   HOW THE APP-TO-POLICY LOOKUP WORKS
   ----------------------------------
   Every app object in an Identity Engine org carries the mapping already, in
   _links.accessPolicy.href, which points at /api/v1/policies/{policyId}. And
   /api/v1/apps?q= returns whole app object, links included. So the whole
   search only costs one request and nothing at all on selection, so no
   neet to walk through every policy's /mappings collection.

   Apps without that link do exist: Classic-mode sign-on and a few app types
   have no authentication policy. Those stay in the results list, since
   hiding them would look like the search was broken, but display a note
   to the effect if clicked.

   WHY THE FIELD UI IS CLONED OFF OKTA'S RATHER THAN BUILT
   -----------------------------------------
   The native Policy page is React with emotion class names (gyiuhfb-1ggsp5q and friends).
   Those hashes may change on any Okta build, so none of them can be selected on.
   Hand-building a matching Odyssey text field would mean copying styles
   that can go stale the same way. Instead the module clones the existing search
   field's MuiFormControl wrapper, which inherits Okta's current styling, including the magnifier icon.

   So cloneNode copies attributes but not the expando properties React stores
   its fiber under, so the clone is inert as far as React is concerned.
=========================================================================== */
(function () {
  "use strict";

  const MARK = "orb-app-policy-search";
  const INPUT_ID = "orb-app-policy-search-input";
  const PLACEHOLDER = "Search by application";
  const POLICY_BASE = "/admin/authentication-policies/app-sign-in/";

  // The corner dot is decorative and aria-hidden, so the same provenance the
  // other ORB controls put in a tooltip goes on the input instead.
  const PROVENANCE =
    "Search applications to find the authentication policy assigned to them" +
    " (added by the ORB extension)";

  const MIN_CHARS = 2;
  const DEBOUNCE_MS = 250;
  const RESULT_LIMIT = 20;

  // Marks a dropdown row and carries its index into options[]. Selection is
  // delegated off this attribute rather than a closure per row, so rebuilding
  // the list cannot strip the handler. See DROPDOWN below.
  const ROW_ATTR = "data-orb-index";

  let host = null; // { getJSON }

  // Backspacing through a term should not re-hit the API for something just typed.
  const searchCache = new Map();

  function el(tag, style, text) {
    const node = document.createElement(tag);
    if (style) node.style.cssText = style;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* =========================================================================
     LOOKUP
  ========================================================================= */

  function searchApps(term) {
    const key = term.toLowerCase();
    if (searchCache.has(key)) return searchCache.get(key);

    const path =
      "/api/v1/apps?q=" + encodeURIComponent(term) + "&limit=" + RESULT_LIMIT;

    const promise = host
      .getJSON(path)
      .then(function (apps) {
        return (apps || []).map(function (app) {
          return {
            id: app.id,
            label: app.label || app.name || app.id,
            name: app.name,
            status: app.status,
            signOnMode: app.signOnMode,
            policyId: policyIdFrom(app),
          };
        });
      })
      .catch(function (err) {
        // Drop the failure from the cache so a retry is possible, and let
        // the caller render the message rather than swallowing it.
        searchCache.delete(key);
        throw err;
      });

    searchCache.set(key, promise);
    return promise;
  }

  // The policy id out of _links.accessPolicy.href. Parsed off the end of the
  // href rather than assumed, because the link is absolute in some responses
  // and relative in others.
  //
  // Only Okta policy ids are accepted. Without the prefix test, an href that
  // arrives with a suffix (.../policies/{id}/mappings) would hand back the
  // suffix as if it were an id and build a URL that 404s.
  function policyIdFrom(app) {
    const href =
      app && app._links && app._links.accessPolicy && app._links.accessPolicy.href;
    if (!href) return null;
    const parts = String(href).split("?")[0].replace(/\/+$/, "").split("/");
    for (let i = parts.length - 1; i >= 0; i--) {
      if (/^rst[A-Za-z0-9]+$/.test(parts[i])) return parts[i];
    }
    return null;
  }

  /* =========================================================================
     SHADOW DOM

     Odyssey renders this page inside a web component
     (<odyssey-react-web-component-1-51-0>), so the toolbar lives in a shadow
     root and document.querySelector cannot see it. Everything here walks
     shadow roots explicitly.

     The anchor is [data-ods-type="search"] rather than input[type="search"]:
     the page carries two search inputs across its shadow roots but only one
     ods search wrapper, so this is both cheaper and less ambiguous.
  ========================================================================= */
  const ANCHOR_SEL = '[data-ods-type="search"]';

  function deepQueryAll(selector, root, out) {
    root = root || document;
    out = out || [];
    out.push.apply(out, root.querySelectorAll(selector));
    root.querySelectorAll("*").forEach(function (node) {
      if (node.shadowRoot) deepQueryAll(selector, node.shadowRoot, out);
    });
    return out;
  }

  /* The page's own search input, used both as the clone source and as the
     insertion anchor. Anything inside our own wrapper is skipped, since the
     clone carries the same data-ods-type attribute and would otherwise be a
     candidate for cloning itself. */
  function findPageSearch() {
    const wraps = deepQueryAll(ANCHOR_SEL).filter(function (node) {
      return !node.closest("." + MARK);
    });
    for (let i = 0; i < wraps.length; i++) {
      const input = wraps[i].querySelector("input") || (wraps[i].matches("input") ? wraps[i] : null);
      if (input) return input;
    }
    return null;
  }

  /* Okta renders the toolbar search disabled while the policy list loads, so
     the clone source is only worth taking once it is live. Cloning a disabled
     field produces a disabled field: cloneNode copies the disabled attribute
     and the greyed-out classes with it, and the result looks injected but is
     dead. This went unnoticed for as long as injection only ever happened
     late, on a full page load. Arriving by client-side navigation is early
     enough to catch the loading state. */
  function isUsable(input) {
    if (!input || input.disabled) return false;
    if (input.getAttribute("aria-disabled") === "true") return false;
    return true;
  }

  /* Strip the loading state off the clone. Redundant with the isUsable gate
     above and kept anyway, because the two protect against different things:
     the gate waits for a good source, this repairs a source that carried
     disabled styling on a wrapper rather than on the input itself.

     Matched on the substring "disabled" rather than on exact class names.
     Mui-disabled is stable, but the emotion hashes beside it are not, and an
     Odyssey release is free to rename its own variant of the same idea. */
  function enableClone(control, input) {
    const nodes = [control].concat(Array.prototype.slice.call(
      control.querySelectorAll("*")
    ));
    nodes.forEach(function (node) {
      node.removeAttribute("disabled");
      node.removeAttribute("readonly");
      if (node.getAttribute("aria-disabled") !== null) {
        node.removeAttribute("aria-disabled");
      }
      if (node.classList && node.classList.length) {
        Array.prototype.slice.call(node.classList).forEach(function (cls) {
          if (/disabled|readonly/i.test(cls)) node.classList.remove(cls);
        });
      }
      // An inline pointer-events:none would survive every check above and
      // still swallow the click.
      if (node.style && node.style.pointerEvents === "none") {
        node.style.pointerEvents = "";
      }
    });
    input.disabled = false;
    input.readOnly = false;
  }

  /* =========================================================================
     FIELD CONSTRUCTION
  ========================================================================= */

  function buildField(sourceControl) {
    const control = sourceControl.cloneNode(true);

    const input =
      control.querySelector('input[type="search"]') || control.querySelector("input");
    if (!input) return null; // clone is not shaped as expected, bail to caller

    enableClone(control, input);

    input.id = INPUT_ID;
    input.name = INPUT_ID;
    input.value = "";
    input.placeholder = PLACEHOLDER;
    input.setAttribute("autocomplete", "off");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-autocomplete", "list");

    // Rewrite the label rather than leaving a second "Search / Optional"
    // pair, which would read as two copies of the same field.
    const label = control.querySelector("label");
    if (label) {
      label.id = INPUT_ID + "-label";
      label.setAttribute("for", INPUT_ID);
      const optional = label.querySelector("p");
      if (optional) optional.remove();
      const labelText = label.querySelector("span");
      if (labelText) labelText.textContent = "Application";
    }

    return { control: control, input: input };
  }

  /* =========================================================================
     ORB BADGE

     orbUI.addBadge owns the white corner dot, so this only has to hand it the
     right box. That is the input's own bordered container, not our wrapper and
     not the MuiFormControl: both of those start at the top of the
     "Application" label, so a dot pinned to their top-right corner floats
     beside the label rather than sitting on the search bar.

     addBadge has to run after insertion. It calls getComputedStyle to decide
     whether it needs to set position, and that does not resolve for a node
     outside the document.
  ========================================================================= */
  function badgeTarget(control, input) {
    return (
      control.querySelector(".MuiInputBase-root") ||
      control.querySelector(ANCHOR_SEL) ||
      input.parentElement ||
      control
    );
  }

  function badge(control, input, wrapper) {
    const ui = host && host.ui;
    if (!ui) return; // mounted without the UI surface, so no dot to add
    if (ui.MARK) wrapper.classList.add(ui.MARK);
    if (typeof ui.addBadge === "function") {
      ui.addBadge(badgeTarget(control, input));
    }
  }

  /* =========================================================================
     DROPDOWN

     Two rules here, both learned the hard way.

     Rows are not the event targets and do not own handlers. One delegated
     pointerdown on the dropdown reads ROW_ATTR off whatever was pressed.
     Per-row closures looked fine but coupled selection to node identity, so
     any re-render between hover and press dropped the click on the floor.

     Hover repaints in place and never rebuilds. An earlier version
     re-rendered the whole list on mouseenter, which destroys the node under
     a stationary cursor and inserts a fresh one, which the browser then
     hit-tests and sends another mouseenter to. That loop ate the selection.

     Row children get pointer-events:none so the press always lands on the
     row itself, which keeps the delegated lookup a single closest() call.
  ========================================================================= */

  function createDropdown() {
    return el(
      "div",
      "position:absolute;top:100%;left:0;right:0;margin-top:2px;background:#fff;" +
        "border:1px solid #d7d7dc;border-radius:4px;box-shadow:0 4px 12px rgba(0,0,0,0.12);" +
        "max-height:320px;overflow-y:auto;z-index:1000;display:none;"
    );
  }

  function optionRow(app, index) {
    const row = el(
      "div",
      "padding:7px 10px;cursor:pointer;border-bottom:1px solid #f2f2f2;"
    );
    row.setAttribute(ROW_ATTR, String(index));

    row.appendChild(
      el(
        "div",
        "font-weight:600;color:#1d1d21;pointer-events:none;",
        app.label + (app.status && app.status !== "ACTIVE" ? " (inactive)" : "")
      )
    );

    const meta = [];
    if (app.signOnMode) meta.push(app.signOnMode.replace(/_/g, " "));
    if (!app.policyId) meta.push("no authentication policy");
    if (meta.length) {
      row.appendChild(
        el("div", "color:#6e6e78;pointer-events:none;", meta.join(" · "))
      );
    }

    return row;
  }

  function messageRow(text, tone) {
    return el(
      "div",
      "padding:8px 10px;color:" + (tone === "error" ? "#b00020" : "#6e6e78") + ";",
      text
    );
  }

  /* =========================================================================
     WIRING
  ========================================================================= */

  function attach(anchorInput) {
    /* Inside the shadow root the field may or may not be wrapped in a form,
       so neither is assumed. The clone source is the MuiFormControl if there
       is one, falling back to the ods wrapper; the insertion anchor is the
       form if there is one, falling back to whatever we cloned. */
    const sourceControl =
      anchorInput.closest(".MuiFormControl-root") || anchorInput.closest(ANCHOR_SEL);
    if (!sourceControl) return;

    const anchorBlock = anchorInput.closest("form") || sourceControl;
    if (!anchorBlock.parentElement) return;

    const built = buildField(sourceControl);
    if (!built) {
      console.warn(
        "[orb] policy-app-search could not clone the page's search field, so the app search was skipped."
      );
      return;
    }

    /* Layout. The form carries an inline width:100%, so the row it sits in
       has to become a flex row for a second field to sit beside it rather
       than under it. Only the immediate parent is touched, and the existing
       field keeps the growing share. */
    const row = anchorBlock.parentElement;
    row.style.display = "flex";
    row.style.alignItems = "flex-start";
    row.style.gap = "12px";
    anchorBlock.style.flex = "1 1 auto";

    const wrapper = el("div", "position:relative;flex:0 0 280px;");
    wrapper.className = MARK;
    wrapper.appendChild(built.control);

    const dropdown = createDropdown();
    wrapper.appendChild(dropdown);

    const input = built.input;
    let options = [];
    let rowNodes = [];
    let activeIndex = -1;
    let seq = 0; // guards against a slow response overwriting a newer one

    function closeDropdown() {
      dropdown.style.display = "none";
      dropdown.textContent = "";
      input.setAttribute("aria-expanded", "false");
      options = [];
      rowNodes = [];
      activeIndex = -1;
    }

    function showRaw(node) {
      dropdown.textContent = "";
      rowNodes = [];
      dropdown.appendChild(node);
      dropdown.style.display = "";
      input.setAttribute("aria-expanded", "true");
    }

    // Highlight only. Touches the existing nodes and never replaces them.
    function paintActive() {
      rowNodes.forEach(function (node, i) {
        node.style.background = i === activeIndex ? "#f1f4fc" : "";
      });
    }

    function renderOptions() {
      dropdown.textContent = "";
      rowNodes = options.map(function (app, i) {
        const node = optionRow(app, i);
        dropdown.appendChild(node);
        return node;
      });

      if (options.length === RESULT_LIMIT) {
        dropdown.appendChild(
          messageRow("Showing the first " + RESULT_LIMIT + ". Keep typing to narrow.")
        );
      }

      paintActive();
      dropdown.style.display = "";
      input.setAttribute("aria-expanded", "true");
    }

    function rowFrom(target) {
      if (!target || !target.closest) return null;
      return target.closest("[" + ROW_ATTR + "]");
    }

    function select(app) {
      if (!app.policyId) {
        // Stay put and explain. Navigating to a guessed policy, or to the
        // list page, would both be worse than saying what is true.
        showRaw(
          messageRow(
            app.label +
              " has no authentication policy mapped to it. Classic sign-on modes and some app types are not governed by one.",
            "error"
          )
        );
        return;
      }
      window.location.assign(POLICY_BASE + encodeURIComponent(app.policyId));
    }

    /* pointerdown, not click: click fires after blur, and blur closes the
       dropdown, so the selection would be lost. preventDefault keeps focus
       on the input, which means no blur fires at all. */
    dropdown.addEventListener("pointerdown", function (e) {
      const hit = rowFrom(e.target);
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      const app = options[Number(hit.getAttribute(ROW_ATTR))];
      if (app) select(app);
    });

    // mousemove rather than per-row mouseenter, and a repaint only when the
    // index actually changes, so a cursor resting on a row costs nothing.
    dropdown.addEventListener("mousemove", function (e) {
      const hit = rowFrom(e.target);
      if (!hit) return;
      const i = Number(hit.getAttribute(ROW_ATTR));
      if (i !== activeIndex) {
        activeIndex = i;
        paintActive();
      }
    });

    function run(term) {
      const mine = ++seq;
      showRaw(messageRow("Searching…"));

      searchApps(term)
        .then(function (apps) {
          if (mine !== seq) return; // a newer keystroke already won
          options = apps;
          activeIndex = apps.length ? 0 : -1;
          if (!apps.length) {
            showRaw(messageRow("No applications match “" + term + "”."));
            return;
          }
          renderOptions();
        })
        .catch(function (err) {
          if (mine !== seq) return;
          showRaw(
            messageRow(
              "Could not search applications. This needs an admin role with application read access.",
              "error"
            )
          );
          console.warn("[orb] policy-app-search lookup failed:", err && err.message);
        });
    }

    let timer = null;
    input.addEventListener("input", function () {
      const term = input.value.trim();
      if (timer) clearTimeout(timer);
      if (term.length < MIN_CHARS) {
        seq++; // abandon any in-flight response
        closeDropdown();
        return;
      }
      timer = setTimeout(function () {
        run(term);
      }, DEBOUNCE_MS);
    });

    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        closeDropdown();
        return;
      }
      if (!options.length) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        activeIndex = (activeIndex + 1) % options.length;
        paintActive();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        activeIndex = (activeIndex - 1 + options.length) % options.length;
        paintActive();
      } else if (e.key === "Enter") {
        // The field sits outside the page's form, but stop the key anyway so
        // a stray submit handler cannot reload the page under us.
        e.preventDefault();
        if (activeIndex >= 0) select(options[activeIndex]);
      }
    });

    input.addEventListener("focus", function () {
      if (options.length) renderOptions();
    });

    input.addEventListener("blur", function () {
      // Long enough for a pointerdown on an option to land first.
      setTimeout(closeDropdown, 120);
    });

    anchorBlock.insertAdjacentElement("afterend", wrapper);

    input.title = PROVENANCE;
    badge(built.control, input, wrapper);

    injected = wrapper;
  }

  /* =========================================================================
     INJECTION AND WATCHING

     React re-renders this toolbar on filter and density changes, which drops
     our node and resets the flex styles we set, so injection has to be
     repeatable and idempotent.

     Every shadow root is observed up front, whether or not it currently
     holds the toolbar. Registering a root only after finding the anchor
     inside it cannot work: arriving by client-side navigation renders the
     new route inside the already-attached web component, so the light DOM
     never mutates, a document observer stays silent, and the root the
     toolbar is about to appear in was never being watched. A hard refresh
     papered over this by churning the light DOM enough that a retry landed
     after the field existed.

     Roots are tracked in a WeakSet so none is observed twice, and the sweep
     is closed under composition: a root created inside a watched root
     mutates it, which schedules a rescan that picks the new root up.

     The isConnected fast path keeps the settled case free. Once our node is
     in place, a mutation costs one check and no walk at all.
  ========================================================================= */

  // The list page only. The detail page sits one segment deeper on the same
  // prefix, and it has a search field of its own that means something else.
  const ROUTE_RE = /\/admin\/authentication-policies\/app-sign-in\/?$/;

  const watchedRoots = new WeakSet();
  let injected = null;
  let rescanQueued = false;
  let started = false;

  function onTargetRoute() {
    return ROUTE_RE.test(location.pathname);
  }

  function collectRoots(root, out) {
    root = root || document;
    out = out || [root];
    root.querySelectorAll("*").forEach(function (node) {
      if (node.shadowRoot) {
        out.push(node.shadowRoot);
        collectRoots(node.shadowRoot, out);
      }
    });
    return out;
  }

  function observeRoots() {
    collectRoots().forEach(function (root) {
      if (watchedRoots.has(root)) return;
      watchedRoots.add(root);
      /* attributeFilter matters as much as childList here. Okta enables the
         toolbar search by removing an attribute, not by replacing the node,
         so a childList-only observer would never learn that the clone source
         became usable and we would wait on the pulse alone. */
      new MutationObserver(onMutation).observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["disabled", "aria-disabled", "class"],
      });
    });
  }

  // Coalesced to one pass per frame. Without this, a deep root sweep would
  // run on every individual mutation of a busy React page.
  function onMutation() {
    if (injected && injected.isConnected) return;
    if (rescanQueued) return;
    rescanQueued = true;
    requestAnimationFrame(function () {
      rescanQueued = false;
      if (injected && injected.isConnected) return;
      observeRoots();
      tryInject();
    });
  }

  function tryInject() {
    if (injected && injected.isConnected) return;
    injected = null;

    if (!onTargetRoute()) return;

    const anchor = findPageSearch();
    if (!anchor) return;

    // Wait for a live source rather than cloning a disabled one. The observer
    // above watches the disabled attribute, so enabling it brings us back.
    if (!isUsable(anchor)) return;

    const root = anchor.getRootNode();

    // Scoped to the anchor's own root: a stale copy in a detached root would
    // otherwise block a fresh injection.
    if (root.querySelector && root.querySelector("." + MARK)) return;

    attach(anchor);
  }

  /* A bounded retry after a route change. The observers should catch the
     toolbar rendering on their own, but a shadow root can also be created
     and filled in the same frame we notice the URL changed, so this closes
     the gap without leaving a permanent timer running. */
  function pulse() {
    let tries = 0;
    (function again() {
      observeRoots();
      tryInject();
      if (++tries < 12 && !(injected && injected.isConnected)) {
        setTimeout(again, 400);
      }
    })();
  }

  /* Route changes are detected by polling location, not by patching
     history.pushState. In an isolated content-script world the page's
     history object is not the one reachable from here, so a patch would
     never see the console's own navigations. The DOM is shared and so is
     location, which makes polling the world-agnostic option. */
  function watchRoute() {
    let lastHref = location.href;
    setInterval(function () {
      if (location.href === lastHref) return;
      lastHref = location.href;
      if (injected && !injected.isConnected) injected = null;
      pulse();
    }, 400);
    window.addEventListener("popstate", pulse);
  }

  function inject(hostSurface) {
    host = hostSurface;
    if (started) {
      pulse();
      return;
    }
    started = true;
    observeRoots();
    watchRoute();
    pulse();
  }

  if (typeof window !== "undefined") {
    window.orbPolicyAppSearch = { inject: inject };
  }
})();
