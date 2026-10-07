/* ===========================================================================
   orb-push-groups.js  ::  "Push Groups" tab on a single group's page
   ---------------------------------------------------------------------------
   WHAT IT ADDS

   A sixth tab on /admin/group/<groupId>, sitting after "Admin roles" and
   looking and behaving like the five Okta put there. Selecting it answers the
   question the console cannot: which applications push THIS group. Each row
   links to that app's own Push Groups tab.

   WHY THE FAN-OUT

   Okta's group-push data is app-centric. The console's own Push Groups tab
   asks "which Okta groups does this app push", via

       GET /api/internal/instance/<appInstanceId>/grouppush

   and there is no endpoint that asks the reverse. So this module builds the
   reverse index itself: crawl the apps with GROUP_PUSH in their features, ask
   each for its mappings, and key every mapping by its sourceUserGroupId.

   THE INDEX IS THE POINT

   That index is not built per group. Nothing in it depends on the group in the
   URL, so it is built once per page and every group after the first is a Map
   lookup against memory rather than another N+1 crawl. An admin walking
   through a dozen groups pays for one scan.

   What makes that affordable is throwing most of the response away. A mapping
   arrives at roughly 3.5KB, nearly all of it the createdBy block carrying a
   full user profile with every custom attribute in the org. KEEP is the eight
   fields anything here renders, which takes a mapping to about 200 bytes, so
   even a 6,000-mapping org indexes in around 1.2MB rather than 21MB.

   Being that small is also what makes it worth storing, so a reload does not
   pay for the crawl again. The index is cached stale-while-revalidate rather
   than on a plain expiry, because push groups change and a remembered answer
   has to be able to notice a mapping that was deleted. See CACHE.

   RESULTS STREAM

   The first build renders as it goes. Each app that comes back contributes its
   rows immediately rather than the table waiting on the slowest app in the
   pool, so the first answer lands in roughly the time one request takes. Rows
   still appear in alphabetical order whatever order the apps resolve in, since
   each app owns a <tbody> inserted at its sorted position.

   RATE LIMITS

   Two ceilings, and the obvious one is not the binding one. Okta's concurrency
   limit is 75 simultaneous transactions org-wide, so ten in flight is a small
   slice of a pool shared with agents and other admins. But console traffic is
   also capped at 40 requests per user per 10 seconds per endpoint, and every
   mappings call hits the same endpoint. Hence the sliding window in LIMIT: a
   concurrency of 10 for the common small org, with the window only engaging
   past roughly 35 apps so a large org paces itself instead of collecting 429s.

   ABORT

   One AbortController per build. Leaving the tab mid-crawl cancels whatever is
   in flight rather than paying to download and parse responses the stale guard
   would discard. A partial index is never treated as complete, and the next
   selection resumes from the apps that did finish instead of starting over.

   THE SEARCH FAST PATH

   The mappings response echoes searchString, searchStatus, and searchRuleId,
   which says the endpoint accepts them as query parameters. If searchString
   filters on the source group name, a scan can ask each app only about the
   group in the URL, and a response shrinks from every mapping the app holds to
   the few that matter. Whether it does is measured rather than assumed, once
   per page, for one extra request. See SEARCH PROBE for what can and cannot be
   proven, and why a filtered answer is followed by a quiet full crawl that
   catches anything the filter missed.

   WHY IT OWNS ITS FETCH

   Same reason workflows.js does. The apps crawl pages on the Link header, and
   this module needs status codes for the 429 backoff and a signal on every
   request. host.getJSON resolves straight to parsed JSON, with the headers and
   the request itself already out of reach. It still borrows host.getLinks, so
   there is one Link-header parser in the extension rather than two.

   WHY IT DRIVES THE TAB STRIP ITSELF

   The strip is a jQuery UI tabs widget that was initialised before we got
   here, and a content script's isolated world cannot reach the page's jQuery
   to call .tabs("refresh"). So an <li> we append is invisible to the widget.

   It also cannot be driven through the hash. Okta routes the native tabs off
   location.hash (#tab-users, #tab-apps), which means leaving the hash alone
   while our panel is up would strand it: clicking back to People would not
   change the hash, no hashchange would fire, and Okta would never re-show its
   panel. So selection is ours end to end. We set the two selection classes and
   toggle .hidden on the panels, including putting the native tab back when the
   admin leaves ours. If Okta's own handler also runs, it reaches the same
   state, so the duplication is harmless.

   SWITCHES

   Everything meant to be changed by hand, in the order it appears below. All
   of it is edit-the-file only, with nothing exposed to the page.

     CONCURRENCY         requests in flight during a crawl
     LIMIT               the sliding window that keeps a crawl under Okta's
                         per-endpoint console cap
     SEARCH_MODE         "auto" uses the filtered fast path once the probe
                         shows it is safe, "off" always reads every mapping
     VERIFY_IN_BACKGROUND  follow a filtered answer with a full crawl. Leave
                         on unless the probe reports "source"
     CACHE               where the index is stored, and its freshness tiers
     FILTER_MODE         which apps get asked, "strict" being the console's
                         own test and "provisioning" the wider default
     ALWAYS_CHECK        app ids asked whatever their features say
     INCLUDE_INACTIVE    list deactivated apps too
     DIAGNOSTICS         the Diagnostics link in the panel toolbar

   HOST SURFACE
       inject({ getLinks, getXsrfToken, groupIdFromPath, ui })
=========================================================================== */
(function () {
  "use strict";

  /* --- Okta's DOM, in one place ------------------------------------------
     Captured from a group page: ul#group-tabs holds the <li> strip, the
     panels are direct children of div#tab-content, a panel's id is its
     anchor's id plus a trailing hyphen, and the two classes below are what
     Okta puts on the selected <li>. If a console release moves any of this,
     these five constants are the whole repair.
     --------------------------------------------------------------------- */
  const NAV_SEL = "ul#group-tabs";
  const CONTENT_SEL = "div#tab-content";
  const SELECTED = ["ui-tabs-selected", "ui-state-active"];
  const PANEL_SUFFIX = "-";
  const NATIVE_PANEL_RE = /^tab-.+-$/;

  const TAB_ID = "tab-orb-push-groups";
  const PANEL_ID = TAB_ID + PANEL_SUFFIX; // same shape as Okta's panels
  const MARK = "orb-push-groups";

  const HEADERS = { "X-Okta-User-Agent-Extended": "orb-push-groups" };
  const APPS_PAGE_SIZE = 200;
  const CONCURRENCY = 12;
  const MAX_PAGES = 50; // loop guard on either paginated crawl
  const RETRY_LIMIT = 3;

  // Sliding window for the mappings endpoint. Okta's console cap is 40 per
  // user per 10 seconds per endpoint, so this sits under it with room left for
  // the console's own traffic on the same endpoint.
  const LIMIT = { max: 150, windowMs: 10000 };

  /* Search strategy. "auto" lets a scan ask each app only about the group in
     the URL once the probe below has shown that is safe, and "off" always
     reads every mapping an app has. VERIFY_IN_BACKGROUND follows a filtered
     scan with a quiet full crawl, which is what makes the filtered answer
     safe to show immediately: anything a filtered query missed arrives
     seconds later and is added to the table rather than silently absent. Turn
     it off only if the probe reports "source", where there is nothing left to
     verify. */
  const SEARCH_MODE = "auto"; // "auto" | "off"
  const VERIFY_IN_BACKGROUND = true;
  const VERIFY_DELAY_MS = 400;

  /* Cache. See the CACHE section for why this is stale-while-revalidate rather
     than a plain expiry.
       backend   "auto" prefers chrome.storage.local and falls back to the
                 page's sessionStorage. See the section comment for why that
                 fallback is not localStorage
       version   bump to invalidate every stored record, which is required
                 whenever KEEP changes
       freshMs   under this age an answer is served with no requests at all
       staleMs   between fresh and stale it is served AND rechecked behind the
                 admin's back. Past it the record is discarded unread
       maxBytes  a record larger than this is dropped rather than stored, so a
                 very large org degrades to no cache instead of a failed write */
  const CACHE = {
    enabled: true,
    backend: "auto", // "auto" | "extension" | "session" | "local" | "off"
    version: 3, // paging fixed, so a record built before it may be short
    freshMs: 15 * 60 * 1000,
    staleMs: 7 * 24 * 60 * 60 * 1000,
    maxBytes: 4 * 1024 * 1024,
  };

  /* WHICH APPS GET ASKED

     GROUP_PUSH in an app's "features" is the obvious test and it is what the
     console itself goes by, but trusting it alone means an app whose feature
     list does not advertise it is invisible here, and invisibly so: a missing
     app looks exactly like an app with no mappings. An app that does hold
     mappings and is never asked is the worst failure this module has, because
     nothing on screen suggests a gap.

     So the default is wider than strictly necessary. Any app carrying a
     provisioning feature at all gets asked, since group push can be
     configured on any of them and asking costs one small request. An app that
     turns out not to support the endpoint says so with a 400 or a 404, which
     is recorded as "does not support group push" rather than as a failure, so
     widening the net does not fill the UI with noise.

       strict        GROUP_PUSH in features, which is the console's own test
       provisioning  any provisioning feature, the default
       all-active    every active app, for working out what a filter is hiding

     ALWAYS_CHECK is the escape hatch: app ids or names here are asked whatever
     their features say. */
  const FILTER_MODE = "provisioning"; // "strict" | "provisioning" | "all-active"
  const ALWAYS_CHECK = [];
  const FEATURE_PUSH = "GROUP_PUSH";
  const FEATURES_PROVISIONING = [
    "GROUP_PUSH",
    "SCIM_PROVISIONING",
    "PUSH_NEW_USERS",
    "PUSH_PROFILE_UPDATES",
    "PUSH_USER_DEACTIVATION",
    "PUSH_PASSWORD_UPDATES",
    "REACTIVATE_USERS",
    "IMPORT_NEW_USERS",
    "IMPORT_PROFILE_UPDATES",
    "PROFILE_MASTERING",
  ];

  // A mappings endpoint that rejects the app outright, rather than failing.
  const UNSUPPORTED_STATUS = [400, 404, 405, 501];

  /* Deactivated apps are excluded, because a deactivated app is not pushing
     anything. Their mappings do survive in Okta, so set this true to list them
     too, at the cost of a wider crawl.
     Noticed via diagnose on a "Keeper Password Manager - Early Access"
     instance, which is INACTIVE and correctly absent. */
  const INCLUDE_INACTIVE = false;

  /* The Diagnostics link in the panel toolbar, and the box behind it. Edit to
     false to ship the tab without it, true to get it back; nothing in the
     console or the page exposes this, so an admin cannot turn it on.

     It governs the troubleshooting UI only. The notes that say an answer may
     be WRONG are not diagnostics and are never hidden: the truncated app list
     note, the "could not be checked" failure box, and the cache age in the
     status line all stay, because an admin acting on this tab needs to know
     when it is incomplete whether or not they are debugging it.

     The console helpers (diagnose, coverage, probe, cacheInfo) are unaffected
     and stay available, since they are invisible to anyone not looking for
     them and they are what makes a report from the field possible without
     shipping a new build. */
  const DIAGNOSTICS = false;

  // The only mapping fields anything here renders. Everything else in the
  // response is dropped before it reaches the index.
  const KEEP = [
    "mappingId",
    "status",
    "targetGroupName",
    "targetCreated",
    "ruleId",
    "pushErrorMessage",
    "lastSuccessfulPushTime",
    "lastPushTime",
  ];

  let host = null;
  let _observer = null;
  let _navClickBound = false;

  // Selection state. _restoreLi is the native tab we deactivated on the way
  // in, so leaving by any route other than a tab click (a hashchange from the
  // back button, say) can still put the console back as we found it.
  let _active = false;
  let _restoreLi = null;

  /* The reverse index, and the single build in flight against it. Scoped to
     the page rather than to a group, because none of it is group-specific.
       apps       the push-capable instances, trimmed and sorted by label
       order      app id to its position in apps, for row placement
       byGroup    sourceUserGroupId to [{ app, mapping }], the whole point
       done       app ids fully read, so an aborted build can resume
       failures   apps we could not read, kept so one 403 does not cost the
                  admin the other twenty answers
       complete   true only once every app has been read or has failed. A
                  partial index would make an unread app look like "not
                  pushed", so nothing may read it as an answer until this
     ---------------------------------------------------------------------- */
  const index = {
    apps: [],
    order: new Map(),
    byGroup: new Map(),
    done: new Set(),
    failures: [],
    complete: false,
    // Diagnostics, so "Keeper is not in the list" is answerable after the
    // fact rather than only by instrumenting a new run.
    activeApps: 0, // active apps seen, whether asked or not
    skipped: [], // { id, label, features } the filter excluded
    unsupported: [], // { id, label, status } the endpoint refused
    appPages: 0, // pages of the app list actually read
    truncated: null, // why the app list crawl stopped early, if it did
  };
  let _build = null; // in-flight build promise
  let _abort = null; // its AbortController

  /* Generation counter for builds. An abort cannot wait for the lanes it
     cancelled, so a superseded build's handlers are still queued when the next
     one starts. Without this they would clear the new build's _build and
     _abort, leaving it uncancellable, and a lane whose response had already
     arrived would file rows into an index that had since been reset. Every
     handler checks its generation before touching shared state. */
  let _buildSeq = 0;

  /* What searchString was measured to do. See the SEARCH PROBE block for what
     each state means and why the needle has to have differing names. */
  const probe = { state: "unknown", note: "", needle: null, measured: null };

  // groupId to its Okta name, which a filtered query needs. One request each,
  // and a group's name does not change under us mid-scan.
  const _groupNames = new Map();

  // Groups a filtered pass has fully covered. Distinct from index.complete,
  // which only a full crawl can set, because a filtered read saw one group's
  // mappings and says nothing about the rest of the app.
  const _fastDone = new Map();

  // Cache bookkeeping. _builtAt is when the full crawl behind the current
  // index ran, _fromCacheAt is set only when that index came off disk rather
  // than the wire, and _checkedAt names the groups rechecked since, which are
  // the ones no longer described by _fromCacheAt.
  let _builtAt = null;
  let _fromCacheAt = null;
  const _checkedAt = new Map();
  let _hydrate = null;
  let _revalidating = false;
  let _revalAbort = null;

  // The render currently on screen, or null when our panel is not showing. One
  // module-level listener reads this, which beats subscribing and
  // unsubscribing a handler per render.
  let _view = null;

  /* =========================================================================
     REQUESTS
  ========================================================================= */
  function isAbort(err) {
    return !!err && err.name === "AbortError";
  }

  function abortError() {
    const e = new Error("aborted");
    e.name = "AbortError";
    return e;
  }

  function delay(ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) return reject(abortError());
      function onAbort() {
        clearTimeout(timer);
        reject(abortError());
      }
      const timer = setTimeout(function () {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function request(path, signal) {
    const h = Object.assign({}, HEADERS);
    // Internal endpoints are read-only here, so the cookie is enough. The
    // token goes on anyway when the console has one, since an internal route
    // is free to start demanding it and a missing header is the kind of
    // failure that looks like a permissions problem.
    const token = host.getXsrfToken && host.getXsrfToken();
    if (token) h["X-Okta-XsrfToken"] = token;
    return fetch(location.origin + path, {
      headers: h,
      credentials: "include",
      signal: signal,
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

  // Prefer the org's own reset time over a guess. x-rate-limit-reset is epoch
  // seconds, so a stale or absent header falls back to exponential backoff.
  function backoffMs(res, attempt) {
    const reset = Number(res.headers.get("x-rate-limit-reset"));
    if (reset) {
      const wait = reset * 1000 - Date.now();
      if (wait > 0 && wait < 30000) return wait + 250;
    }
    return 500 * Math.pow(2, attempt);
  }

  // Resolves to { json, links }. links is {} unless the response carried a
  // Link header, which only the /api/v1/apps crawl needs.
  function getJSON(path, signal, attempt) {
    attempt = attempt || 0;
    return request(path, signal).then(function (res) {
      if ((res.status === 429 || res.status === 503) && attempt < RETRY_LIMIT) {
        return delay(backoffMs(res, attempt), signal).then(function () {
          return getJSON(path, signal, attempt + 1);
        });
      }
      if (!res.ok) {
        return res.text().then(function (body) {
          const err = new Error(errFrom(res.status, body));
          err.status = res.status;
          throw err;
        });
      }
      return res.json().then(function (json) {
        return { json: json, links: host.getLinks(res.headers.get("link")) };
      });
    });
  }

  /* Hold a request until the window has room. Keeps the timestamps of the last
     window and waits for the oldest to age out, so a 12-app org never waits
     and a 60-app org paces itself instead of being refused. Checked again
     after waiting, since other lanes take slots while we sleep.
     ---------------------------------------------------------------------- */
  let _stamps = [];

  function takeSlot(signal) {
    const now = Date.now();
    _stamps = _stamps.filter(function (t) {
      return now - t < LIMIT.windowMs;
    });
    if (_stamps.length < LIMIT.max) {
      _stamps.push(now);
      return Promise.resolve();
    }
    return delay(LIMIT.windowMs - (now - _stamps[0]) + 25, signal).then(
      function () {
        return takeSlot(signal);
      }
    );
  }

  /* Okta hands back absolute next-page URLs, and it builds them from the org's
     CANONICAL base URL rather than the host the request was sent to. On the
     admin console that means a request to acme-admin.okta.com is answered with
     a next link on acme.okta.com.

     Only the path is ever used, since every request here is issued against
     location.origin, so a differing origin is not a reason to discard the
     link. Rejecting it was a silent truncation bug: paging stopped after the
     first page and every app past that cursor became invisible, which looks
     exactly like an app with no push groups.

     Still refuses a host outside the org's own registrable domain, so a link
     this module did not expect cannot redirect a crawl.
     ---------------------------------------------------------------------- */
  let _warnedOrigin = false;

  function sameOrg(host) {
    if (host === location.host) return true;
    // acme-admin.okta.com and acme.okta.com share the last two labels.
    const a = host.split(".").slice(-2).join(".");
    const b = location.host.split(".").slice(-2).join(".");
    return a === b;
  }

  function toPath(url) {
    if (!url) return null;
    if (url.charAt(0) === "/") return url;
    try {
      const u = new URL(url, location.origin);
      if (u.origin !== location.origin) {
        if (!sameOrg(u.host)) return null;
        if (!_warnedOrigin) {
          _warnedOrigin = true;
          console.info(
            "[orb] push groups: Okta returned paging links on " +
              u.host +
              " rather than " +
              location.host +
              ", so only their paths are used."
          );
        }
      }
      return u.pathname + u.search;
    } catch (e) {
      return null;
    }
  }

  /* =========================================================================
     THE CRAWL
  ========================================================================= */

  /* Does this app get asked? Returns the reason either way, because the
     reason is what makes a missing app diagnosable.
     ---------------------------------------------------------------------- */
  function includeApp(app) {
    const features = (app && app.features) || [];
    const advertises = features.indexOf(FEATURE_PUSH) !== -1;

    if (
      ALWAYS_CHECK.indexOf(app.id) !== -1 ||
      ALWAYS_CHECK.indexOf(app.name) !== -1
    ) {
      return { ok: true, advertises: advertises, why: "listed in ALWAYS_CHECK" };
    }
    if (FILTER_MODE === "all-active") {
      return { ok: true, advertises: advertises, why: "filter is all-active" };
    }
    if (advertises) {
      return { ok: true, advertises: true, why: "features include " + FEATURE_PUSH };
    }
    if (FILTER_MODE === "strict") {
      return { ok: false, advertises: false, why: "features do not include " + FEATURE_PUSH };
    }
    const provisioning = features.filter(function (f) {
      return FEATURES_PROVISIONING.indexOf(f) !== -1;
    });
    if (provisioning.length) {
      return {
        ok: true,
        advertises: false,
        why: "provisioning features present (" + provisioning.join(", ") + ")",
      };
    }
    return {
      ok: false,
      advertises: false,
      why: features.length
        ? "no provisioning features (" + features.join(", ") + ")"
        : "no features reported",
    };
  }

  /* Every app instance that could hold a mapping. See WHICH APPS GET ASKED for
     why this is wider than the console's own test, and why an app excluded
     here is recorded rather than merely dropped.

     The status filter is server-side to keep the payload down, and re-checked
     client-side because a filter Okta stops honouring should not quietly widen
     the crawl.

     Each survivor is trimmed to the four fields that build its row, its link,
     and the decision about how to read an error from it, so the index holds
     none of the settings, credentials, or visibility blocks the list endpoint
     sends.
     ---------------------------------------------------------------------- */
  function appsPath() {
    let path = "/api/v1/apps?limit=" + APPS_PAGE_SIZE;
    if (!INCLUDE_INACTIVE) {
      path += "&filter=" + encodeURIComponent('status eq "ACTIVE"');
    }
    return path;
  }

  function loadPushApps(signal) {
    const apps = [];
    const seen = new Set();
    let pages = 0;
    let lastSeenId = null;
    index.activeApps = 0;
    index.skipped = [];
    index.unsupported = [];
    index.appPages = 0;
    index.truncated = null;

    function page(path) {
      return getJSON(path, signal).then(function (r) {
        const batch = r.json || [];
        index.appPages++;
        if (batch.length) lastSeenId = batch[batch.length - 1].id;

        /* Every page is deduplicated by id, and a page that adds nothing new
           ends the crawl. The cursor fallback below asks the server to resume
           after an id, and a server that ignores it answers with page one
           forever: without this the crawl would walk to the page limit
           re-reading the same apps and then ask every one of them for its
           mappings. */
        let fresh = 0;

        batch.forEach(function (app) {
          if (!app || seen.has(app.id)) return;
          seen.add(app.id);
          fresh++;
          if (!INCLUDE_INACTIVE && app.status !== "ACTIVE") return;
          index.activeApps++;
          const verdict = includeApp(app);
          if (!verdict.ok) {
            index.skipped.push({
              id: app.id,
              label: app.label,
              features: app.features || [],
              why: verdict.why,
            });
            return;
          }
          apps.push({
            id: app.id,
            name: app.name,
            label: app.label,
            // Whether the app said it supports group push. An error from one
            // that did is a real failure; from one we asked speculatively it
            // is just an answer.
            gp: verdict.advertises,
          });
        });

        let next = toPath(r.links && r.links.next);

        /* A full page and no usable next link is the shape of a truncation,
           not of a finished list. The endpoint also takes an explicit cursor,
           so the crawl continues on the last id rather than assuming it has
           seen everything. Belt and braces: the Link header is the normal
           route and this only engages when it goes missing. */
        if (!next && batch.length >= APPS_PAGE_SIZE && lastSeenId) {
          next = appsPath() + "&after=" + encodeURIComponent(lastSeenId);
        }

        if (next && !fresh && batch.length) {
          index.truncated =
            "the list stopped returning new applications after " +
            seen.size +
            " of them, so paging was abandoned";
          return;
        }

        if (next) {
          if (++pages >= MAX_PAGES) {
            index.truncated =
              "the " + MAX_PAGES + " page limit was reached";
            return;
          }
          return page(next);
        }

        // Nothing left to follow, yet the last page was full. Report it rather
        // than quietly returning a short list.
        if (batch.length >= APPS_PAGE_SIZE) {
          index.truncated =
            "the last page was full but offered no way to continue, neither a next link nor a working cursor";
        }
      });
    }

    return page(appsPath()).then(function () {
      // Sorted here so the streaming table has a stable order to insert into,
      // whatever order the apps come back in.
      apps.sort(function (a, b) {
        return String(a.label || "").localeCompare(String(b.label || ""));
      });
      return apps;
    });
  }

  /* One app's mappings. The response is an object, not an array:
       { searchString, searchStatus, ..., mappings: [...], nextMappingsPageUrl }
     with nextMappingsPageUrl null on the last page. Okta's own page size is
     200, so most apps are a single request.
     ---------------------------------------------------------------------- */
  function loadMappings(appId, signal, searchString) {
    const out = [];
    let pages = 0;

    function page(path) {
      return takeSlot(signal)
        .then(function () {
          return getJSON(path, signal);
        })
        .then(function (r) {
          const body = r.json || {};
          (body.mappings || []).forEach(function (m) {
            out.push(m);
          });
          const next = toPath(body.nextMappingsPageUrl);
          if (next && ++pages < MAX_PAGES) return page(next);
        });
    }

    // Paging follows the server's own nextMappingsPageUrl, which carries the
    // query through, so searchString is only spelled out on the first page.
    const base = "/api/internal/instance/" + encodeURIComponent(appId) + "/grouppush";
    return page(
      searchString
        ? base + "?searchString=" + encodeURIComponent(searchString)
        : base
    ).then(function () {
      return out;
    });
  }

  /* A group's name, which is what a filtered query has to send. Resolves to
     null on failure rather than throwing, since a name we cannot read means
     the scan falls back to reading everything, not that the scan fails.
     ---------------------------------------------------------------------- */
  function loadGroupName(groupId, signal) {
    if (_groupNames.has(groupId)) {
      return Promise.resolve(_groupNames.get(groupId));
    }
    return getJSON("/api/v1/groups/" + encodeURIComponent(groupId), signal)
      .then(function (r) {
        const name = r.json && r.json.profile && r.json.profile.name;
        _groupNames.set(groupId, name || null);
        return name || null;
      })
      .catch(function (err) {
        if (isAbort(err)) throw err;
        console.warn("[orb] push groups could not read the group name:", err.message);
        return null;
      });
  }

  /* Run worker over items, at most `limit` in flight. Promise.all over the
     whole list would open one request per push-capable app at once, which is
     the burst the concurrency limit exists to refuse.
     ---------------------------------------------------------------------- */
  function pool(items, limit, worker) {
    let cursor = 0;

    function next() {
      const i = cursor++;
      if (i >= items.length) return Promise.resolve();
      return worker(items[i], i).then(next);
    }

    const lanes = [];
    for (let i = 0; i < Math.min(limit, items.length); i++) lanes.push(next());
    return Promise.all(lanes);
  }

  /* =========================================================================
     THE INDEX
  ========================================================================= */
  function trim(mapping) {
    const out = {};
    KEEP.forEach(function (k) {
      if (mapping[k] != null) out[k] = mapping[k];
    });
    return out;
  }

  function resetIndex() {
    index.apps = [];
    index.order = new Map();
    index.byGroup = new Map();
    index.done = new Set();
    index.failures = [];
    index.complete = false;
    // Data, so it goes. The probe result is a capability rather than data and
    // survives, so Refresh does not pay to measure the endpoint again.
    _fastDone.clear();
  }

  function fileMapping(app, mapping) {
    const gid = mapping && mapping.sourceUserGroupId;
    if (!gid) return;
    let bucket = index.byGroup.get(gid);
    if (!bucket) {
      bucket = [];
      index.byGroup.set(gid, bucket);
    }
    // Keyed by mappingId rather than appended blindly, because a filtered pass
    // and the full crawl that verifies it both see the same mapping. Buckets
    // hold one group's mappings, so the scan is a few entries long.
    for (let i = 0; i < bucket.length; i++) {
      if (bucket[i].mapping.mappingId === mapping.mappingId) return;
    }
    bucket.push({ app: app, mapping: trim(mapping) });
  }

  // Events go to the one view on screen. Nothing subscribes, so an event
  // raised with the panel closed costs a null check.
  function emit(event) {
    try {
      onIndexEvent(event);
    } catch (e) {
      console.warn("[orb] push groups render failed:", e);
    }
  }

  /* =========================================================================
     SEARCH PROBE

     The mappings response echoes searchString, searchStatus, and searchRuleId,
     which says the endpoint takes those three as query parameters. If
     searchString filters server-side on the SOURCE group name, a scan can ask
     each app only about the group in the URL and a response shrinks from every
     mapping the app holds to the handful that matter. At roughly 3.5KB a
     mapping, that is the difference between megabytes of JSON.parse and
     kilobytes of it.

     What this must not do is assume. If the server filters on the TARGET group
     name instead, a query by the Okta group's name returns nothing for an app
     that does push the group, and a missing mapping reads as "not pushed",
     which is the one wrong answer this tab must never give. So the behaviour is
     measured once per page for the cost of a single extra request.

     Telling the two apart needs a mapping whose source and target names DIFFER,
     since that is the only case where the hypotheses predict different results.
     Where the names are equal, which is every mapping that kept its name on the
     way out, a source filter and a target filter return the same row and the
     difference is unobservable. Hence "either" below, and hence the background
     verification that makes "either" safe to act on anyway.

     States:
       unknown       not measured, or deferred because no app offered a needle
       source        proven. A needle with differing names came back from a
                     query on its SOURCE name, so target-only filtering is out
                     and the filtered scan is exact
       target        the needle came back only from a query on its TARGET name.
                     The filtered scan is impossible, since a group's target
                     name is precisely what we do not know yet
       either        filtering demonstrably happens, but every needle had
                     identical names, so the field cannot be identified. Exact
                     for mappings like those, and the verification pass covers
                     any mapping elsewhere whose names differ
       unsupported   the parameter was rejected or ignored. Harmless either way,
                     since every response is still filtered client-side on
                     sourceUserGroupId. Just not faster
  ========================================================================= */
  function distinctSourceNames(mappings) {
    const names = new Set();
    mappings.forEach(function (m) {
      if (m && m.sourceGroupName) names.add(m.sourceGroupName);
    });
    return names.size;
  }

  function has(mappings, mappingId) {
    return mappings.some(function (m) {
      return m && m.mappingId === mappingId;
    });
  }

  /* Measure searchString, once. The baseline read is an app the index wants
     anyway, so the measurement costs one request beyond the crawl, or two in
     the one case where it has to test the target-name hypothesis as well.
     ---------------------------------------------------------------------- */
  function probeOnce(signal, seq) {
    if (SEARCH_MODE === "off") return Promise.resolve();
    if (probe.state !== "unknown") return Promise.resolve();

    const app = index.apps[0];
    if (!app) {
      probe.state = "unsupported";
      probe.note = "no applications have group push enabled";
      return Promise.resolve();
    }

    // Read unfiltered even if a previous build already did. Only the trimmed
    // mapping survives in the index, and the probe needs sourceGroupName and
    // targetGroupName, which trim() drops.
    return loadMappings(app.id, signal, null)
      .then(function (mappings) {
        if (seq !== _buildSeq) return;
        mappings.forEach(function (m) {
          fileMapping(app, m);
        });
        index.done.add(app.id);

        if (!mappings.length) {
          // Nothing to measure against. Left unknown rather than unsupported,
          // so a later build with a different first app can try again.
          probe.note =
            "deferred: " + (app.label || app.name) + " has no push groups";
          return;
        }

        // Prefer a needle whose two names differ, since only that is decisive.
        const decisive = mappings.filter(function (m) {
          return (
            m.sourceGroupName &&
            m.targetGroupName &&
            m.sourceGroupName !== m.targetGroupName
          );
        });
        const needle = decisive[0] || mappings[0];
        const spread = distinctSourceNames(mappings);

        probe.needle = {
          app: app.label || app.name,
          mappingId: needle.mappingId,
          sourceGroupName: needle.sourceGroupName,
          targetGroupName: needle.targetGroupName,
          namesDiffer: !!decisive.length,
          baselineCount: mappings.length,
          distinctSourceNames: spread,
        };

        return loadMappings(app.id, signal, needle.sourceGroupName).then(
          function (filtered) {
            if (seq !== _buildSeq) return;
            probe.measured = {
              filteredCount: filtered.length,
              needleReturned: has(filtered, needle.mappingId),
            };

            if (!has(filtered, needle.mappingId)) {
              // A source-name query dropped the very mapping that carries that
              // name. Either the field is the target name or the parameter
              // means something else entirely; one more request says which.
              return loadMappings(app.id, signal, needle.targetGroupName).then(
                function (byTarget) {
                  if (seq !== _buildSeq) return;
                  if (has(byTarget, needle.mappingId)) {
                    probe.state = "target";
                    probe.note =
                      "searchString matches the target group name, so a query by the Okta group name is not usable";
                  } else {
                    probe.state = "unsupported";
                    probe.note =
                      "searchString did not return the mapping whose name was queried";
                  }
                }
              );
            }

            if (filtered.length === mappings.length && spread > 1) {
              // Every mapping came back from a query naming one of them, and
              // they do not all share a name, so the parameter was ignored.
              probe.state = "unsupported";
              probe.note = "searchString was accepted but did not filter";
              return;
            }

            if (decisive.length) {
              probe.state = "source";
              probe.note =
                "searchString matches the source group name, proven against a mapping whose names differ";
              return;
            }

            probe.state = "either";
            probe.note =
              "searchString filters by name, but every mapping checked had identical source and target names, so the field is unproven";
          }
        );
      })
      .catch(function (err) {
        if (isAbort(err)) throw err;
        if (seq !== _buildSeq) return;
        probe.state = "unsupported";
        probe.note = "probe request failed: " + (err.message || "unknown");
      });
  }

  function fastPathReady() {
    if (SEARCH_MODE === "off") return false;
    return probe.state === "source" || probe.state === "either";
  }

  /* Build, or resume, the index. Never rejects: a hard failure goes out as an
     error event and an abort just stops. Resuming matters because an aborted
     build keeps the apps it finished, so returning to the tab costs only the
     apps that were still in flight.

     opts.groupId   the group on screen. Present and the probe permitting, the
                    remaining apps are asked only about that group, which is
                    the fast path. Absent, every mapping is read and the index
                    becomes authoritative
     opts.strategy  "full" forces the second of those, which is what the
                    verification pass uses
     ---------------------------------------------------------------------- */
  function buildIndex(opts) {
    const o = opts || {};
    const forceFull = o.strategy === "full";
    if (index.complete) return Promise.resolve(index);
    if (_build) return _build;

    const seq = ++_buildSeq;
    _abort = new AbortController();
    const signal = _abort.signal;

    // The app list is a head-of-line block, so it is kept across an abort and
    // only crawled when the index has none.
    const appList = index.apps.length
      ? Promise.resolve(index.apps)
      : loadPushApps(signal).then(function (apps) {
          index.apps = apps;
          index.order = new Map(
            apps.map(function (a, i) {
              return [a.id, i];
            })
          );
          return apps;
        });

    _build = appList
      .then(function (apps) {
        if (seq !== _buildSeq) return null;
        emit({ type: "apps", done: index.done.size, total: apps.length });

        const measured = forceFull
          ? Promise.resolve()
          : probeOnce(signal, seq);

        return measured
          .then(function () {
            if (seq !== _buildSeq) return null;
            const wanted = !forceFull && o.groupId && fastPathReady();
            return wanted
              ? loadGroupName(o.groupId, signal)
              : Promise.resolve(null);
          })
          .then(function (groupName) {
            if (seq !== _buildSeq) return null;
            // No name means no query to send, so the scan reads everything.
            const filtered = !!groupName;

            index.failures = [];
            const todo = apps.filter(function (a) {
              return !index.done.has(a.id);
            });
            let done = apps.length - todo.length;

            return pool(todo, CONCURRENCY, function (app) {
              return loadMappings(app.id, signal, filtered ? groupName : null)
                .then(function (mappings) {
                  if (seq !== _buildSeq) return;
                  mappings.forEach(function (m) {
                    fileMapping(app, m);
                  });
                  // A filtered read saw one group's mappings, so it says
                  // nothing about the rest of this app and cannot mark it
                  // done. Only a full read earns that, which is what keeps
                  // index.complete honest.
                  if (!filtered) index.done.add(app.id);
                })
                .catch(function (err) {
                  if (isAbort(err)) throw err; // stop the lane, do not file it
                  if (seq !== _buildSeq) return;
                  // An app we asked speculatively is allowed to say no. One
                  // that advertised GROUP_PUSH and then refused is a failure
                  // the admin should see.
                  if (!app.gp && UNSUPPORTED_STATUS.indexOf(err.status) !== -1) {
                    index.unsupported.push({
                      id: app.id,
                      label: app.label,
                      status: err.status,
                    });
                    index.done.add(app.id);
                    return;
                  }
                  index.failures.push({ app: app, error: err });
                })
                .then(function () {
                  if (seq !== _buildSeq) return;
                  emit({
                    type: "app",
                    app: app,
                    done: ++done,
                    total: apps.length,
                    filtered: filtered,
                  });
                });
            }).then(function () {
              return { filtered: filtered, groupId: o.groupId };
            });
          });
      })
      .then(function (outcome) {
        if (seq !== _buildSeq) return index;
        _build = null;
        _abort = null;
        if (!outcome) return index; // superseded between steps

        if (outcome.filtered) {
          _fastDone.set(outcome.groupId, true);
          emit({ type: "done", filtered: true, verifying: VERIFY_IN_BACKGROUND });
          if (VERIFY_IN_BACKGROUND) verifyLater();
        } else {
          // A crawl that could not read the whole app list is not an
          // authoritative index, so it is not stored and not reused for other
          // groups. Better to pay for the crawl again than to answer "not
          // pushed" from a list that was cut short.
          index.complete = !index.truncated;
          // This page's own crawl, so nothing on screen is cached any more.
          _builtAt = Date.now();
          _fromCacheAt = null;
          _checkedAt.clear();
          emit({ type: "done", filtered: false, verifying: false });
          persist();
        }
        return index;
      })
      .catch(function (err) {
        if (seq !== _buildSeq) return index;
        _build = null;
        _abort = null;
        if (!isAbort(err)) emit({ type: "error", error: err });
        return index;
      });

    return _build;
  }

  /* The pass that makes a filtered answer safe to show at once. It reads every
     mapping, so the index becomes authoritative and later groups are free, and
     anything the filtered queries missed lands in the table as it arrives
     rather than being silently absent. Deferred a beat so the rendered rows
     are on screen before it starts competing for requests.
     ---------------------------------------------------------------------- */
  function verifyLater() {
    setTimeout(function () {
      if (index.complete || _build) return;
      buildIndex({ strategy: "full" });
    }, VERIFY_DELAY_MS);
  }

  function abortBuild() {
    _buildSeq++; // anything still in flight is now stale
    if (_abort) _abort.abort();
    _abort = null;
    _build = null;
    // A recheck runs on its own controller, since it is not a build and has no
    // generation to be stale against.
    if (_revalAbort) _revalAbort.abort();
    _revalAbort = null;
    _revalidating = false;
  }

  /* =========================================================================
     CACHE

     A cold scan on a large org is one request per push-capable app, so an
     admin who reloads the console pays for it again. The index is exactly the
     thing worth keeping: it is group-independent, already trimmed to the eight
     fields in KEEP, and a few hundred kilobytes rather than the megabytes the
     responses arrived as.

     What makes a cache here delicate is that push groups change. A mapping
     deleted in Okta would keep rendering, and one created a minute ago would
     be missing, with nothing on screen to say the answer is old. A plain
     expiry trades one of those for a slow first paint. So:

       under freshMs   served as-is, zero requests
       under staleMs   served immediately, then rechecked behind the admin.
                       The recheck REPLACES rather than merges, which is the
                       only way a deletion can ever be noticed
       older           discarded unread, and the scan runs cold

     The status line always says how old an answer is, so "showing 11 push
     groups from a cached scan 3 hours old, refreshing" is visible rather than
     implied, and Refresh drops the record and scans cold.

     WHERE IT IS STORED

     chrome.storage.local when the extension has the "storage" permission:
     extension-scoped, invisible to Okta's own page scripts, and persistent
     across tabs and restarts. Without that permission it falls back to the
     page's sessionStorage, which is per-tab and clears itself when the tab
     closes. The fallback is deliberately NOT localStorage: a record holds
     group names and app labels for the whole org, and parking that in
     page-readable storage that outlives the admin's session is not a default
     worth choosing for someone. Add "storage" to the manifest to get the
     persistent version.

     Records are keyed by org host, so two orgs open in two tabs cannot read
     each other's, and by version, so a change to KEEP invalidates rather than
     half-populating a table.
  ========================================================================= */
  const CACHE_KEY =
    "orb.pushgroups.v" + CACHE.version + "." + location.host;

  const store = (function () {
    function extension() {
      try {
        if (typeof chrome === "undefined") return null;
        if (!chrome.storage || !chrome.storage.local) return null; // no permission
        const api = chrome.storage.local;
        // Callback and promise forms both exist depending on manifest version,
        // so the callback is passed and the return value used only if it turns
        // out to be a promise.
        const call = function (method, arg) {
          return new Promise(function (resolve) {
            try {
              const r = api[method](arg, function () {
                resolve(arguments[0]);
              });
              if (r && typeof r.then === "function") {
                r.then(resolve, function () {
                  resolve(null);
                });
              }
            } catch (e) {
              resolve(null);
            }
          });
        };
        return {
          name: "chrome.storage.local",
          get(key) {
            return call("get", [key]).then(function (items) {
              return items ? items[key] : null;
            });
          },
          set(key, value) {
            const payload = {};
            payload[key] = value;
            return call("set", payload);
          },
          remove(key) {
            return call("remove", [key]);
          },
        };
      } catch (e) {
        return null;
      }
    }

    function web(kind) {
      try {
        const raw = kind === "session" ? window.sessionStorage : window.localStorage;
        if (!raw) return null;
        const probeKey = "__orb_cache_probe__";
        raw.setItem(probeKey, "1"); // throws under private mode or a blocked origin
        raw.removeItem(probeKey);
        return {
          name: kind === "session" ? "sessionStorage" : "localStorage",
          get(key) {
            return Promise.resolve(raw.getItem(key));
          },
          set(key, value) {
            try {
              raw.setItem(key, value);
            } catch (e) {
              console.warn("[orb] push groups could not store its index:", e.message);
            }
            return Promise.resolve();
          },
          remove(key) {
            try {
              raw.removeItem(key);
            } catch (e) {}
            return Promise.resolve();
          },
        };
      } catch (e) {
        return null;
      }
    }

    if (!CACHE.enabled || CACHE.backend === "off") return null;
    if (CACHE.backend === "extension") return extension();
    if (CACHE.backend === "session") return web("session");
    if (CACHE.backend === "local") return web("local");
    return extension() || web("session");
  })();

  function ago(ms) {
    const mins = Math.round(ms / 60000);
    if (mins < 1) return "less than a minute old";
    if (mins < 60) return mins + (mins === 1 ? " minute old" : " minutes old");
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours + (hours === 1 ? " hour old" : " hours old");
    const days = Math.round(hours / 24);
    return days + (days === 1 ? " day old" : " days old");
  }

  // How old the answer on screen is, or null when it came from this page's own
  // crawl. A group rechecked since the record loaded is no longer described by
  // that record, so it reports null too.
  function cacheAge(groupId) {
    if (groupId && _checkedAt.has(groupId)) return null;
    return _fromCacheAt == null ? null : Date.now() - _fromCacheAt;
  }

  /* Read the record, once per page. Resolves either way, since a cache that
     cannot be read is a slow scan rather than a broken tab.
     ---------------------------------------------------------------------- */
  function hydrateOnce() {
    if (_hydrate) return _hydrate;
    _hydrate = (store ? store.get(CACHE_KEY) : Promise.resolve(null))
      .then(function (text) {
        if (text) adopt(text);
      })
      .catch(function (err) {
        console.warn("[orb] push groups cache read failed:", err && err.message);
      });
    return _hydrate;
  }

  function adopt(text) {
    // Never over the top of live data. A crawl that has already started or
    // finished in this page is newer than anything on disk.
    if (index.complete || _build || index.done.size) return;

    let record;
    try {
      record = JSON.parse(text);
    } catch (e) {
      return store && store.remove(CACHE_KEY);
    }
    if (!record || record.v !== CACHE.version || record.host !== location.host) {
      return store && store.remove(CACHE_KEY);
    }
    const age = Date.now() - (record.builtAt || 0);
    if (!(age >= 0) || age > CACHE.staleMs) {
      return store && store.remove(CACHE_KEY);
    }
    if (!Array.isArray(record.apps) || !record.groups) return;

    index.apps = record.apps;
    index.order = new Map(
      record.apps.map(function (a, i) {
        return [a.id, i];
      })
    );
    index.byGroup = new Map();
    Object.keys(record.groups).forEach(function (gid) {
      const bucket = [];
      (record.groups[gid] || []).forEach(function (e) {
        const app = record.apps[e.a];
        if (app && e.m) bucket.push({ app: app, mapping: e.m });
      });
      if (bucket.length) index.byGroup.set(gid, bucket);
    });
    index.done = new Set(
      record.apps.map(function (a) {
        return a.id;
      })
    );
    index.failures = [];
    index.complete = true;
    _builtAt = record.builtAt;
    _fromCacheAt = record.builtAt;
    _checkedAt.clear();

    // The measurement is a property of the endpoint, not of the data, so a
    // cached result spares the probe's extra request too.
    if (record.probe && record.probe.state && probe.state === "unknown") {
      probe.state = record.probe.state;
      probe.note = record.probe.note || "restored from cache";
    }
  }

  /* Write the record. Only a complete index is worth storing: a filtered pass
     knows one group and a part-built crawl would make unread apps look like
     "not pushed" on the next page load, which is the one wrong answer this tab
     must never give.

     Apps are stored once and referenced by position, since the same app is the
     source of many mappings.
     ---------------------------------------------------------------------- */
  function persist() {
    if (!store || !index.complete) return Promise.resolve();

    const slot = new Map(
      index.apps.map(function (a, i) {
        return [a.id, i];
      })
    );
    const groups = {};
    index.byGroup.forEach(function (bucket, gid) {
      const rows = [];
      bucket.forEach(function (e) {
        const at = slot.has(e.app.id) ? slot.get(e.app.id) : -1;
        if (at >= 0) rows.push({ a: at, m: e.mapping });
      });
      if (rows.length) groups[gid] = rows;
    });

    let text;
    try {
      text = JSON.stringify({
        v: CACHE.version,
        host: location.host,
        builtAt: _builtAt || Date.now(),
        probe: { state: probe.state, note: probe.note },
        apps: index.apps,
        groups: groups,
      });
    } catch (e) {
      return Promise.resolve();
    }

    if (text.length > CACHE.maxBytes) {
      console.warn(
        "[orb] push groups index is " +
          Math.round(text.length / 1024) +
          "KB, over the cache limit, so it was not stored."
      );
      return store.remove(CACHE_KEY);
    }
    return store.set(CACHE_KEY, text);
  }

  function clearCache() {
    _builtAt = null;
    _fromCacheAt = null;
    _checkedAt.clear();
    return store ? store.remove(CACHE_KEY) : Promise.resolve();
  }

  /* =========================================================================
     REVALIDATION

     What runs behind a stale answer. Both routes REPLACE rather than merge,
     because a merge can only ever add: a mapping deleted in Okta would survive
     every recheck forever.

     The group route is the cheap one and needs the search fast path, since it
     asks each app about one group. The full route is the fallback and rebuilds
     the index, keeping the old one aside so a failed recheck leaves the admin
     with the answer they already had rather than an empty table.
  ========================================================================= */
  function revalidate(groupId) {
    if (_build || _revalidating) return Promise.resolve();
    return fastPathReady() ? revalidateGroup(groupId) : revalidateAll();
  }

  function revalidateGroup(groupId) {
    _revalidating = true;
    _revalAbort = new AbortController();
    const signal = _revalAbort.signal;

    return loadGroupName(groupId, signal)
      .then(function (name) {
        if (!name) {
          _revalidating = false;
          return revalidateAll();
        }
        const fresh = [];
        return pool(index.apps.slice(), CONCURRENCY, function (app) {
          return loadMappings(app.id, signal, name)
            .then(function (mappings) {
              mappings.forEach(function (m) {
                if (m && m.sourceUserGroupId === groupId) {
                  fresh.push({ app: app, mapping: trim(m) });
                }
              });
            })
            .catch(function (err) {
              if (isAbort(err)) throw err;
              // One unreadable app should not void the recheck, but it does
              // mean this group cannot be marked rechecked below.
              index.failures.push({ app: app, error: err });
            });
        }).then(function () {
          if (fresh.length) index.byGroup.set(groupId, fresh);
          else index.byGroup.delete(groupId);
          _revalidating = false;
          _revalAbort = null;
          if (!index.failures.length) _checkedAt.set(groupId, Date.now());
          persist();
          repaint(groupId);
        });
      })
      .catch(function (err) {
        _revalidating = false;
        _revalAbort = null;
        if (!isAbort(err)) {
          console.warn("[orb] push groups recheck failed:", err && err.message);
        }
      });
  }

  function revalidateAll() {
    const keep = {
      apps: index.apps,
      order: index.order,
      byGroup: index.byGroup,
      done: index.done,
    };
    _revalidating = true;
    resetIndex(); // the app list goes too, so a newly enabled app is picked up

    return buildIndex({ strategy: "full" }).then(function () {
      _revalidating = false;
      if (!index.complete) {
        // Aborted or failed. Put back what the admin was already looking at.
        index.apps = keep.apps;
        index.order = keep.order;
        index.byGroup = keep.byGroup;
        index.done = keep.done;
        index.complete = true;
        return;
      }
      repaint(_view && _view.groupId);
    });
  }

  // Redraw the table from the index. Used after a replace, where rows may have
  // gone rather than only arrived, so appendAppBlock's per-app idempotence is
  // not enough on its own.
  function repaint(groupId) {
    const view = _view;
    if (!view || !groupId || view.groupId !== groupId) return;
    if (!document.getElementById(PANEL_ID)) return;
    while (view.table.tBodies.length) {
      view.table.removeChild(view.table.tBodies[0]);
    }
    view.rows = 0;
    view.table.style.display = "none";
    paintIndexed(view);
    finishView(view);
  }

  /* =========================================================================
     TAB STRIP
  ========================================================================= */
  function nav() {
    return document.querySelector(NAV_SEL);
  }

  function content() {
    return document.querySelector(CONTENT_SEL);
  }

  function ourAnchor() {
    return document.getElementById(TAB_ID);
  }

  function ourLi() {
    const a = ourAnchor();
    return a && a.closest("li");
  }

  function panelFor(anchor) {
    return anchor && anchor.id
      ? document.getElementById(anchor.id + PANEL_SUFFIX)
      : null;
  }

  function hideNativePanels() {
    const c = content();
    if (!c) return;
    Array.prototype.forEach.call(c.children, function (el) {
      if (NATIVE_PANEL_RE.test(el.id) && el.id !== PANEL_ID) {
        el.classList.add("hidden");
      }
    });
  }

  function clearSelection() {
    const n = nav();
    if (!n) return;
    n.querySelectorAll("li").forEach(function (li) {
      li.classList.remove.apply(li.classList, SELECTED);
    });
  }

  // Select one of Okta's tabs the way Okta would. Used on the way out, so the
  // console is left consistent whether or not its own handler fires.
  function selectNative(anchor) {
    if (!anchor) return;
    clearSelection();
    const li = anchor.closest("li");
    if (li) li.classList.add.apply(li.classList, SELECTED);
    hideNativePanels();
    const panel = panelFor(anchor);
    if (panel) panel.classList.remove("hidden");
  }

  function activate() {
    if (_active) return;
    const li = ourLi();
    const panel = document.getElementById(PANEL_ID);
    if (!li || !panel) return;

    // Remember what was up, so a hashchange exit can restore it.
    const current = nav() && nav().querySelector("li.ui-state-active");
    _restoreLi = current && current !== li ? current : null;

    clearSelection();
    hideNativePanels();
    li.classList.add.apply(li.classList, SELECTED);
    panel.classList.remove("hidden");
    _active = true;

    render();
  }

  // targetAnchor is the native tab the admin asked for, or null when we are
  // leaving for another reason and should put back whatever we took down.
  function deactivate(targetAnchor) {
    if (!_active) return;
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.classList.add("hidden");
    const li = ourLi();
    if (li) li.classList.remove.apply(li.classList, SELECTED);
    _active = false;

    // Nobody is watching the crawl now, so stop it rather than pay for
    // responses the stale guard would discard. What finished stays indexed and
    // the next selection resumes from there.
    _view = null;
    abortBuild();

    const back =
      targetAnchor || (_restoreLi && _restoreLi.querySelector("a")) || firstAnchor();
    selectNative(back);
    _restoreLi = null;
  }

  function firstAnchor() {
    const n = nav();
    return n ? n.querySelector("li:not(." + MARK + "-tab) a") : null;
  }

  /* One listener on the document, in the capture phase, rather than one per
     tab: the console re-renders the strip, and a listener per anchor would
     have to be re-bound every time. Capture means we tear our panel down
     before Okta's handler puts its own up, so the two never both show.
     ---------------------------------------------------------------------- */
  function bindNavClicks() {
    if (_navClickBound) return;
    _navClickBound = true;

    document.addEventListener(
      "click",
      function (e) {
        if (!_active) return;
        const a = e.target && e.target.closest && e.target.closest(NAV_SEL + " a");
        if (!a || a.id === TAB_ID) return;
        deactivate(a);
      },
      true
    );

    // Back and forward move the hash without a click. Hand control to
    // whichever native tab the new hash names.
    window.addEventListener("hashchange", function () {
      if (!_active) return;
      const hash = location.hash;
      const a =
        hash && hash.length > 1
          ? document.querySelector(NAV_SEL + ' a[href="' + hash + '"]')
          : null;
      deactivate(a);
    });
  }

  /* =========================================================================
     PANEL
  ========================================================================= */
  function buildPanel() {
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = "hidden " + host.ui.MARK + " " + MARK + "-panel";

    const heading = document.createElement("h3");
    heading.textContent = "Push Groups";
    panel.appendChild(heading);

    const list = document.createElement("div");
    list.className = "data-list";

    const toolbar = document.createElement("div");
    toolbar.className = "data-list-toolbar clearfix";
    toolbar.setAttribute("data-se", "data-list-toolbar");

    const status = document.createElement("span");
    status.className = MARK + "-status";
    status.style.cssText = "display:inline-block;padding:6px 0;color:#6e6e78;";
    toolbar.appendChild(status);

    const refresh = document.createElement("a");
    refresh.className = "float-r link-button " + MARK + "-refresh";
    refresh.setAttribute("data-se", "button");
    refresh.href = "#";
    refresh.textContent = "Refresh";
    refresh.addEventListener("click", function (e) {
      e.preventDefault();
      abortBuild();
      resetIndex();
      // Refresh means the admin does not trust what is on screen, so the
      // stored record goes with it rather than being adopted again on the
      // next render.
      clearCache().then(render);
    });
    toolbar.appendChild(refresh);

    /* Diagnostics live in the panel rather than only on window, because the
       extension runs in an isolated world: anything hung off window here is
       invisible to the DevTools console unless the admin switches its
       execution context first, which is not a reasonable ask for working out
       why one app is missing from a table. Governed by DIAGNOSTICS, so the
       link and the box are either both built or neither is. */
    if (DIAGNOSTICS) {
      const diagLink = document.createElement("a");
      diagLink.className = "float-r link-button " + MARK + "-diag-toggle";
      diagLink.setAttribute("data-se", "button");
      diagLink.href = "#";
      diagLink.textContent = "Diagnostics";
      diagLink.style.marginRight = "8px";
      diagLink.addEventListener("click", function (e) {
        e.preventDefault();
        const box = document.querySelector("." + MARK + "-diagnostics");
        if (!box) return;
        if (!box.classList.contains("hidden")) {
          box.classList.add("hidden");
          return;
        }
        box.classList.remove("hidden");
        renderDiagnostics(box);
      });
      toolbar.appendChild(diagLink);
    }

    const body = document.createElement("div");
    body.className = "data-list-content " + MARK + "-body";

    list.appendChild(toolbar);
    list.appendChild(body);
    panel.appendChild(list);

    if (DIAGNOSTICS) {
      const diagnostics = document.createElement("div");
      diagnostics.className = MARK + "-diagnostics hidden";
      diagnostics.style.cssText =
        "margin-top:16px;padding:12px 14px;border:1px solid #e3e4e7;" +
        "border-radius:4px;font-size:12px;line-height:1.6;";
      panel.appendChild(diagnostics);
    }

    return panel;
  }

  /* =========================================================================
     DIAGNOSTICS BOX

     What the console helpers report, in the page. Two halves: what the last
     crawl covered, and a box to ask about one app by name, which runs the same
     five-gate walk diagnose() does.
  ========================================================================= */
  function diagLine(parent, text) {
    const el = document.createElement("div");
    el.textContent = text;
    parent.appendChild(el);
    return el;
  }

  function diagList(parent, title, rows) {
    if (!rows.length) return;
    const head = document.createElement("div");
    head.style.cssText = "margin-top:8px;font-weight:bold;";
    head.textContent = title + " (" + rows.length + ")";
    parent.appendChild(head);

    const ul = document.createElement("ul");
    ul.style.cssText = "margin:2px 0 0;padding-left:18px;";
    rows.slice(0, 25).forEach(function (text) {
      const li = document.createElement("li");
      li.textContent = text;
      ul.appendChild(li);
    });
    if (rows.length > 25) {
      const li = document.createElement("li");
      li.style.color = "#6e6e78";
      li.textContent = "and " + (rows.length - 25) + " more";
      ul.appendChild(li);
    }
    parent.appendChild(ul);
  }

  function renderDiagnostics(box) {
    box.textContent = "";

    const head = document.createElement("div");
    head.style.cssText = "font-weight:bold;margin-bottom:6px;";
    head.textContent = "Diagnostics";
    box.appendChild(head);

    const cov = coverage();
    diagLine(box, "Application filter: " + cov.filterMode);
    diagLine(
      box,
      "Application list: " +
        cov.appPages +
        (cov.appPages === 1 ? " page read" : " pages read") +
        (cov.truncated ? ", TRUNCATED: " + cov.truncated : ", read in full")
    );
    diagLine(
      box,
      "Applications: " +
        cov.activeApps +
        " active, " +
        cov.asked +
        " asked about push groups, " +
        cov.skipped.length +
        " skipped, " +
        cov.unsupported.length +
        " do not support it, " +
        cov.failures.length +
        " could not be read"
    );
    diagLine(
      box,
      "Search probe: " + probe.state + (probe.note ? " (" + probe.note + ")" : "")
    );
    diagLine(
      box,
      "Index: " +
        (index.complete ? "complete" : "still building") +
        ", " +
        (_fromCacheAt
          ? "from a cached scan " + ago(Date.now() - _fromCacheAt)
          : "built in this page") +
        ", holding " +
        index.byGroup.size +
        (index.byGroup.size === 1 ? " group" : " groups")
    );
    diagLine(box, "Cache storage: " + (store ? store.name : "none"));

    diagList(
      box,
      "Skipped by the filter",
      cov.skipped.map(function (a) {
        return (a.label || a.id) + ": " + a.why;
      })
    );
    diagList(
      box,
      "No group push support",
      cov.unsupported.map(function (a) {
        return (a.label || a.id) + ": HTTP " + a.status;
      })
    );
    diagList(
      box,
      "Could not be read",
      cov.failures.map(function (a) {
        return (a.label || a.id) + ": " + a.error;
      })
    );

    /* ---- ask about one app ------------------------------------------- */
    const askHead = document.createElement("div");
    askHead.style.cssText = "margin-top:12px;font-weight:bold;";
    askHead.textContent = "Why is an application missing?";
    box.appendChild(askHead);

    const hint = document.createElement("div");
    hint.style.color = "#6e6e78";
    hint.textContent =
      "Checks whether it is visible to your role, active, included by the filter, readable, and pushing this group.";
    box.appendChild(hint);

    const row = document.createElement("div");
    row.style.cssText = "margin-top:6px;display:flex;gap:8px;align-items:center;";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Application name";
    input.className = MARK + "-diag-input";
    input.style.cssText = "flex:0 1 260px;";

    const go = document.createElement("a");
    go.className = "link-button button-primary";
    go.setAttribute("data-se", "button");
    go.href = "#";
    go.textContent = "Check";

    const out = document.createElement("div");
    out.style.cssText = "margin-top:8px;";

    function run() {
      const q = input.value.trim();
      if (!q) return;
      out.textContent = "Checking " + q + "...";
      diagnose(q).then(function (report) {
        out.textContent = "";
        if (report.error) {
          diagLine(out, "The check failed: " + report.error);
          return;
        }
        if (!report.apps || !report.apps.length) {
          diagLine(out, report.verdict);
          return;
        }
        report.apps.forEach(function (a) {
          const name = document.createElement("div");
          name.style.fontWeight = "bold";
          name.textContent = (a.label || a.name) + " (" + a.id + ")";
          out.appendChild(name);
          diagLine(out, a.verdict);
          if (a.pushesOtherGroups && a.pushesOtherGroups.length) {
            diagLine(
              out,
              "It pushes: " + a.pushesOtherGroups.slice(0, 6).join(", ")
            );
          }
        });
      });
    }

    go.addEventListener("click", function (e) {
      e.preventDefault();
      run();
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        run();
      }
    });

    row.appendChild(input);
    row.appendChild(go);
    box.appendChild(row);
    box.appendChild(out);
  }

  function parts() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return null;
    return {
      panel: panel,
      status: panel.querySelector("." + MARK + "-status"),
      body: panel.querySelector("." + MARK + "-body"),
    };
  }

  function setStatus(text) {
    const p = parts();
    if (p && p.status) p.status.textContent = text || "";
  }

  function appUrl(app) {
    // The same shape the console uses, pointed straight at the app's own Push
    // Groups tab so the admin lands on the mapping, not the app's General tab.
    return (
      "/admin/app/" +
      encodeURIComponent(app.name) +
      "/instance/" +
      encodeURIComponent(app.id) +
      "/#tab-group-push"
    );
  }

  function fmtDate(iso) {
    if (!iso) return "Never";
    const d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
  }

  function emptyState(headline, detail) {
    const wrap = document.createElement("div");
    wrap.className = "data-list-empty-msg";
    const h4 = document.createElement("h4");
    h4.className = "data-list-head data-list-empty-head";
    h4.textContent = headline;
    wrap.appendChild(h4);
    if (detail) {
      const h5 = document.createElement("h5");
      h5.className =
        "data-list-head data-list-empty-head data-list-empty-subhead";
      h5.textContent = detail;
      wrap.appendChild(h5);
    }
    return wrap;
  }

  function buildTableShell() {
    const table = document.createElement("table");
    table.className = "data-list-table";
    table.setAttribute("data-se", "data-list-table");
    table.style.display = "none"; // shown by the first row that lands

    const head = table.createTHead().insertRow(-1);
    ["Application", "Target group", "Status", "Last successful push"].forEach(
      function (label) {
        const th = document.createElement("th");
        th.setAttribute("role", "columnheader");
        th.textContent = label;
        head.appendChild(th);
      }
    );
    return table;
  }

  function cell(row, text) {
    const td = row.insertCell(-1);
    td.textContent = text == null ? "" : String(text);
    return td;
  }

  function buildRow(app, m, withLink) {
    const row = document.createElement("tr");

    // The app name repeats down a group pushed to several target groups in one
    // app, which is rare but real, so only the first row of a run carries the
    // link.
    const appCell = row.insertCell(-1);
    if (withLink) {
      const link = document.createElement("a");
      link.href = appUrl(app);
      link.textContent = app.label || app.name;
      appCell.appendChild(link);
    }

    cell(row, m.targetGroupName || "Not yet created");

    const statusCell = row.insertCell(-1);
    statusCell.textContent = m.status || "";
    if (m.pushErrorMessage) {
      const note = document.createElement("div");
      note.style.cssText = "color:#b00;font-size:12px;";
      note.textContent = m.pushErrorMessage;
      statusCell.appendChild(note);
    }
    if (m.ruleId) {
      const note = document.createElement("div");
      note.style.cssText = "color:#6e6e78;font-size:12px;";
      note.textContent = "Pushed by rule";
      statusCell.appendChild(note);
    }

    cell(row, fmtDate(m.lastSuccessfulPushTime || m.lastPushTime));
    return row;
  }

  /* One <tbody> per app, carrying that app's position in the sorted list and
     inserted ahead of the first block that sorts after it. That is what keeps
     a streamed table alphabetical while the apps themselves resolve in
     whatever order the network returns them. A table may hold many tbody
     elements, which is what makes the insert a single DOM operation rather
     than a re-sort of the rows.
     ---------------------------------------------------------------------- */
  function appendAppBlock(view, app, mappings) {
    if (!mappings.length) return;
    // Idempotent per app, because re-entering the tab mid-build repaints
    // everything already indexed and a later event may name the same app.
    if (view.table.querySelector('tbody[data-orb-app="' + app.id + '"]')) return;
    const order = index.order.has(app.id) ? index.order.get(app.id) : 9999;

    const tbody = document.createElement("tbody");
    tbody.dataset.orbApp = app.id;
    tbody.dataset.orbOrder = String(order);
    mappings.forEach(function (m, i) {
      tbody.appendChild(buildRow(app, m, i === 0));
    });

    const bodies = view.table.tBodies;
    let before = null;
    for (let i = 0; i < bodies.length; i++) {
      if (Number(bodies[i].dataset.orbOrder) > order) {
        before = bodies[i];
        break;
      }
    }
    view.table.insertBefore(tbody, before); // before null appends

    view.rows += mappings.length;
    view.table.style.display = "";
  }

  // This group's mappings from one app, read back out of the index rather than
  // carried on the event, so a row has one source of truth.
  function mappingsFor(groupId, appId) {
    return (index.byGroup.get(groupId) || [])
      .filter(function (e) {
        return e.app.id === appId;
      })
      .map(function (e) {
        return e.mapping;
      });
  }

  // Counts come off the event rather than index.done, because a filtered pass
  // reads apps without ever marking them done.
  function progressText(done, total) {
    return "Checked " + done + " of " + total + " applications";
  }

  function buildFailures(failures) {
    const wrap = document.createElement("div");
    wrap.style.cssText =
      "margin-top:12px;padding:8px 10px;border:1px solid #e3e4e7;border-radius:4px;";

    const head = document.createElement("div");
    head.style.cssText = "font-weight:bold;margin-bottom:4px;";
    const denied = failures.filter(function (f) {
      return f.error && f.error.status === 403;
    }).length;
    head.textContent =
      failures.length +
      (failures.length === 1 ? " application" : " applications") +
      " could not be checked" +
      (denied ? ", so this list may be incomplete" : "");
    wrap.appendChild(head);

    const ul = document.createElement("ul");
    ul.style.cssText = "margin:0;padding-left:18px;font-size:12px;";
    failures.forEach(function (f) {
      const li = document.createElement("li");
      li.textContent =
        (f.app.label || f.app.name) + ": " + (f.error.message || "unknown error");
      ul.appendChild(li);
    });
    wrap.appendChild(ul);

    if (denied) {
      const hint = document.createElement("div");
      hint.style.cssText = "margin-top:6px;font-size:12px;color:#6e6e78;";
      hint.textContent =
        "A role without access to an application's provisioning settings cannot read its push groups.";
      wrap.appendChild(hint);
    }

    return wrap;
  }

  /* =========================================================================
     RENDER

     Three paths into the same view. A complete index fills the table in one
     go, which is every group after the first. A group a filtered pass already
     covered does the same, with a note that verification is still running. An
     index with neither draws the shell and lets onIndexEvent fill it as apps
     land.

     The notes box exists so finishView can run more than once. A filtered
     answer finishes, then the verification pass finishes over the top of it,
     and an empty state or a failure list appended twice would otherwise stack.
  ========================================================================= */
  function render() {
    const p = parts();
    if (!p) return;
    const groupId = host.groupIdFromPath();
    if (!groupId) return;

    p.body.textContent = "";

    const table = buildTableShell();
    const loading = document.createElement("h4");
    loading.className = "data-list-head";
    loading.textContent = "Loading...";
    const notes = document.createElement("div");

    p.body.appendChild(table);
    p.body.appendChild(loading);
    p.body.appendChild(notes);

    const view = {
      groupId: groupId,
      table: table,
      loading: loading,
      notes: notes,
      rows: 0,
    };
    _view = view;
    setStatus("Checking applications for group push...");

    // The cache read is asynchronous on chrome.storage, so the shell above is
    // drawn first and the decision is made once, after the record has had its
    // chance to load. Resolves immediately on every render after the first.
    hydrateOnce().then(function () {
      if (_view !== view) return; // superseded while we waited
      decide(view);
    });
  }

  function decide(view) {
    // Everything the index already holds for this group, whether it came off
    // disk, from a finished crawl, or from one still running. Returning to the
    // tab mid-crawl therefore shows the apps that landed while it was closed.
    paintIndexed(view);

    if (index.complete) {
      const age = cacheAge(view.groupId);
      const stale = age !== null && age > CACHE.freshMs;
      finishView(view, { verifying: stale });
      if (stale) revalidate(view.groupId);
      return;
    }

    // A filtered pass already answered this group. The rows are in the index,
    // so there is nothing to request; the verification pass, if it is running,
    // will add anything the filtered queries missed.
    if (_fastDone.get(view.groupId)) {
      finishView(view, { verifying: VERIFY_IN_BACKGROUND && !index.complete });
      if (VERIFY_IN_BACKGROUND && !index.complete && !_build) verifyLater();
      return;
    }

    buildIndex({ groupId: view.groupId });
  }

  function paintIndexed(view) {
    const seen = new Set();
    (index.byGroup.get(view.groupId) || []).forEach(function (e) {
      if (seen.has(e.app.id)) return;
      seen.add(e.app.id);
      appendAppBlock(view, e.app, mappingsFor(view.groupId, e.app.id));
    });
  }

  function onIndexEvent(event) {
    const view = _view;
    if (!view) return;

    // The panel can be torn out by a console re-render, and the admin can move
    // to another group mid-crawl.
    if (!document.getElementById(PANEL_ID)) {
      _view = null;
      return;
    }
    if (host.groupIdFromPath() !== view.groupId) return;

    if (event.type === "apps") {
      if (!view.finished) setStatus(progressText(event.done, event.total));
      return;
    }
    if (event.type === "app") {
      appendAppBlock(view, event.app, mappingsFor(view.groupId, event.app.id));
      // Once an answer is on screen the verification pass runs behind it, so
      // its arrivals refresh the counts rather than reopening a progress line.
      if (view.finished) finishView(view, { verifying: true });
      else setStatus(progressText(event.done, event.total));
      return;
    }
    if (event.type === "done") {
      finishView(view, { verifying: !!event.verifying });
      return;
    }
    if (event.type === "error") {
      failView(view, event.error);
    }
  }

  function finishView(view, opts) {
    const o = opts || {};
    if (view.loading && view.loading.parentNode) view.loading.remove();
    const p = parts();
    if (!p) return;
    view.finished = true;
    view.notes.textContent = ""; // rebuilt on every finish, never appended to

    if (!index.apps.length && !_revalidating) {
      setStatus("");
      view.notes.appendChild(
        emptyState(
          "No applications in this org have group push enabled",
          "Group push is configured per application, under Provisioning."
        )
      );
      return;
    }

    const appCount = view.table.tBodies.length;
    const headline = view.rows
      ? "Showing " +
        view.rows +
        (view.rows === 1 ? " push group across " : " push groups across ") +
        appCount +
        (appCount === 1 ? " application" : " applications") +
        ", from " +
        index.apps.length +
        " checked"
      : "Checked " + index.apps.length + " applications with group push enabled";

    // An admin acting on this needs to know whether it was measured or
    // remembered, so the age is in the line rather than implied by it.
    const age = cacheAge(view.groupId);
    let suffix = age === null ? "" : ", from a cached scan " + ago(age);
    if (o.verifying) suffix += suffix ? ", refreshing" : " (verifying)";
    setStatus(headline + suffix);

    if (!view.rows && !o.verifying) {
      view.notes.appendChild(
        emptyState(
          "This group is not pushed to any application",
          "Push a group from an application's Push Groups tab."
        )
      );
    }

    if (index.truncated) {
      view.notes.appendChild(buildTruncationNote());
    }

    if (index.failures.length) {
      view.notes.appendChild(buildFailures(index.failures));
    }
  }

  /* An app list read short is the one failure that cannot be inferred from the
     table, since an app never asked looks identical to an app with nothing to
     show. It gets its own note rather than being folded into the failures box,
     which is about apps that were asked.
     ---------------------------------------------------------------------- */
  function buildTruncationNote() {
    const wrap = document.createElement("div");
    wrap.style.cssText =
      "margin-top:12px;padding:8px 10px;border:1px solid #e3e4e7;border-radius:4px;";
    const head = document.createElement("div");
    head.style.cssText = "font-weight:bold;margin-bottom:4px;";
    head.textContent = "This list may be incomplete";
    wrap.appendChild(head);
    const body = document.createElement("div");
    body.style.cssText = "font-size:12px;";
    body.textContent =
      "The application list was cut short: " +
      index.truncated +
      ". " +
      index.appPages +
      (index.appPages === 1 ? " page" : " pages") +
      " and " +
      index.activeApps +
      " applications were read, so anything past that point was not checked. " +
      "This result is not cached, so Refresh will try the list again.";
    wrap.appendChild(body);
    return wrap;
  }

  function failView(view, err) {
    if (view.loading && view.loading.parentNode) view.loading.remove();
    const p = parts();
    if (!p) return;
    setStatus("");
    const msg =
      err && err.status === 403
        ? "Your admin role cannot read the application catalogue, which this tab needs to find push groups."
        : "Could not load push groups. " + ((err && err.message) || "");
    view.notes.textContent = "";
    view.notes.appendChild(emptyState("Nothing to show", msg));
  }

  /* =========================================================================
     DIAGNOSE

     An app reaches the table by passing five gates, and when one of them drops
     it the result looks identical to an app with no push groups. This walks
     them in order against a named app and reports the first one that said no,
     so "why is Keeper not in the list" is a question with an answer instead of
     a guess.

       1 returned by /api/v1/apps at all      (role scope, or wrong name)
       2 status ACTIVE                        (the list query filters on it)
       3 passes includeApp                    (the features test)
       4 the mappings endpoint answers        (permissions, or no support)
       5 a mapping's sourceUserGroupId equals this group

     Gate 5 is the interesting one, because an app can hold push groups and
     still be absent from THIS group's table for the legitimate reason that it
     pushes other groups. The report lists what it does push, so that case is
     distinguishable from a bug.

     Searched with the apps endpoint's own q parameter and with no status
     filter, so an inactive app is found and reported as inactive rather than
     coming back as "no such app".
  ========================================================================= */
  function diagnose(query) {
    const q = String(query == null ? "" : query).trim();
    const groupId = host.groupIdFromPath();
    const controller = new AbortController();
    const signal = controller.signal;

    if (!q) return Promise.resolve({ error: "pass an app name, label, or id" });

    return getJSON(
      "/api/v1/apps?limit=50&q=" + encodeURIComponent(q),
      signal
    )
      .then(function (r) {
        const found = (r.json || []).filter(Boolean);
        if (!found.length) {
          const report = context(q, groupId);
          report.apps = [];
          report.verdict =
            "gate 1: no application matched this search. Either the name differs from what was searched, or your admin role cannot see it in /api/v1/apps.";
          logReport(report);
          return report;
        }
        return Promise.all(
          found.map(function (app) {
            return inspectApp(app, groupId, signal);
          })
        ).then(function (apps) {
          const report = context(q, groupId);
          report.apps = apps;
          report.verdict = apps
            .map(function (a) {
              return (a.label || a.name) + ": " + a.verdict;
            })
            .join(" | ");
          logReport(report);
          return report;
        });
      })
      .catch(function (err) {
        const report = context(q, groupId);
        report.error = err && err.message;
        report.status = err && err.status;
        logReport(report);
        return report;
      });
  }

  function context(q, groupId) {
    return {
      query: q,
      groupId: groupId,
      filterMode: FILTER_MODE,
      probeState: probe.state,
      indexComplete: index.complete,
      cache: _fromCacheAt
        ? "served from a record " + ago(Date.now() - _fromCacheAt)
        : "live",
    };
  }

  function inspectApp(app, groupId, signal) {
    const verdict = includeApp(app);
    const out = {
      id: app.id,
      name: app.name,
      label: app.label,
      status: app.status,
      signOnMode: app.signOnMode,
      features: app.features || [],
      gate2_active: app.status === "ACTIVE",
      gate3_included: verdict.ok,
      gate3_reason: verdict.why,
      gate3_advertisesGroupPush: verdict.advertises,
      inCurrentIndex: index.order.has(app.id),
    };

    if (!out.gate2_active) {
      out.verdict =
        "gate 2: status is " +
        app.status +
        ", and the app list is queried with a filter on ACTIVE, so it is never seen.";
      return Promise.resolve(out);
    }

    // Gate 4 and 5 are worth testing even when gate 3 excluded the app, since
    // a mapping found here is proof the filter is wrong rather than the app.
    return loadMappings(app.id, signal, null)
      .then(function (mappings) {
        out.gate4_mappingsRead = true;
        out.mappingCount = mappings.length;
        const mine = mappings.filter(function (m) {
          return m && m.sourceUserGroupId === groupId;
        });
        out.gate5_matchesThisGroup = mine.length;
        out.pushesThisGroupAs = mine.map(function (m) {
          return m.targetGroupName;
        });
        out.pushesOtherGroups = mappings
          .filter(function (m) {
            return m && m.sourceUserGroupId !== groupId;
          })
          .slice(0, 10)
          .map(function (m) {
            return m.sourceGroupName;
          });

        // Does a filtered query find what an unfiltered one did? A mismatch
        // here means the search fast path is the problem, not the filter.
        if (!mine.length || !fastPathReady()) return out;
        return loadGroupName(groupId, signal).then(function (name) {
          if (!name) return out;
          return loadMappings(app.id, signal, name).then(function (filtered) {
            out.filteredQueryName = name;
            out.filteredQueryMatches = filtered.filter(function (m) {
              return m && m.sourceUserGroupId === groupId;
            }).length;
            return out;
          });
        });
      })
      .catch(function (err) {
        if (isAbort(err)) throw err;
        out.gate4_mappingsRead = false;
        out.gate4_error = err.message;
        out.gate4_status = err.status;
        return out;
      })
      .then(function () {
        out.verdict = verdictFor(out);
        return out;
      });
  }

  function verdictFor(out) {
    if (out.gate4_mappingsRead === false) {
      if (out.gate4_status === 403) {
        return "gate 4: your admin role cannot read this app's push groups (403), so it is reported under \"could not be checked\" rather than shown.";
      }
      if (UNSUPPORTED_STATUS.indexOf(out.gate4_status) !== -1) {
        return "gate 4: the endpoint does not serve this app (" + out.gate4_status + "), so it has no push groups to show.";
      }
      return "gate 4: reading its push groups failed (" + out.gate4_error + ").";
    }
    if (!out.gate3_included && out.gate5_matchesThisGroup) {
      return (
        "gate 3 IS THE BUG: it pushes this group, but the filter excluded it because " +
        out.gate3_reason +
        ". Add its id to ALWAYS_CHECK, or set FILTER_MODE to all-active."
      );
    }
    if (!out.gate3_included) {
      return (
        "gate 3: excluded because " +
        out.gate3_reason +
        ", and it holds no mapping for this group either, so nothing is missing."
      );
    }
    if (!out.mappingCount) {
      return "gate 4: it supports group push but has no push groups configured at all.";
    }
    if (!out.gate5_matchesThisGroup) {
      return (
        "gate 5: it pushes " +
        out.mappingCount +
        " group(s), none of them this one. Correctly absent."
      );
    }
    if (
      out.filteredQueryMatches !== undefined &&
      out.filteredQueryMatches < out.gate5_matchesThisGroup
    ) {
      return (
        "SEARCH FAST PATH IS THE BUG: an unfiltered read finds " +
        out.gate5_matchesThisGroup +
        " mapping(s) for this group, a query by the group name finds " +
        out.filteredQueryMatches +
        ". Set SEARCH_MODE to off."
      );
    }
    if (!out.inCurrentIndex) {
      // Distinguish the two reasons an app can pass every gate and still be
      // missing, because the fixes are nothing alike.
      if (index.truncated) {
        return (
          "THE APP LIST WAS TRUNCATED: it passes every gate, but " +
          index.truncated +
          ", so it was never asked. This is a paging problem, not a stale cache."
        );
      }
      if (_fromCacheAt) {
        return (
          "it pushes this group and passes every gate, but the answer on screen came from a cached scan " +
          ago(Date.now() - _fromCacheAt) +
          " that predates it. Press Refresh."
        );
      }
      return (
        "it pushes this group and passes every gate, yet this page's own crawl of " +
        index.activeApps +
        " applications over " +
        index.appPages +
        " page(s) did not include it. Send this report on, since that should not happen."
      );
    }
    return (
      "passes every gate and pushes this group as " +
      (out.pushesThisGroupAs.join(", ") || "(unnamed)") +
      ". It should be in the table; if it is not, the view is stale, so press Refresh."
    );
  }

  /* What the last crawl decided about apps it did not ask. Shared by the
     console helper and the in-panel box below, so both report the same thing.
     ---------------------------------------------------------------------- */
  function coverage() {
    return {
      filterMode: FILTER_MODE,
      appPages: index.appPages,
      truncated: index.truncated,
      activeApps: index.activeApps,
      asked: index.apps.length,
      skipped: index.skipped,
      unsupported: index.unsupported,
      failures: index.failures.map(function (f) {
        return {
          id: f.app.id,
          label: f.app.label,
          status: f.error.status,
          error: f.error.message,
        };
      }),
    };
  }

  function logReport(report) {
    console.log("[orb] push groups diagnosis for " + JSON.stringify(report.query));
    console.log("  group in URL: " + report.groupId);
    console.log(
      "  filter mode: " + report.filterMode + ", search probe: " + report.probeState
    );
    console.log(
      "  index: " +
        (report.indexComplete ? "complete" : "partial") +
        ", " +
        report.cache
    );
    if (report.error) {
      console.log("  request failed: " + report.error);
      return;
    }
    if (!report.apps || !report.apps.length) {
      console.log("  " + report.verdict);
      return;
    }
    report.apps.forEach(function (a) {
      console.log("  --- " + (a.label || a.name) + " (" + a.id + ")");
      console.log("      " + a.verdict);
    });
    console.log("  full report returned as an object.");
  }

  /* =========================================================================
     INJECTION
  ========================================================================= */
  function tryInject() {
    const groupId = host.groupIdFromPath();
    if (!groupId) return; // the groups list, not a single group

    const n = nav();
    const c = content();
    if (!n || !c) return; // strip or panels not rendered yet

    if (!document.getElementById(PANEL_ID)) {
      c.appendChild(buildPanel());
      // A fresh panel means a fresh strip underneath us, so selection starts
      // over with Okta's own tab showing. The index survives, since it does
      // not belong to the group we just left.
      _active = false;
      _view = null;
    }

    if (!ourAnchor()) {
      const li = host.ui.createTab({
        id: TAB_ID,
        label: "Push Groups",
        title: "Applications this group is pushed to",
        className: MARK + "-tab",
        onClick: activate,
      });
      n.appendChild(li);
      // appendChild rather than ui.place, because place() applies a margin and
      // a tab's spacing belongs to the strip's own stylesheet.
      host.ui.addBadge(li);
    }

    bindNavClicks();
  }

  /* =========================================================================
     PUBLIC
  ========================================================================= */
  const api = {
    inject(h) {
      host = h || {};
      if (!host.ui || typeof host.ui.createTab !== "function") {
        console.warn(
          "[orb] push groups needs orbUI.createTab, which this orb-plugin.js does not have."
        );
        return;
      }
      tryInject();
      if (_observer) return; // mount can run again on SPA navigation
      _observer = new MutationObserver(tryInject);
      _observer.observe(document.body, { childList: true, subtree: true });
    },

    /* Handy from the console when testing.
         index()         the live reverse index, partial builds included
         scan()          discard it and rebuild fully, resolving when complete
         lookup(id)      the entries a group's rows are drawn from, defaulting
                         to the group in the URL
         abort()         cancel a build in flight
         probe()         re-measure searchString and report what it found,
                         which is the one call worth running by hand on a new
                         org. Resolves to { state, note, needle, measured } */
    index() {
      return index;
    },
    scan() {
      abortBuild();
      resetIndex();
      return buildIndex({ strategy: "full" });
    },
    lookup(groupId) {
      return index.byGroup.get(groupId || host.groupIdFromPath()) || [];
    },
    abort: abortBuild,
    /* cacheInfo()   where the index came from and how old it is
       clearCache()  drop the stored record, leaving memory alone */
    cacheInfo() {
      return {
        backend: store ? store.name : "none",
        key: CACHE_KEY,
        builtAt: _builtAt ? new Date(_builtAt).toISOString() : null,
        fromCache: _fromCacheAt != null,
        age: _fromCacheAt == null ? null : ago(Date.now() - _fromCacheAt),
        rechecked: [..._checkedAt.keys()],
        complete: index.complete,
        apps: index.apps.length,
        groups: index.byGroup.size,
      };
    },
    clearCache: clearCache,
    /* diagnose("Keeper") walks the five gates an app must pass to reach the
       table and names the one that dropped it. Logs a summary and resolves to
       the full report. */
    diagnose: diagnose,
    /* What the last crawl decided about apps it did not ask, which is where a
       missing app usually went. */
    coverage: coverage,
    probe() {
      probe.state = "unknown";
      probe.note = "";
      probe.needle = null;
      probe.measured = null;

      const controller = new AbortController();
      const apps = index.apps.length
        ? Promise.resolve(index.apps)
        : loadPushApps(controller.signal).then(function (list) {
            index.apps = list;
            index.order = new Map(
              list.map(function (a, i) {
                return [a.id, i];
              })
            );
            return list;
          });

      // _buildSeq unchanged, so the generation check inside probeOnce passes
      // and an unrelated build in flight is left alone.
      return apps
        .then(function () {
          return probeOnce(controller.signal, _buildSeq);
        })
        .then(function () {
          return {
            state: probe.state,
            note: probe.note,
            needle: probe.needle,
            measured: probe.measured,
            fastPathEnabled: fastPathReady(),
          };
        });
    },
  };

  if (typeof window !== "undefined") window.orbPushGroups = api;
})();
