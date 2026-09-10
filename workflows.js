/* ===========================================================================
   workflows.js — flow search for the Okta Workflows Console
   ---------------------------------------------------------------------------
   Adds a search bar to the Workflows Console header, below the Home / Flows /
   Connector Builder row. Typing a name and pressing the blue button lists
   matching flows, each with the folder path it lives in, and clicking a result
   opens the flow.

   WHY THIS MODULE LOOKS DIFFERENT FROM THE OTHERS
   -----------------------------------------------
   Every other ORB module runs on an -admin host and borrows the admin
   console's own CSS classes, so a button styled "button-primary link-button"
   comes out looking native. The Workflows Console is a separate app on a
   separate host. It ships MUI and its own "ods-" header classes, and none of
   the admin console's classes exist here. The search control therefore carries
   its own styles, injected once as a scoped stylesheet.

   It still routes through window.orbUI for the button itself, so the white
   corner dot marking a control as ORB's stays consistent with every other
   button the extension adds. If orbUI is absent the module builds a plain
   button and carries on.

   This module also owns its own fetch rather than taking orb-plugin's
   getJSON. Two reasons: the calls go to the Workflows origin rather than the
   admin origin, and the crawl needs the HTTP status code so it can back off
   on a 429. orb-plugin's getJSON flattens failures into a message string.

   THE API IT USES, AND THE RISK THAT CARRIES
   ------------------------------------------
   Okta publishes no supported API for listing flows. There is no List Flows
   function card and no management endpoint, so this module calls the same
   undocumented endpoints the Workflows Console itself calls:

     GET /app/api/org                            -> { id: <org_id>, ... }
     GET /app/api/group?org_id=&path=<folder_id> -> child folders of a folder
     GET /app/api/flo?org_id=&group_id=<id>      -> flows in one folder

   All three authenticate on the console session cookie alone. No token and no
   XSRF header, which is why a same-origin fetch from a content script works.

   Because they are undocumented they can change in any Workflows release, and
   Okta ships those roughly monthly. Every call site here fails soft: a broken
   endpoint costs the admin a search, never a broken page.

   HOW SEARCH WORKS
   ----------------
   No endpoint takes a name filter, so matching happens locally against an
   index this module builds by walking the folder tree and listing each
   folder's flows. That is one request per folder, which is why the index is
   built once and cached rather than rebuilt per search.

   Load order: this file defines window.orbWorkflows and does not self-start.
   orb-plugin.js mounts it, the same as every other module.
=========================================================================== */
(function () {
  "use strict";

  /* =========================================================================
     CONFIG
  ========================================================================= */

  // Okta's Workflows Console always sits at <org>.workflows.<domain>, across
  // commercial, preview, EMEA, and the government cells.
  const WORKFLOWS_HOST = /(^|\.)workflows\./;

  // How long a cached index stays usable. Long enough that a burst of
  // searches costs one crawl, short enough that a flow added this morning
  // shows up this afternoon. Shift-clicking the button rebuilds on demand.
  const CACHE_TTL_MS = 15 * 60 * 1000;

  // Parallel folder requests during a crawl. The console's own rate limits are
  // undocumented, so this stays low deliberately: an org with 400 folders
  // should not look like an attack.
  const CONCURRENCY = 5;

  // Bumped whenever the shape of an indexed flow record changes. A cached
  // index stamped with an older version is treated as stale and rebuilt,
  // rather than rendered with fields it never stored. Cheap insurance: the
  // cost of a mismatch is one crawl, and the cost of not checking is a row
  // that silently misreports whether a flow is running.
  const INDEX_VERSION = 2;

  const MAX_RESULTS = 50; // rendered rows, not matches found
  const MAX_DEPTH = 20; // cycle guard on the folder walk
  const DEBOUNCE_MS = 120;

  const CLS = "orb-wf"; // prefix for every class this module owns
  const BLUE = "#1662dd";
  const BLUE_HOVER = "#0f4fb5";

  /* =========================================================================
     HTTP — one small client, because the crawl needs status codes.

     Retries on 429 and on 5xx, honouring Retry-After when the server sends
     one. A folder that still fails after three attempts is skipped and
     reported, so one unreadable folder does not sink the whole index.
  ========================================================================= */

  const HEADERS = {
    accept: "application/json",
    "X-Okta-User-Agent-Extended": "orb-workflows",
  };

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  async function apiGet(path, attempt) {
    const tries = attempt || 1;
    let res;
    try {
      res = await fetch(location.origin + path, {
        headers: HEADERS,
        credentials: "same-origin",
      });
    } catch (netErr) {
      if (tries < 3) {
        await sleep(400 * tries);
        return apiGet(path, tries + 1);
      }
      throw netErr;
    }

    if (res.status === 429 || res.status >= 500) {
      if (tries < 3) {
        const retryAfter = parseFloat(res.headers.get("retry-after"));
        const wait = retryAfter > 0 ? retryAfter * 1000 : 400 * tries;
        await sleep(wait);
        return apiGet(path, tries + 1);
      }
    }

    if (!res.ok) {
      const err = new Error("HTTP " + res.status + " for " + path);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  /* Run an async worker over items with a fixed number of runners. Results
     land at the same index as their input so a failure leaves a hole rather
     than shifting everything after it. */
  async function pool(items, limit, worker, onTick) {
    const out = new Array(items.length);
    let next = 0;
    let done = 0;

    const runners = [];
    const width = Math.min(limit, items.length);
    for (let r = 0; r < width; r++) {
      runners.push(
        (async function () {
          while (next < items.length) {
            const i = next++;
            try {
              out[i] = await worker(items[i]);
            } catch (e) {
              out[i] = undefined;
            }
            done++;
            if (onTick) onTick(done, items.length);
          }
        })()
      );
    }
    await Promise.all(runners);
    return out;
  }

  /* =========================================================================
     FOLDER TREE

     Two shapes of response have to be tolerated, because the console's own
     traffic only ever shows the "children of folder X" case and we cannot
     tell from that whether the unfiltered query returns the root folders or
     every folder in the org.

     So: fetch once without a parent, then look at what came back. If any
     folder names a parent, the endpoint returned the whole tree and there is
     nothing left to walk. If none do, these are roots and each one gets
     walked. Both paths dedupe by id, so a surprise third shape still
     terminates.
  ========================================================================= */

  // Tried in order. The first that yields folders wins, and the winner is
  // remembered for the rest of the crawl.
  const ROOT_QUERIES = ["", "&path=", "&path=0"];

  function foldersPath(orgId, parentId) {
    return (
      "/app/api/group?org_id=" +
      encodeURIComponent(orgId) +
      (parentId == null ? "" : "&path=" + encodeURIComponent(parentId))
    );
  }

  /* The parent reference, normalised.

     Observed as null on a root folder. When set it may be a bare parent id or
     a materialised path such as "279737.280014", so the last numeric segment
     is the parent either way. Anything unparseable reads as a root, which
     costs a folder its path prefix but never breaks the crawl. */
  function parentIdOf(folder) {
    const raw = folder && folder.path;
    if (raw === null || raw === undefined || raw === "") return null;
    const segments = String(raw).split(/[^0-9]+/).filter(Boolean);
    if (!segments.length) return null;
    return Number(segments[segments.length - 1]);
  }

  function isFolderArray(value) {
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value[0] &&
      typeof value[0].id !== "undefined"
    );
  }

  async function loadFolders(orgId, onNote) {
    const byId = new Map();

    function add(folder) {
      if (!folder || typeof folder.id === "undefined") return false;
      const id = Number(folder.id);
      if (byId.has(id)) return false;
      byId.set(id, {
        id: id,
        name: typeof folder.name === "string" ? folder.name : "",
        parentId: parentIdOf(folder),
      });
      return true;
    }

    // Probe for the root listing.
    let seed = null;
    for (let i = 0; i < ROOT_QUERIES.length; i++) {
      try {
        const value = await apiGet(foldersPath(orgId, null) + ROOT_QUERIES[i]);
        if (isFolderArray(value)) {
          seed = value;
          break;
        }
      } catch (e) {
        /* try the next candidate */
      }
    }

    if (!seed) {
      // Last resort: the folder the admin is looking at, climbed to its root.
      // Better than nothing, and it means search still works inside the
      // current subtree if the root listing convention ever changes.
      const current = await currentFolder();
      if (current) {
        seed = [current];
        if (onNote) onNote("Indexed from the current folder down.");
      }
    }

    if (!seed) return [];
    seed.forEach(add);

    // Did that one call already return the whole tree?
    const flat = seed.some(function (f) {
      return parentIdOf(f) !== null;
    });
    if (flat) return Array.from(byId.values());

    // Otherwise walk down, one level at a time.
    let frontier = seed.map(function (f) {
      return Number(f.id);
    });
    for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
      const results = await pool(frontier, CONCURRENCY, function (id) {
        return apiGet(foldersPath(orgId, id));
      });
      const nextFrontier = [];
      results.forEach(function (children) {
        if (!Array.isArray(children)) return;
        children.forEach(function (child) {
          if (add(child)) nextFrontier.push(Number(child.id));
        });
      });
      frontier = nextFrontier;
    }

    return Array.from(byId.values());
  }

  /* The folder open in the browser right now, resolved from the URL. The
     console routes folders as /app/folders/<external_id>/flows, and
     /app/api/group/<external_id> accepts that ULID directly. */
  async function currentFolder() {
    const m = /^\/app\/folders\/([^/?#]+)/.exec(location.pathname);
    if (!m) return null;
    try {
      return await apiGet("/app/api/group/" + encodeURIComponent(m[1]));
    } catch (e) {
      return null;
    }
  }

  /* Full display path for each folder, built once from the parent links.
     Memoised on the way up, so a deep tree costs one pass rather than one
     pass per leaf. Cycles and missing parents stop the climb. */
  function pathsFor(folders) {
    const byId = new Map();
    folders.forEach(function (f) {
      byId.set(f.id, f);
    });

    const cache = new Map();

    function climb(id, seen) {
      if (cache.has(id)) return cache.get(id);
      const folder = byId.get(id);
      if (!folder) return "";
      if (seen.has(id)) return folder.name; // cycle: stop here
      seen.add(id);

      const parentPath =
        folder.parentId === null ? "" : climb(folder.parentId, seen);
      const full = parentPath ? parentPath + " > " + folder.name : folder.name;
      cache.set(id, full);
      return full;
    }

    folders.forEach(function (f) {
      f.path = climb(f.id, new Set());
    });
    return folders;
  }

  /* =========================================================================
     INDEX

     Kept deliberately thin. The raw flow record is roughly three kilobytes,
     almost all of it a clientPermissions block describing which roles may do
     what, so an org with two thousand flows would be six megabytes of JSON
     held for the sake of two fields. Stripping to name, id, and folder brings
     that under a couple of hundred kilobytes, which fits chrome.storage.local
     comfortably.

     `active` is stored but not shown. It is free to keep and a later feature
     can surface it without another crawl.
  ========================================================================= */

  function flowsPath(orgId, groupId) {
    return (
      "/app/api/flo?org_id=" +
      encodeURIComponent(orgId) +
      "&group_id=" +
      encodeURIComponent(groupId)
    );
  }

  async function buildIndex(onProgress) {
    const notes = [];
    function note(text) {
      notes.push(text);
    }

    const org = await apiGet("/app/api/org");
    const orgId = org && org.id;
    if (!orgId) throw new Error("Could not read the org id.");

    if (onProgress) onProgress("Reading folders");
    const folders = pathsFor(await loadFolders(orgId, note));
    if (!folders.length) throw new Error("No folders were readable.");

    let unreadable = 0;
    const perFolder = await pool(
      folders,
      CONCURRENCY,
      async function (folder) {
        try {
          const list = await apiGet(flowsPath(orgId, folder.id));
          if (!Array.isArray(list)) return [];
          return list
            .filter(function (flow) {
              return flow && flow.external_id && flow.name;
            })
            .map(function (flow) {
              return {
                name: String(flow.name),
                id: String(flow.external_id),
                folder: folder.path,
                // Boolean only when the API actually said so. Coercing with
                // `=== true` would turn a missing field into false, and the
                // renderer would then mark a flow Inactive on no evidence.
                // Left undefined it drops out of the cached JSON entirely,
                // which reads back as undefined and stays unlabelled.
                active:
                  typeof flow.active === "boolean" ? flow.active : undefined,
              };
            });
        } catch (e) {
          unreadable++;
          return [];
        }
      },
      function (done, total) {
        if (onProgress) {
          onProgress("Reading flows, folder " + done + " of " + total);
        }
      }
    );

    const flows = [];
    perFolder.forEach(function (batch) {
      if (Array.isArray(batch)) flows.push.apply(flows, batch);
    });

    if (unreadable) {
      note(
        unreadable +
          (unreadable === 1 ? " folder was" : " folders were") +
          " skipped."
      );
    }

    return {
      version: INDEX_VERSION,
      orgId: orgId,
      host: location.host,
      builtAt: Date.now(),
      folderCount: folders.length,
      notes: notes,
      flows: flows,
    };
  }

  /* =========================================================================
     CACHE — chrome.storage.local when the extension has the storage
     permission, otherwise this page's sessionStorage, otherwise memory only.
     Keyed by host so a preview org and a production org never share an index.
  ========================================================================= */

  const CACHE_KEY = "orbWorkflowsIndex:" + location.host;
  let memoryIndex = null;

  function hasChromeStorage() {
    return (
      typeof chrome !== "undefined" &&
      chrome.storage &&
      chrome.storage.local &&
      typeof chrome.storage.local.get === "function"
    );
  }

  function readCache() {
    return new Promise(function (resolve) {
      if (memoryIndex) return resolve(memoryIndex);

      if (hasChromeStorage()) {
        try {
          chrome.storage.local.get([CACHE_KEY], function (bag) {
            resolve((bag && bag[CACHE_KEY]) || null);
          });
          return;
        } catch (e) {
          /* fall through */
        }
      }
      try {
        const raw = sessionStorage.getItem(CACHE_KEY);
        resolve(raw ? JSON.parse(raw) : null);
      } catch (e) {
        resolve(null);
      }
    });
  }

  function writeCache(index) {
    memoryIndex = index;
    if (hasChromeStorage()) {
      try {
        const bag = {};
        bag[CACHE_KEY] = index;
        chrome.storage.local.set(bag);
        return;
      } catch (e) {
        /* fall through */
      }
    }
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(index));
    } catch (e) {
      /* quota, private mode, or storage disabled. Memory copy stands. */
    }
  }

  function isFresh(index) {
    if (!index) return false;
    if (index.version !== INDEX_VERSION) return false;
    return Date.now() - index.builtAt < CACHE_TTL_MS;
  }

  /* =========================================================================
     MATCHING

     Substring, case and accent insensitive, ranked so the most likely
     intended flow lands at the top:

       0  the whole name matches
       1  the name starts with the query
       2  a word inside the name starts with the query
       3  the query appears somewhere in the name

     Ties break alphabetically, which keeps a family of similarly named flows
     in a predictable order rather than in folder-crawl order.
  ========================================================================= */

  function normalise(text) {
    let out = String(text).toLowerCase();
    if (out.normalize) {
      out = out.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    }
    return out;
  }

  function rank(haystack, needle) {
    const at = haystack.indexOf(needle);
    if (at === -1) return -1;
    if (haystack === needle) return 0;
    if (at === 0) return 1;
    return /[\s\-_/.([]/.test(haystack.charAt(at - 1)) ? 2 : 3;
  }

  function search(flows, query) {
    const needle = normalise(query).trim();
    if (!needle) return [];

    const hits = [];
    for (let i = 0; i < flows.length; i++) {
      const flow = flows[i];
      if (!flow._n) flow._n = normalise(flow.name);
      const tier = rank(flow._n, needle);
      if (tier !== -1) hits.push({ flow: flow, tier: tier });
    }

    hits.sort(function (a, b) {
      if (a.tier !== b.tier) return a.tier - b.tier;
      return a.flow.name.localeCompare(b.flow.name);
    });

    return hits.map(function (h) {
      return h.flow;
    });
  }

  /* =========================================================================
     STYLES — injected once. Every selector is prefixed and every rule is
     scoped under the module's own container, so nothing here can reach the
     console's MUI tree.
  ========================================================================= */

  /* Every colour is stated outright and there is no prefers-color-scheme
     block, deliberately. The Workflows Console does not follow the OS colour
     scheme: its header ships a "light-header-theme" class and the app stays
     light whatever the machine is set to. An earlier version of this file
     honoured the OS setting and produced a black results panel sitting under a
     white console, with the footer text unreadable against it.

     color-scheme:light matters for the same reason. Without it Chrome
     restyles the form controls we own when the OS is dark, which repaints the
     search input's own clear button and its text.

     Two shapes, so the mount can retreat if a route's header will not give up
     a full-width row:
       default     a row of its own spanning the header, panel inset to match
                   the console's 24px gutter
       -compact    an inline control sitting beside the nav links
  ========================================================================= */
  const INK = "#1d1d21";
  const MUTED = "rgba(29,29,33,0.62)";
  const HAIRLINE = "rgba(29,29,33,0.12)";

  function injectStyles() {
    if (document.getElementById(CLS + "-styles")) return;
    const style = document.createElement("style");
    style.id = CLS + "-styles";
    style.textContent = [
      // Default shape: an inline item in the header's link row, sitting after
      // Settings. Sized by its content, so it never competes for space the
      // way a full-width row did.
      "." + CLS + "-bar{",
      "display:inline-flex;align-items:center;gap:6px;",
      "margin-left:20px;box-sizing:border-box;",
      "color:" + INK + ";color-scheme:light;",
      "font:14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",

      // Fallback shape: a row of its own below the header, used only if the
      // link row cannot be found.
      "." + CLS + "-bar." + CLS + "-row{",
      "display:flex;width:100%;margin-left:0;padding:8px 24px;",
      "background:#fff;border-top:1px solid " + HAIRLINE + "}",

      "." + CLS + "-input{",
      "flex:0 1 200px;min-width:120px;height:28px;padding:0 8px;",
      "box-sizing:border-box;color:" + INK + ";background:#fff;",
      "border:1px solid rgba(29,29,33,0.28);border-radius:4px;",
      "font:inherit;font-size:13px;color-scheme:light;outline:none}",
      "." + CLS + "-input::placeholder{color:" + MUTED + ";opacity:1}",
      "." + CLS + "-input:focus{border-color:" + BLUE + ";",
      "box-shadow:0 0 0 3px rgba(22,98,221,0.18)}",
      "." + CLS + "-row ." + CLS + "-input{flex:0 1 320px;height:32px;",
      "font-size:14px}",

      // position:relative is on the button itself rather than left to
      // orbUI.addBadge. addBadge only sets it after checking the computed
      // style, and a detached element has no computed style to check, so the
      // dot would otherwise anchor to whichever ancestor happened to be
      // positioned and drift away from the button.
      "." + CLS + "-go{",
      "position:relative;display:inline-flex;align-items:center;",
      "justify-content:center;width:28px;height:28px;flex:0 0 auto;",
      "box-sizing:border-box;overflow:visible;",
      "background:" + BLUE + ";color:#fff;border:1px solid " + BLUE + ";",
      "border-radius:4px;cursor:pointer;text-decoration:none;padding:0}",
      "." + CLS + "-go:hover{background:" + BLUE_HOVER + ";",
      "border-color:" + BLUE_HOVER + "}",
      "." + CLS + "-go:focus-visible{outline:2px solid " + BLUE + ";",
      "outline-offset:2px}",
      "." + CLS + "-go svg{width:15px;height:15px;display:block;fill:#fff}",
      "." + CLS + "-row ." + CLS + "-go{width:32px;height:32px}",
      "." + CLS + "-row ." + CLS + "-go svg{width:16px;height:16px}",

      "." + CLS + "-status{color:" + MUTED + ";font-size:12px;",
      "white-space:nowrap}",

      /* The panel is fixed and lives on document.body, not inside the bar.
         Inside the header it would be at the mercy of any ancestor that clips
         its overflow or establishes a containing block with a transform, and
         the header is exactly the kind of sticky, tightly sized element that
         does both. Fixed on the body answers to nothing above it. Its
         coordinates come from the input's box, recomputed whenever the page
         scrolls or resizes while it is open. */
      "." + CLS + "-panel{",
      "position:fixed;z-index:2147483000;",
      "max-height:min(60vh,520px);overflow:auto;",
      "background:#fff;color:" + INK + ";color-scheme:light;",
      "border:1px solid " + HAIRLINE + ";border-radius:6px;",
      "box-shadow:0 8px 30px rgba(0,0,0,0.18);",
      "font:14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
      "." + CLS + "-panel[hidden]{display:none}",

      "." + CLS + "-hit{",
      "display:flex;align-items:flex-start;justify-content:space-between;",
      "gap:10px;padding:8px 12px;text-decoration:none;color:" + INK + ";",
      "border-bottom:1px solid rgba(29,29,33,0.06)}",
      "." + CLS + "-hit:last-of-type{border-bottom:none}",
      "." + CLS + "-hit:hover,." + CLS + "-hit[data-cursor='1']{",
      "background:rgba(22,98,221,0.08)}",
      "." + CLS + "-hit:focus-visible{outline:2px solid " + BLUE + ";",
      "outline-offset:-2px}",

      // min-width:0 lets a long folder path wrap instead of forcing the row
      // wider and pushing the chip off the panel's right edge.
      "." + CLS + "-main{min-width:0;flex:1 1 auto}",
      "." + CLS + "-name{font-weight:700;color:" + INK + "}",
      "." + CLS + "-folder{font-size:12px;color:" + MUTED + ";",
      "margin-top:2px;word-break:break-word}",

      /* Only flows that are switched off get a marker, so the chip carries
         all the meaning on its own and an unmarked row reads as running. A
         tinted fill with a red rule and red text keeps it legible at 11px,
         which a solid red block with white text does not manage as well at
         this size. flex-shrink is off so it never squeezes to an ellipsis. */
      "." + CLS + "-off{",
      "flex:0 0 auto;align-self:center;",
      "padding:1px 7px;border-radius:3px;",
      "font-size:11px;font-weight:600;line-height:1.5;",
      "color:#a3231d;background:#fdecec;border:1px solid #e8a6a3}",

      "." + CLS + "-empty{padding:12px;color:" + MUTED + "}",
      "." + CLS + "-foot{",
      "display:flex;align-items:center;justify-content:space-between;gap:12px;",
      "padding:8px 12px;font-size:12px;color:" + MUTED + ";",
      "border-top:1px solid " + HAIRLINE + ";background:#fafafa}",
      "." + CLS + "-refresh{color:" + BLUE + ";cursor:pointer;",
      "background:none;border:none;font:inherit;padding:0}",
      "." + CLS + "-refresh:hover{text-decoration:underline}",
    ].join("");
    document.head.appendChild(style);
  }

  function magnifierSvg() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS(NS, "path");
    path.setAttribute(
      "d",
      "M10.44 9.44a5 5 0 1 0-1 1l3.35 3.35a.75.75 0 1 0 1.06-1.06l-3.35-3.35Zm-3.94.56a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"
    );
    svg.appendChild(path);
    return svg;
  }

  /* =========================================================================
     THE CONTROL
  ========================================================================= */

  let host = {}; // whatever orb-plugin handed over, notably host.ui
  let indexPromise = null; // in-flight build, shared by concurrent callers
  let ui = null; // the mounted control's own handles

  function buildButton(onClick) {
    const orbUI = host.ui || window.orbUI;

    // Route through the shared factory when it exists, so the ORB corner dot
    // and the orb-injected marker class match every other button. The variant
    // brings admin-console classes that mean nothing here, which is harmless:
    // the module's own class supplies all the visible styling.
    if (orbUI && typeof orbUI.createButton === "function") {
      const btn = orbUI.createButton({
        label: "",
        title: "Search flows by name. Shift-click to rebuild the index",
        variant: "toolbar-primary",
        className: CLS + "-go",
        onClick: onClick,
      });
      btn.textContent = "";
      btn.setAttribute("aria-label", "Search flows");
      btn.appendChild(magnifierSvg());
      return btn;
    }

    const btn = document.createElement("a");
    btn.href = "#";
    btn.className = CLS + "-go orb-injected";
    btn.title = "Search flows by name. Shift-click to rebuild the index";
    btn.setAttribute("aria-label", "Search flows");
    btn.appendChild(magnifierSvg());
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      onClick(e);
    });
    return btn;
  }

  function buildBar(shape) {
    const bar = document.createElement("div");
    bar.className =
      CLS + "-bar orb-injected" + (shape === "row" ? " " + CLS + "-row" : "");

    const input = document.createElement("input");
    input.type = "search";
    input.className = CLS + "-input";
    input.placeholder = "Search flows";
    input.setAttribute("aria-label", "Search flows by name");
    input.autocomplete = "off";
    input.spellcheck = false;

    const button = buildButton(function (e) {
      run(e && e.shiftKey);
    });

    const status = document.createElement("span");
    status.className = CLS + "-status";

    // Body-mounted, so a stale panel from a previous bar has to go first.
    const orphan = document.querySelector("." + CLS + "-panel");
    if (orphan) orphan.remove();

    const panel = document.createElement("div");
    panel.className = CLS + "-panel";
    panel.hidden = true;
    panel.setAttribute("role", "listbox");
    document.body.appendChild(panel);

    bar.appendChild(input);

    // place() adds the corner dot and needs the button in the document, so it
    // runs against the bar before the bar itself is mounted. Margin is zeroed
    // because the bar's flex gap already handles spacing.
    const orbUI = host.ui || window.orbUI;
    if (orbUI && typeof orbUI.place === "function") {
      orbUI.place(button, { parent: bar, margin: "0" });
    } else {
      bar.appendChild(button);
    }

    bar.appendChild(status);

    ui = { bar: bar, input: input, button: button, status: status, panel: panel, cursor: -1 };
    wireEvents();
    return bar;
  }

  /* Put the panel under the input. Width follows the input's left edge out to
     a comfortable reading measure, clamped to the viewport so it never runs
     off either side, and it flips above the bar if there is more room up
     there than down. */
  function positionPanel() {
    if (!ui || ui.panel.hidden) return;

    const anchor = ui.bar.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(520, window.innerWidth - margin * 2);

    let left = anchor.left;
    if (left + width > window.innerWidth - margin) {
      left = window.innerWidth - margin - width;
    }
    if (left < margin) left = margin;

    const below = window.innerHeight - anchor.bottom - margin;
    const above = anchor.top - margin;
    const flip = below < 200 && above > below;

    ui.panel.style.width = width + "px";
    ui.panel.style.left = Math.round(left) + "px";
    ui.panel.style.maxHeight = Math.max(160, flip ? above : below) + "px";

    if (flip) {
      ui.panel.style.top = "auto";
      ui.panel.style.bottom = Math.round(window.innerHeight - anchor.top + 4) + "px";
    } else {
      ui.panel.style.bottom = "auto";
      ui.panel.style.top = Math.round(anchor.bottom + 4) + "px";
    }
  }

  function setStatus(text) {
    if (ui) ui.status.textContent = text || "";
  }

  function closePanel() {
    if (!ui) return;
    ui.panel.hidden = true;
    ui.panel.textContent = "";
    ui.cursor = -1;
  }

  function hits() {
    return ui ? Array.prototype.slice.call(ui.panel.querySelectorAll("." + CLS + "-hit")) : [];
  }

  function moveCursor(delta) {
    const rows = hits();
    if (!rows.length) return;
    rows.forEach(function (row) {
      row.removeAttribute("data-cursor");
    });
    ui.cursor = (ui.cursor + delta + rows.length) % rows.length;
    const row = rows[ui.cursor];
    row.setAttribute("data-cursor", "1");
    row.scrollIntoView({ block: "nearest" });
  }

  /* Render. Results are anchors rather than divs so command-click and
     middle-click open a flow in a new tab, which is how an admin comparing
     two flows will want to work. */
  function render(matches, total, index) {
    if (!ui) return;
    const panel = ui.panel;
    panel.textContent = "";
    ui.cursor = -1;

    if (!matches.length) {
      const empty = document.createElement("div");
      empty.className = CLS + "-empty";
      empty.textContent = "No flow names match that.";
      panel.appendChild(empty);
    } else {
      matches.slice(0, MAX_RESULTS).forEach(function (flow) {
        const row = document.createElement("a");
        row.className = CLS + "-hit";
        row.href = "/app/flows/" + encodeURIComponent(flow.id);
        row.setAttribute("role", "option");

        const main = document.createElement("div");
        main.className = CLS + "-main";

        const name = document.createElement("div");
        name.className = CLS + "-name";
        name.textContent = flow.name;

        const folder = document.createElement("div");
        folder.className = CLS + "-folder";
        folder.textContent = flow.folder || "Folder unknown";

        main.appendChild(name);
        main.appendChild(folder);
        row.appendChild(main);

        /* Marked only when the flow is known to be off. The test is against
           false rather than falsy on purpose: an index built by an older
           version of this file, or a record where the field is missing,
           leaves active undefined, and labelling an unknown state as
           Inactive would be worse than saying nothing. */
        if (flow.active === false) {
          const chip = document.createElement("span");
          chip.className = CLS + "-off";
          chip.textContent = "Inactive";
          chip.title = "This flow is turned off";
          row.appendChild(chip);
        }

        panel.appendChild(row);
      });
    }

    const foot = document.createElement("div");
    foot.className = CLS + "-foot";

    const summary = document.createElement("span");
    const shown = Math.min(matches.length, MAX_RESULTS);
    const scope =
      total === 1 ? "1 flow indexed" : total.toLocaleString() + " flows indexed";
    summary.textContent =
      (matches.length > shown
        ? "Showing " + shown + " of " + matches.length + " matches. "
        : "") +
      scope +
      " " +
      ageOf(index.builtAt) +
      ".";

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = CLS + "-refresh";
    refresh.textContent = "Rebuild index";
    refresh.addEventListener("click", function () {
      run(true);
    });

    foot.appendChild(summary);
    foot.appendChild(refresh);

    if (index.notes && index.notes.length) {
      const note = document.createElement("div");
      note.className = CLS + "-empty";
      note.style.fontSize = "12px";
      note.textContent = index.notes.join(" ");
      panel.appendChild(note);
    }

    panel.appendChild(foot);
    panel.hidden = false;
    positionPanel();
  }

  function ageOf(then) {
    const mins = Math.round((Date.now() - then) / 60000);
    if (mins < 1) return "just now";
    if (mins === 1) return "1 minute ago";
    if (mins < 60) return mins + " minutes ago";
    const hours = Math.round(mins / 60);
    return hours === 1 ? "1 hour ago" : hours + " hours ago";
  }

  /* Get an index, building one if needed. The promise is shared so a double
     click, or a click landing while a rebuild is running, does not start a
     second crawl. */
  function getIndex(force) {
    if (indexPromise) return indexPromise;

    indexPromise = (async function () {
      if (!force) {
        const cached = await readCache();
        if (isFresh(cached)) return cached;
      }
      const built = await buildIndex(setStatus);
      writeCache(built);
      return built;
    })();

    indexPromise.catch(function () {}).then(function () {
      indexPromise = null;
    });
    return indexPromise;
  }

  async function run(force) {
    if (!ui) return;
    const query = ui.input.value.trim();
    if (!query) {
      closePanel();
      setStatus("");
      ui.input.focus();
      return;
    }

    setStatus("Searching");
    try {
      const index = await getIndex(force);
      setStatus("");
      render(search(index.flows, query), index.flows.length, index);
    } catch (e) {
      closePanel();
      setStatus("Search is unavailable. Reload the page and try again.");
      console.warn("[orb] flow search failed:", e && e.message);
    }
  }

  /* Once an index exists, typing narrows the list without another crawl, so
     the button becomes the way to start rather than the way to repeat. */
  let debounce = null;
  function onType() {
    clearTimeout(debounce);
    debounce = setTimeout(async function () {
      if (!ui) return;
      if (!ui.input.value.trim()) {
        closePanel();
        return;
      }
      const cached = await readCache();
      if (isFresh(cached)) {
        render(search(cached.flows, ui.input.value.trim()), cached.flows.length, cached);
      }
    }, DEBOUNCE_MS);
  }

  function wireEvents() {
    ui.input.addEventListener("input", onType);

    ui.input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        const rows = hits();
        if (ui.cursor >= 0 && rows[ui.cursor]) rows[ui.cursor].click();
        else run(false);
      } else if (e.key === "Escape") {
        closePanel();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        moveCursor(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        moveCursor(-1);
      }
    });

    // Clicking anywhere else closes the results, the way every other dropdown
    // in the console behaves. Registered once for the page rather than once
    // per bar, because the mount rebuilds the bar when a route swaps the
    // header out and per-bar listeners would pile up behind it. The panel is
    // on the body rather than inside the bar, so it needs its own check or a
    // click on a result would close the panel before the click landed.
    if (!outsideClickBound) {
      outsideClickBound = true;
      document.addEventListener("click", function (e) {
        if (!ui) return;
        if (ui.bar.contains(e.target) || ui.panel.contains(e.target)) return;
        closePanel();
      });

      // A fixed panel does not travel with the page, so it has to be told.
      // Capture phase picks up scrolling inside the console's own scroll
      // containers, not just the window.
      window.addEventListener("scroll", positionPanel, {
        capture: true,
        passive: true,
      });
      window.addEventListener("resize", positionPanel, { passive: true });
    }
  }
  let outsideClickBound = false;

  /* =========================================================================
     MOUNT

     The console is a single-page React app: it rewrites the header on
     navigation and can re-render it in place, so a one-shot insert would
     vanish. Same MutationObserver pattern the other ORB injectors use, with
     an idempotent insert, which covers both cases.

     The bar goes into the <header> after the <nav>, giving it a full-width row
     of its own below the Home / Flows / Connector Builder links rather than
     competing for space inside that flex row.
  ========================================================================= */

  let observer = null;
  let inserting = false;

  const LINK_ROW = ".ods-header__link-container";

  /* Where to put the bar, in descending order of preference.

     The link row is the target: it is a flex row of content-sized items, so an
     inline control appended to it takes the space it needs and lands after
     Settings without renegotiating the row. An earlier version claimed a
     full-width row inside the header instead, which worked on /app and
     collapsed to nothing on /app/folders, since that route's header will not
     give up a second row.

     The fallbacks exist for the case where the link row's class changes in a
     Workflows release. Both are worse placements, and both are visible, which
     is the right trade when the alternative is a feature that silently
     vanishes. */
  const PLANS = [
    {
      name: "link-row",
      place: function (bar, nav) {
        const row = nav.querySelector(LINK_ROW);
        if (!row) return false;
        row.appendChild(bar); // after the last link, which is Settings
        return true;
      },
    },
    {
      name: "nav-end",
      place: function (bar, nav) {
        const wrapper = nav.querySelector(".ods-header__wrapper") || nav;
        wrapper.appendChild(bar);
        return true;
      },
    },
    {
      name: "below-header",
      shape: "row",
      place: function (bar, nav, header) {
        const parent = header.parentNode;
        if (!parent) return false;
        parent.insertBefore(bar, header.nextSibling);
        return true;
      },
    },
  ];

  // A control narrower than this cannot show an input and a button, so treat
  // it as collapsed and move on to the next plan.
  const MIN_USABLE_WIDTH = 120;
  const MIN_USABLE_HEIGHT = 20;

  function boxOf(el) {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  }

  function usable(el) {
    const b = boxOf(el);
    return b.w >= MIN_USABLE_WIDTH && b.h >= MIN_USABLE_HEIGHT;
  }

  function mountWith(planIndex, nav, header) {
    const plan = PLANS[planIndex];
    const carried = ui && ui.input ? ui.input.value : "";

    const bar = buildBar(plan.shape);
    bar.dataset.orbPlan = String(planIndex);
    bar.dataset.orbPlanName = plan.name;

    if (plan.place(bar, nav, header) === false) {
      bar.remove();
      return null;
    }

    if (carried) ui.input.value = carried;
    return bar;
  }

  // Walk the plans until one both places the bar and produces a usable box.
  // Measuring straight after the insert is safe, since reading
  // getBoundingClientRect forces layout.
  function mountBest(from, nav, header) {
    for (let i = from; i < PLANS.length; i++) {
      const bar = mountWith(i, nav, header);
      if (!bar) continue;
      if (!usable(nav)) return bar; // page not laid out yet, judge it later
      if (usable(bar)) return bar;
      bar.remove();
    }
    // Nothing measured well. Put the first placement back rather than leaving
    // the admin with no control at all.
    return mountWith(0, nav, header);
  }

  function tryInject() {
    if (inserting) return; // our own insert re-entering through the observer

    const nav = document.querySelector("nav.ods-header");
    if (!nav) return;
    const header = nav.closest("header") || nav.parentNode;
    if (!header) return;

    injectStyles();

    const existing = document.querySelector("." + CLS + "-bar");

    // Nothing mounted yet, or the route swapped the header out and took our
    // bar with it.
    if (!existing || !existing.isConnected) {
      inserting = true;
      try {
        mountBest(0, nav, header);
      } finally {
        inserting = false;
      }
      return;
    }

    // Mounted. Judge it, but only once the header itself has been laid out:
    // during the first paint, or under a hidden ancestor, everything measures
    // zero and every plan would look broken.
    if (!usable(nav)) return;
    if (usable(existing)) return;

    inserting = true;
    try {
      const from = Number(existing.dataset.orbPlan || 0) + 1;
      existing.remove();
      mountBest(from, nav, header);
    } finally {
      inserting = false;
    }
  }

  function inject(hostApi) {
    host = hostApi || {};
    if (!WORKFLOWS_HOST.test(location.host)) return;

    tryInject();

    // The measurement above is worthless until the header has been laid out,
    // and a route that renders without further DOM changes would never wake
    // the observer for a second look. These re-checks are cheap, since
    // tryInject exits immediately on a bar that already measures correctly.
    requestAnimationFrame(tryInject);
    setTimeout(tryInject, 300);
    setTimeout(tryInject, 1200);

    if (observer) return; // inject() can run again on navigation
    observer = new MutationObserver(tryInject);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /* =========================================================================
     DIAGNOSTICS — orbWorkflows.diagnose() in the console reports which plan
     won, how the bar measures, and the layout of each ancestor above it. If
     the bar ever collapses on a route again, that output says which container
     did it without needing a screenshot.
  ========================================================================= */
  function diagnose() {
    const bar = document.querySelector("." + CLS + "-bar");
    const nav = document.querySelector("nav.ods-header");
    const chain = [];

    let node = bar && bar.parentNode;
    for (let i = 0; node && node.nodeType === 1 && i < 6; i++) {
      const s = getComputedStyle(node);
      chain.push({
        tag: node.tagName.toLowerCase(),
        className: String(node.className || "").slice(0, 80),
        display: s.display,
        flexDirection: s.flexDirection,
        flexWrap: s.flexWrap,
        overflow: s.overflow,
        box: boxOf(node),
      });
      node = node.parentNode;
    }

    return {
      path: location.pathname,
      navFound: !!nav,
      navBox: nav ? boxOf(nav) : null,
      linkRowFound: !!(nav && nav.querySelector(LINK_ROW)),
      linkRowBox: nav && nav.querySelector(LINK_ROW)
        ? boxOf(nav.querySelector(LINK_ROW))
        : null,
      headerLinks: nav ? nav.querySelectorAll("a.header-link").length : 0,
      barFound: !!bar,
      plan: bar ? bar.dataset.orbPlanName : null,
      barBox: bar ? boxOf(bar) : null,
      barUsable: bar ? usable(bar) : false,
      panelOnBody: !!(
        ui &&
        ui.panel &&
        ui.panel.parentNode === document.body
      ),
      ancestors: chain,
    };
  }

  /* =========================================================================
     PUBLIC SURFACE — inject() is what orb-plugin calls. The rest is exposed
     for the popup menu and for poking at the index from the console.
  ========================================================================= */
  if (typeof window !== "undefined") {
    window.orbWorkflows = {
      inject: inject,
      buildIndex: buildIndex,
      search: search,
      getIndex: getIndex,
      diagnose: diagnose,
      readCache: readCache,
      clearCache: function () {
        memoryIndex = null;
        try {
          sessionStorage.removeItem(CACHE_KEY);
        } catch (e) {}
        if (hasChromeStorage()) chrome.storage.local.remove(CACHE_KEY);
      },
    };
  }
})();
