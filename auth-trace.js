/* ===========================================================================
   auth-trace.js — "Auth Trace" for the Okta System Log

   Adds an Auth Trace button beside every DENY on a policy.evaluate_sign_on
   row at /report/system_log_2. Clicking it opens a popup that walks the
   authentication policy the attempt hit, rule by rule in priority order, and
   shows which rule caught the user and why the rules above it did not.

   WHY THE EVENT JSON COMES OUT OF THE DOM
   ---------------------------------------
   Each collapsed row in the log table is a <tr class="header-row">, and its
   NEXT SIBLING is a <tr class="details-row"> holding the whole event. The
   console renders that details row up front and merely hides it with
   display:none, so every value is queryable without expanding anything and
   without a second trip to /api/v1/logs. Values live on anchors as
   data-field="<json.path>" data-value="<value>", which is a better parsing
   surface than text: it survives label changes and localisation.

   The one wrinkle is repeated paths. An event has several Target blocks and
   several UserBehaviors blocks, and every one of them uses the same
   data-field. So anything repeated has to be read per-block, by walking the
   level-0 <li> children of ul.top-level and grouping on the block's own
   <span class="arrow" data-ref="..."> marker. Anything singular (client,
   device, event.securityContext.risk) can be queried off the whole row.

   WHAT A DENY ACTUALLY MEANS
   --------------------------
   Okta applies the FIRST rule whose conditions all match, so a DENY almost
   never means "a condition failed". It means one of three things, and the
   popup names which:

     1. The matched rule's action is DENY. Every condition in it matched, and
        that is the problem. Nothing failed.
     2. The matched rule allows access but the attempt could not satisfy
        actions.appSignOn.verificationMethod (factor, assurance, re-auth age).
     3. The matched rule is the policy's catch-all and it denies.

   So the useful reading is not "highlight the failed condition" but "show why
   each earlier rule was skipped, then show what the matched rule does".

   HONESTY ABOUT WHAT WE CANNOT EVALUATE
   -------------------------------------
   We re-derive rule matching from the event, which means some conditions are
   genuinely unknowable client-side: an Okta Expression Language condition, a
   user-type condition without a user fetch, a device assurance signal the
   event did not carry. Those render as "not evaluated" rather than being
   guessed at, and a rule whose skip reason is unknown says so. If our
   evaluation disagrees with Okta about the matched rule, the popup says that
   too, because a silent wrong answer here is worse than a visible gap.

   Load order: before orb-plugin.js, which mounts it.
=========================================================================== */
(function () {
  "use strict";

  const MARK = "orb-auth-trace";

  /* ---- Row selectors ----------------------------------------------------
     DENY_SEL is both the test and the insertion anchor: the button goes
     immediately after the DENY link inside its own .cell-text div.
     EVENT_TYPE_SEL is checked because a row can be DENY for event types that
     have no authentication policy behind them, and those get no button.
     Note the collapsed row uses data-field="eventType" while the details row
     uses "event.eventType" for the same value.
  --------------------------------------------------------------------- */
  const DENY_SEL =
    'td.event-info-col a[data-field="event.outcome.result"][data-value="DENY"]';
  const EVENT_TYPE_SEL = 'td.event-info-col a[data-field="eventType"]';
  const TRACED_EVENT_TYPE = "policy.evaluate_sign_on";

  // The alternateId that distinguishes an authentication policy rule target
  // from the other Rule targets in the same event (every event also carries
  // an "Authenticator Enrollment Policy" rule, which is not what we trace).
  const AUTH_POLICY_ALT_ID = "Authentication policy";

  const STATUS = {
    pass: { color: "#1b7f3b", label: "matched" },
    fail: { color: "#b00020", label: "did not match" },
    unknown: { color: "#8a6d00", label: "not evaluated" },
  };

  let host = null; // { getJSON, createPopup, ui }
  let observer = null;

  /* =========================================================================
     DOM READING
  ========================================================================= */

  // Read one data-field value out of a scope. Returns null when absent so
  // callers can tell "field missing" from "field present but empty", which
  // matters for device.managed on an unregistered device.
  function val(scope, field) {
    if (!scope) return null;
    const el = scope.querySelector('[data-field="' + field + '"]');
    if (!el) return null;
    if (el.dataset && typeof el.dataset.value === "string") return el.dataset.value;
    return el.textContent.trim();
  }

  function boolVal(scope, field) {
    const v = val(scope, field);
    if (v === "true") return true;
    if (v === "false") return false;
    return null; // absent or blank — unknown, not false
  }

  function allVals(scope, field) {
    if (!scope) return [];
    return Array.from(scope.querySelectorAll('[data-field="' + field + '"]'))
      .map((el) => (el.dataset ? el.dataset.value : "") || "")
      .filter(Boolean);
  }

  function detailsRowFor(headerRow) {
    const next = headerRow.nextElementSibling;
    return next && next.classList.contains("details-row") ? next : null;
  }

  // The level-0 blocks of a details row, filtered by their data-ref marker.
  // Used for anything the event repeats (target, and behaviours one level in).
  function blocks(detailsRow, ref) {
    const top = detailsRow && detailsRow.querySelector("ul.top-level");
    if (!top) return [];
    return Array.from(top.children).filter(function (li) {
      const arrow = li.querySelector(":scope > span.arrow");
      return arrow && arrow.dataset.ref === ref;
    });
  }

  function behaviours(detailsRow) {
    const out = {};
    if (!detailsRow) return out;
    const nodes = detailsRow.querySelectorAll(
      'li.attribute-detail > span.arrow[data-ref="event.securityContext.userBehaviors"]'
    );
    nodes.forEach(function (arrow) {
      const li = arrow.parentElement;
      const name = val(li, "event.securityContext.userBehaviors.name");
      const result = val(li, "event.securityContext.userBehaviors.result");
      if (name) out[name] = result;
    });
    return out;
  }

  /* Build the evaluation context from one row's details.
     Returns null when the row is not an authentication policy denial, which
     is how tryInject decides whether to add a button at all. ------------- */
  function parseEvent(headerRow) {
    const details = detailsRowFor(headerRow);
    if (!details) return null;

    let policy = null;
    let matchedRule = null;
    let app = null;

    blocks(details, "target").forEach(function (li) {
      const type = val(li, "target.type");
      const altId = val(li, "target.alternateId");

      if (type === "AppInstance") {
        app = {
          id: val(li, "target.id"),
          name: val(li, "target.displayName"),
          signOnMode: val(li, "target.detailEntry.signOnModeType"),
          result: val(li, "target.detailEntry.signOnModeEvaluationResult"),
        };
        return;
      }

      if (type === "Rule" && altId === AUTH_POLICY_ALT_ID) {
        policy = {
          id: val(li, "target.detailEntry.policyId"),
          name: val(li, "target.detailEntry.policyName"),
        };
        const priority = val(li, "target.detailEntry.policyRulePriority");
        matchedRule = {
          id: val(li, "target.id"),
          name: val(li, "target.displayName"),
          priority: priority === null ? null : Number(priority),
        };
      }
    });

    if (!policy || !matchedRule) return null;

    return {
      published: val(details, "event.published"),
      actor: {
        id: val(details, "actor.id"),
        login: val(details, "actor.alternateId"),
        name: val(details, "actor.displayName"),
      },
      app: app,
      policy: policy,
      matchedRule: matchedRule,
      client: {
        ip: val(details, "client.ipAddress"),
        zone: val(details, "client.zone"),
        deviceKind: val(details, "client.device"), // Computer | Mobile | Unknown
        os: val(details, "client.userAgent.os"),
        browser: val(details, "client.userAgent.browser"),
        city: val(details, "client.geographicalContext.city"),
        country: val(details, "client.geographicalContext.country"),
      },
      device: {
        id: val(details, "device.id"),
        name: val(details, "device.name"),
        managed: boolVal(details, "device.managed"),
        registered: boolVal(details, "device.registered"),
        platform: val(details, "device.os_platform"),
        osVersion: val(details, "device.os_version"),
        diskEncryption: val(details, "device.disk_encryption_type"),
        screenLock: val(details, "device.screen_lock_type"),
        secureHardware: boolVal(details, "device.secure_hardware_present"),
        jailbreak: boolVal(details, "device.jailbreak"),
      },
      risk: {
        level: val(details, "event.securityContext.risk.level"),
        reasons: allVals(details, "event.securityContext.risk.reasons"),
      },
      behaviours: behaviours(details),
      ipCategories: allVals(
        details,
        "event.securityContext.ipDetails.ipServiceCategories.type"
      ),
      isProxy: boolVal(details, "event.securityContext.isProxy"),
      proxies: allVals(details, "event.system.debugContext.debugData.associatedProxies"),
    };
  }

  /* =========================================================================
     LOOKUPS

     Each cache holds the PROMISE, so two quick clicks share one request. A
     failure clears its own cache entry and resolves to null, so the trace
     degrades to "not evaluated" for that condition instead of throwing.
  ========================================================================= */
  const cache = { rules: {}, groups: {}, zones: null, assurances: null };

  function fetchOnce(store, key, path, label) {
    const box = key === null ? cache : store;
    const slot = key === null ? label : key;
    if (box[slot]) return box[slot];
    box[slot] = host
      .getJSON(path)
      .catch(function (err) {
        box[slot] = null;
        console.warn("[orb] auth-trace " + label + " lookup failed:", err && err.message);
        return null;
      });
    return box[slot];
  }

  function loadRules(policyId) {
    return fetchOnce(
      cache.rules,
      policyId,
      "/api/v1/policies/" + encodeURIComponent(policyId) + "/rules",
      "policy rules"
    );
  }

  function loadGroups(userId) {
    return fetchOnce(
      cache.groups,
      userId,
      "/api/v1/users/" + encodeURIComponent(userId) + "/groups",
      "user groups"
    );
  }

  function loadZones() {
    if (cache.zones) return cache.zones;
    cache.zones = host.getJSON("/api/v1/zones?limit=200").catch(function (err) {
      cache.zones = null;
      console.warn("[orb] auth-trace zone lookup failed:", err && err.message);
      return null;
    });
    return cache.zones;
  }

  function loadAssurances() {
    if (cache.assurances) return cache.assurances;
    cache.assurances = host
      .getJSON("/api/v1/device-assurances")
      .catch(function (err) {
        cache.assurances = null;
        console.warn(
          "[orb] auth-trace device assurance lookup failed:",
          err && err.message
        );
        return null;
      });
    return cache.assurances;
  }

  /* =========================================================================
     CONDITION EVALUATION

     Every handler returns { label, expected, observed, status } where status
     is a STATUS key. A handler that cannot decide returns "unknown" with a
     plain-English note in observed — never a guess dressed as a verdict.

     Each handler is keyed by its conditions.<key>. An unrecognised key still
     renders, as "not evaluated", with its raw JSON, so a condition type we
     have not taught the evaluator is visible rather than silently dropped.
  ========================================================================= */

  function row(label, expected, observed, status) {
    return { label: label, expected: expected, observed: observed, status: status };
  }

  function nameList(ids, index, kind) {
    if (!ids || !ids.length) return "none";
    return ids
      .map(function (id) {
        return (index && index[id]) || kind + " " + id;
      })
      .join(", ");
  }

  const handlers = {
    /* People — group and user membership. Needs the actor's groups, so this
       is the one handler that depends on a per-user fetch. */
    people: function (cond, ctx, refs) {
      const out = [];
      const groups = cond.groups || {};
      const users = cond.users || {};

      if (groups.include || groups.exclude) {
        if (!refs.groupIds) {
          out.push(
            row(
              "Group membership",
              nameList(groups.include, refs.groupNames, "group"),
              "Group list unavailable, so membership was not checked",
              "unknown"
            )
          );
        } else {
          if (groups.include && groups.include.length) {
            const hit = groups.include.filter(function (id) {
              return refs.groupIds[id];
            });
            out.push(
              row(
                "In group",
                nameList(groups.include, refs.groupNames, "group"),
                hit.length
                  ? "in " + nameList(hit, refs.groupNames, "group")
                  : "in none of them",
                hit.length ? "pass" : "fail"
              )
            );
          }
          if (groups.exclude && groups.exclude.length) {
            const bad = groups.exclude.filter(function (id) {
              return refs.groupIds[id];
            });
            out.push(
              row(
                "Not in group",
                nameList(groups.exclude, refs.groupNames, "group"),
                bad.length
                  ? "in " + nameList(bad, refs.groupNames, "group")
                  : "in none of them",
                bad.length ? "fail" : "pass"
              )
            );
          }
        }
      }

      if (users.include && users.include.length) {
        const hit = users.include.indexOf(ctx.actor.id) !== -1;
        out.push(
          row("Specific users", users.include.length + " user(s)", hit ? "listed" : "not listed", hit ? "pass" : "fail")
        );
      }
      if (users.exclude && users.exclude.length) {
        const hit = users.exclude.indexOf(ctx.actor.id) !== -1;
        out.push(
          row("Excluded users", users.exclude.length + " user(s)", hit ? "listed" : "not listed", hit ? "fail" : "pass")
        );
      }
      return out;
    },

    /* Network — zone membership. The event gives ONE resolved zone name in
       client.zone, but an IP can sit in several zones, so a name mismatch is
       suggestive rather than conclusive. A miss is reported as unknown, not
       fail, to avoid inventing a skip reason. A hit is safe to call a pass. */
    network: function (cond, ctx, refs) {
      const connection = cond.connection || "ANYWHERE";
      if (connection === "ANYWHERE") {
        return [row("Network", "anywhere", ctx.client.ip || "any IP", "pass")];
      }

      const zoneNames = refs.zoneNames;
      const observed = ctx.client.zone && ctx.client.zone !== "null"
        ? ctx.client.zone
        : "no zone on the event";

      if (!zoneNames) {
        return [
          row(
            "Network zone",
            connection.toLowerCase() + " " + (cond.include || cond.exclude || []).length + " zone(s)",
            "Zone list unavailable, so the zone was not checked",
            "unknown"
          ),
        ];
      }

      const include = cond.include || [];
      const exclude = cond.exclude || [];

      if (include.length) {
        const wanted = include.map(function (id) {
          return zoneNames[id] || id;
        });
        const hit = wanted.indexOf(ctx.client.zone) !== -1;
        return [
          row(
            "In network zone",
            wanted.join(", "),
            observed,
            hit ? "pass" : "unknown"
          ),
        ];
      }
      if (exclude.length) {
        const unwanted = exclude.map(function (id) {
          return zoneNames[id] || id;
        });
        const hit = unwanted.indexOf(ctx.client.zone) !== -1;
        return [
          row("Not in network zone", unwanted.join(", "), observed, hit ? "fail" : "unknown"),
        ];
      }
      return [row("Network", connection.toLowerCase(), observed, "unknown")];
    },

    /* Platform — device type and OS. Maps the rule's DESKTOP/MOBILE against
       client.device, and its os.type against device.os_platform. A version
       expression is shown but not parsed. */
    platform: function (cond, ctx) {
      const include = cond.include || [];
      if (!include.length) return [row("Platform", "any", "any", "pass")];

      const kindMap = { Computer: "DESKTOP", Mobile: "MOBILE" };
      const observedKind = kindMap[ctx.client.deviceKind] || null;
      const observedOs = ctx.device.platform || null;
      const observed =
        (ctx.client.deviceKind || "unknown device type") +
        (observedOs ? " / " + observedOs : "") +
        (ctx.device.osVersion ? " " + ctx.device.osVersion : "");

      let anyExpression = false;
      const matched = include.some(function (entry) {
        const os = entry.os || {};
        if (os.expression) anyExpression = true;
        const kindOk =
          !entry.type || entry.type === "ANY" || entry.type === observedKind;
        const osOk = !os.type || os.type === "ANY" || os.type === observedOs;
        return kindOk && osOk;
      });

      const expected = include
        .map(function (entry) {
          const os = entry.os || {};
          return (
            (entry.type || "ANY") +
            (os.type && os.type !== "ANY" ? " / " + os.type : "") +
            (os.expression ? " " + os.expression : "")
          );
        })
        .join(", ");

      if (!observedKind && !observedOs) {
        return [row("Platform", expected, "no platform on the event", "unknown")];
      }
      return [
        row(
          "Platform",
          expected,
          observed,
          matched ? (anyExpression ? "unknown" : "pass") : "fail"
        ),
      ];
    },

    /* Device — managed, registered, and device assurance. Assurance is only
       partly checkable from the event, so it reports what it could compare
       and stays unknown when a signal is missing. */
    device: function (cond, ctx, refs) {
      const out = [];

      if (typeof cond.managed === "boolean") {
        const observed = ctx.device.managed;
        out.push(
          row(
            "Device managed",
            String(cond.managed),
            observed === null ? "not reported" : String(observed),
            observed === null ? "unknown" : observed === cond.managed ? "pass" : "fail"
          )
        );
      }
      if (typeof cond.registered === "boolean") {
        const observed = ctx.device.registered;
        out.push(
          row(
            "Device registered",
            String(cond.registered),
            observed === null ? "not reported" : String(observed),
            observed === null
              ? "unknown"
              : observed === cond.registered
              ? "pass"
              : "fail"
          )
        );
      }

      const assurance = cond.assurance || {};
      const ids = assurance.include || [];
      if (ids.length) {
        const names = refs.assuranceNames;
        out.push(
          row(
            "Device assurance",
            names ? nameList(ids, names, "assurance policy") : ids.length + " policy(ies)",
            describeAssuranceSignals(ctx),
            "unknown"
          )
        );
      }
      return out;
    },

    /* Risk level. Okta treats ANY as a wildcard; otherwise the rule applies
       at the configured level. */
    riskScore: function (cond, ctx) {
      const want = cond.level || "ANY";
      const observed = ctx.risk.level || "not reported";
      if (want === "ANY") return [row("Risk", "any", observed, "pass")];
      if (!ctx.risk.level) return [row("Risk", want, "not reported", "unknown")];
      return [
        row(
          "Risk",
          want,
          observed + (ctx.risk.reasons.length ? " (" + ctx.risk.reasons.join(", ") + ")" : ""),
          want === ctx.risk.level ? "pass" : "fail"
        ),
      ];
    },

    risk: function (cond, ctx) {
      const names = (cond.behaviors && cond.behaviors.include) || [];
      if (!names.length) return [];
      const hits = names.filter(function (n) {
        return ctx.behaviours[n] === "POSITIVE";
      });
      return [
        row(
          "Behaviour detected",
          names.join(", "),
          hits.length ? hits.join(", ") + " positive" : "none positive",
          hits.length ? "pass" : "fail"
        ),
      ];
    },

    /* Okta Expression Language. Not evaluable here — shown verbatim so an
       admin can read it, and flagged as the reason a verdict may be partial.
       (ORB's OEL Preview evaluates group-rule expressions against users, a
       different context, so it is deliberately not reused.) */
    elCondition: function (cond) {
      return [
        row(
          "Expression",
          cond.condition || "(empty)",
          "Expressions are not evaluated by Auth Trace",
          "unknown"
        ),
      ];
    },

    userType: function (cond) {
      const ids = (cond.include || []).concat(cond.exclude || []);
      if (!ids.length) return [];
      return [
        row(
          "User type",
          ids.length + " type(s)",
          "User type is not on the event, so it was not checked",
          "unknown"
        ),
      ];
    },
  };

  function describeAssuranceSignals(ctx) {
    const bits = [];
    if (ctx.device.osVersion) bits.push("OS " + ctx.device.osVersion);
    if (ctx.device.diskEncryption) bits.push("disk " + ctx.device.diskEncryption);
    if (ctx.device.screenLock) bits.push("lock " + ctx.device.screenLock);
    if (ctx.device.secureHardware !== null)
      bits.push("secure hardware " + ctx.device.secureHardware);
    if (ctx.device.jailbreak !== null) bits.push("jailbroken " + ctx.device.jailbreak);
    return bits.length
      ? "Signals on the event: " + bits.join(", ")
      : "No device signals on the event";
  }

  // Conditions we know are informational rather than gating, or that Okta
  // stores alongside the real ones. Kept out of the "unrecognised" bucket so
  // the table is not noisy.
  const IGNORED_CONDITIONS = { app: 1, apps: 1, clients: 1, accessType: 1 };

  function evaluateRule(rule, ctx, refs) {
    const conditions = rule.conditions || {};
    let rows = [];

    Object.keys(conditions).forEach(function (key) {
      const cond = conditions[key];
      if (cond === null || IGNORED_CONDITIONS[key]) return;
      const handler = handlers[key];
      if (handler) {
        rows = rows.concat(handler(cond, ctx, refs) || []);
        return;
      }
      rows.push(
        row(key, JSON.stringify(cond), "This condition type is not evaluated", "unknown")
      );
    });

    if (!rows.length) {
      rows.push(row("Conditions", "none", "Applies to every attempt", "pass"));
    }

    const failed = rows.filter(function (r) {
      return r.status === "fail";
    });
    const unknown = rows.filter(function (r) {
      return r.status === "unknown";
    });

    return {
      rows: rows,
      failed: failed,
      verdict: failed.length ? "skipped" : unknown.length ? "possible" : "match",
    };
  }

  /* =========================================================================
     ACTION READING — what the matched rule actually does
  ========================================================================= */
  function describeAction(rule) {
    const appSignOn = (rule.actions && rule.actions.appSignOn) || {};
    const access = appSignOn.access || "UNKNOWN";
    const vm = appSignOn.verificationMethod || {};

    if (access === "DENY") {
      return {
        access: "DENY",
        summary: "This rule denies access if conditions are matched.",
        detail:
          "Every condition in it matched the attempt, so Okta Denied as intended. " +
          "No rules below were evaluated.",
        requirements: [],
      };
    }

    const requirements = [];
    if (vm.factorMode) requirements.push("Factor mode: " + vm.factorMode);
    if (vm.type) requirements.push("Type: " + vm.type);
    if (typeof vm.reauthenticateIn === "string")
      requirements.push("Re-authenticate every " + vm.reauthenticateIn);
    (vm.constraints || []).forEach(function (c, i) {
      requirements.push("Constraint " + (i + 1) + ": " + JSON.stringify(c));
    });

    return {
      access: access,
      summary: "This rule allows access, but only with additional assurance.",
      detail:
        "The deny therefore came from the attempt failing to satisfy the " +
        "requirements below, not from a condition. Compare them against what " +
        "the user could present.",
      requirements: requirements,
    };
  }

  /* =========================================================================
     TRACE ASSEMBLY
  ========================================================================= */
  function buildTrace(ctx) {
    return loadRules(ctx.policy.id).then(function (rules) {
      const needs = { people: false, network: false, assurance: false };
      (rules || []).forEach(function (rule) {
        const c = rule.conditions || {};
        if (c.people) needs.people = true;
        if (c.network && c.network.connection && c.network.connection !== "ANYWHERE")
          needs.network = true;
        if (c.device && c.device.assurance) needs.assurance = true;
      });

      return Promise.all([
        needs.people && ctx.actor.id ? loadGroups(ctx.actor.id) : null,
        needs.network ? loadZones() : null,
        needs.assurance ? loadAssurances() : null,
      ]).then(function (results) {
        const refs = { groupIds: null, groupNames: null, zoneNames: null, assuranceNames: null };

        if (results[0]) {
          refs.groupIds = {};
          refs.groupNames = {};
          results[0].forEach(function (g) {
            refs.groupIds[g.id] = true;
            refs.groupNames[g.id] = (g.profile && g.profile.name) || g.id;
          });
          // A group the user is NOT in still needs a readable name in the
          // expected column, and the memberships call cannot supply one. The
          // id shows through in that case, which is honest and still useful.
        }
        if (results[1]) {
          refs.zoneNames = {};
          results[1].forEach(function (z) {
            refs.zoneNames[z.id] = z.name || z.id;
          });
        }
        if (results[2]) {
          refs.assuranceNames = {};
          results[2].forEach(function (a) {
            refs.assuranceNames[a.id] = a.name || a.id;
          });
        }

        if (!rules) {
          return { ctx: ctx, rules: null, refs: refs };
        }

        const sorted = rules.slice().sort(function (a, b) {
          return (a.priority || 0) - (b.priority || 0);
        });
        const matchedIndex = sorted.findIndex(function (r) {
          return r.id === ctx.matchedRule.id;
        });

        const walked = sorted.map(function (rule, i) {
          const evaluated = evaluateRule(rule, ctx, refs);
          let position;
          if (matchedIndex === -1) position = "unranked";
          else if (i < matchedIndex) position = "before";
          else if (i === matchedIndex) position = "matched";
          else position = "after";
          return {
            rule: rule,
            position: position,
            // A deactivated rule sits in the list at its priority but is
            // never evaluated, so its conditions explain nothing about why
            // the attempt was skipped past it. Tracked separately from
            // position because the two are independent: an inactive rule can
            // appear above or below the match.
            inactive: rule.status ? rule.status !== "ACTIVE" : false,
            evaluated: evaluated,
            action: describeAction(rule),
          };
        });

        return { ctx: ctx, rules: walked, matchedIndex: matchedIndex, refs: refs };
      });
    });
  }

  /* =========================================================================
     RENDERING

     Plain DOM with inline styles, matching createPopup's 13px system stack.
     No Okta classes are borrowed here: the popup is our own surface, and
     borrowing console classes for a table would tie it to their markup.
  ========================================================================= */
  function el(tag, style, text) {
    const node = document.createElement(tag);
    if (style) node.style.cssText = style;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function badge(status) {
    const s = STATUS[status] || STATUS.unknown;
    const wrap = el("span", "color:" + s.color + ";white-space:nowrap;");
    wrap.appendChild(el("span", "font-size:15px;line-height:1;", "\u2022"));
    wrap.appendChild(el("span", "margin-left:4px;", s.label));
    return wrap;
  }

  function summaryLine(label, value) {
    const line = el("div", "display:flex;gap:8px;margin:2px 0;");
    line.appendChild(el("span", "color:#666;min-width:120px;", label));
    line.appendChild(el("span", "", value || "—"));
    return line;
  }

  function conditionTable(rows) {
    const table = el("table", "border-collapse:collapse;width:100%;margin:6px 0 0;");
    const head = el("tr", "");
    ["Condition", "Rule requires", "This attempt", ""].forEach(function (h) {
      head.appendChild(
        el(
          "th",
          "text-align:left;font-weight:600;color:#666;border-bottom:1px solid #e5e5e5;padding:4px 8px 4px 0;",
          h
        )
      );
    });
    table.appendChild(head);

    rows.forEach(function (r) {
      const tr = el("tr", "");
      tr.appendChild(
        el("td", "padding:4px 8px 4px 0;vertical-align:top;border-bottom:1px solid #f2f2f2;", r.label)
      );
      tr.appendChild(
        el(
          "td",
          "padding:4px 8px 4px 0;vertical-align:top;border-bottom:1px solid #f2f2f2;word-break:break-word;",
          r.expected
        )
      );
      tr.appendChild(
        el(
          "td",
          "padding:4px 8px 4px 0;vertical-align:top;border-bottom:1px solid #f2f2f2;word-break:break-word;",
          r.observed
        )
      );
      const statusCell = el(
        "td",
        "padding:4px 0;vertical-align:top;border-bottom:1px solid #f2f2f2;"
      );
      statusCell.appendChild(badge(r.status));
      tr.appendChild(statusCell);
      table.appendChild(tr);
    });
    return table;
  }

  /* The rule's action, as a filled pill. Reuses the same red and green the
     condition badges use, so a rule header and its rows agree on colour.
     UNKNOWN only appears when a rule has no actions.appSignOn block at all,
     which would be a malformed rule — grey rather than a guessed verdict. */
  function accessPill(access) {
    const look =
      access === "DENY"
        ? { bg: "#b00020", text: "Deny" }
        : access === "ALLOW"
        ? { bg: "#1b7f3b", text: "Allow" }
        : { bg: "#777", text: "Unknown" };

    return el(
      "span",
      "background:" +
        look.bg +
        ";color:#fff;font-weight:700;border-radius:3px;padding:2px 8px;" +
        "line-height:1.4;white-space:nowrap;",
      look.text
    );
  }

  /* "Inactive" sits in front of the Allow/Deny pill as an outlined label
     rather than a second filled pill. Two filled pills side by side read as
     two verdicts of equal weight, and this one is a modifier on the other:
     the rule still says Deny, it just never gets asked. */
  function inactivePill() {
    return el(
      "span",
      "border:1px solid #999;color:#777;font-weight:600;border-radius:3px;" +
        "padding:1px 7px;line-height:1.4;white-space:nowrap;",
      "Inactive"
    );
  }

  function positionNote(entry, ctx) {
    const ev = entry.evaluated;

    /* Checked before everything else. An inactive rule is out of the
       evaluation entirely, so any skip reason computed from its conditions
       would be an invented explanation — including the "every condition
       looks matched, worth a closer read" warning, which would send an admin
       hunting for a problem that is just a switched-off rule. */
    if (entry.inactive) {
      return {
        text:
          "This rule is turned off, so Okta never evaluated it. Its conditions below are shown for reference only.",
        color: "#999",
      };
    }

    if (entry.position === "matched") {
      if (ev.failed.length) {
        return {
          text:
            "Okta matched this rule, but Auth Trace read " +
            ev.failed.length +
            " condition as unmatched. This could be due to a Policy change since this log event, or a gap in this tool. Trust Okta here.",
          color: "#8a6d00",
        };
      }
      return { text: "Okta matched this rule.", color: "#1b7f3b" };
    }
    if (entry.position === "before") {
      if (ev.failed.length) {
        return {
          text: "Skipped: " + ev.failed[0].label + " did not match.",
          color: "#666",
        };
      }
      if (ev.verdict === "possible") {
        return {
          text:
            "Skipped by Okta. Auth Trace could not confirm why, could be due to a rule that is currently turned off.",
          color: "#8a6d00",
        };
      }
      return {
        text:
          "Skipped by Okta, but every condition looks matched from the event. Worth a closer read.",
        color: "#8a6d00",
      };
    }
    if (entry.position === "after") {
      return {
        text: "Never reached. Rule " + ctx.matchedRule.priority + " matched first.",
        color: "#999",
      };
    }
    return { text: "Priority unknown.", color: "#999" };
  }

  function ruleCard(entry, ctx) {
    const isMatched = entry.position === "matched";
    const card = el(
      "div",
      "border:1px solid " +
        (isMatched ? "#b00020" : "#e5e5e5") +
        ";border-radius:5px;margin:8px 0;overflow:hidden;" +
        // Everything that is not the match fades back, above and below
        // alike. The matched rule is the answer to the question; the rest is
        // the reasoning, and it should read that way at a glance.
        (isMatched ? "" : "opacity:0.65;")
    );

    const header = el(
      "div",
      "display:flex;align-items:baseline;gap:10px;padding:8px 10px;cursor:pointer;" +
        "background:" +
        (isMatched ? "#fdf3f4" : "#fafafa") +
        ";"
    );
    header.appendChild(
      el("span", "color:#666;min-width:52px;", "Priority " + (entry.rule.priority != null ? entry.rule.priority : "?"))
    );
    header.appendChild(el("span", "font-weight:600;flex:1;", entry.rule.name || entry.rule.id));

    if (entry.inactive) header.appendChild(inactivePill());

    const access = entry.action.access;
    header.appendChild(accessPill(access));

    const note = positionNote(entry, ctx);
    const body = el("div", "padding:8px 10px;" + (isMatched ? "" : "display:none;"));
    body.appendChild(el("div", "color:" + note.color + ";margin-bottom:6px;", note.text));

    if (isMatched) {
      body.appendChild(el("div", "font-weight:600;margin-top:8px;", entry.action.summary));
      body.appendChild(el("div", "color:#444;margin:2px 0 6px;", entry.action.detail));
      if (entry.action.requirements.length) {
        const ul = el("ul", "margin:4px 0 8px 18px;padding:0;");
        entry.action.requirements.forEach(function (r) {
          ul.appendChild(el("li", "margin:2px 0;", r));
        });
        body.appendChild(ul);
      }
    }

    body.appendChild(conditionTable(entry.evaluated.rows));

    header.addEventListener("click", function () {
      body.style.display = body.style.display === "none" ? "" : "none";
    });

    card.appendChild(header);
    card.appendChild(body);
    return card;
  }

  function render(container, trace) {
    const ctx = trace.ctx;
    container.textContent = "";

    /* ---- Summary ---- */
    const summary = el("div", "margin-bottom:12px;");
    summary.appendChild(summaryLine("User", (ctx.actor.name || "") + " (" + (ctx.actor.login || "") + ")"));
    summary.appendChild(summaryLine("Application", ctx.app ? ctx.app.name : null));
    summary.appendChild(summaryLine("Policy", ctx.policy.name));
    summary.appendChild(
      summaryLine(
        "Rule hit",
        ctx.matchedRule.name + " (priority " + ctx.matchedRule.priority + ")"
      )
    );
    summary.appendChild(summaryLine("When", ctx.published));
    container.appendChild(summary);

    /* ---- Attempt context: the signals the evaluation ran against ---- */
    const context = el(
      "div",
      "background:#f7f7f7;border-radius:5px;padding:8px 10px;margin-bottom:12px;"
    );
    context.appendChild(el("div", "font-weight:600;margin-bottom:4px;", "What Okta saw"));
    const grid = el(
      "div",
      "display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px 16px;"
    );
    const facts = [
      ["IP", (ctx.client.ip || "—") + (ctx.client.zone && ctx.client.zone !== "null" ? " in " + ctx.client.zone : " (no zone)")],
      ["Location", [ctx.client.city, ctx.client.country].filter(Boolean).join(", ")],
      ["Client", [ctx.client.browser, ctx.client.os, ctx.client.deviceKind].filter(Boolean).join(" / ")],
      ["Device", ctx.device.name ? ctx.device.name + " (" + ctx.device.platform + " " + ctx.device.osVersion + ")" : "no registered device"],
      ["Managed", ctx.device.managed === null ? "not reported" : String(ctx.device.managed)],
      ["Registered", ctx.device.registered === null ? "not reported" : String(ctx.device.registered)],
      ["Risk", (ctx.risk.level || "—") + (ctx.risk.reasons.length ? " (" + ctx.risk.reasons.join(", ") + ")" : "")],
      ["Behaviours", positiveBehaviours(ctx)],
    ];
    if (ctx.ipCategories.length) facts.push(["IP category", ctx.ipCategories.join(", ")]);
    if (ctx.proxies.length) facts.push(["Known proxies", ctx.proxies.join(", ")]);
    facts.forEach(function (f) {
      grid.appendChild(summaryLine(f[0], f[1]));
    });
    context.appendChild(grid);
    container.appendChild(context);

    /* ---- Rule walk ---- */
    if (!trace.rules) {
      const warn = el(
        "div",
        "border:1px solid #f0d000;background:#fffbe6;border-radius:5px;padding:8px 10px;"
      );
      warn.appendChild(
        el(
          "div",
          "font-weight:600;",
          "Could not read the policy's rules"
        )
      );
      warn.appendChild(
        el(
          "div",
          "color:#444;margin-top:2px;",
          "The trace above comes from the log event alone. Reading the full rule list needs an admin role with policy read access. " +
            "The rule that caught this attempt is named in the summary."
        )
      );
      container.appendChild(warn);
      return;
    }

    container.appendChild(
      el(
        "div",
        "font-weight:600;margin-bottom:2px;",
        "Rules in " + ctx.policy.name + ", in the order Okta evaluated them"
      )
    );
    container.appendChild(
      el(
        "div",
        "color:#666;margin-bottom:4px;",
        "Okta applies the first rule whose conditions all match. Click a rule to see its conditions."
      )
    );

    trace.rules.forEach(function (entry) {
      container.appendChild(ruleCard(entry, ctx));
    });

    if (trace.matchedIndex === -1) {
      container.appendChild(
        el(
          "div",
          "color:#8a6d00;margin-top:8px;",
          "The rule named in the event is not in the policy's current rule list. It was probably renamed or deleted after this attempt."
        )
      );
    }
  }

  function positiveBehaviours(ctx) {
    const positive = Object.keys(ctx.behaviours).filter(function (k) {
      return ctx.behaviours[k] === "POSITIVE";
    });
    if (!positive.length) return "none flagged";
    return positive.join(", ");
  }

  /* =========================================================================
     BUTTON INJECTION

     The system log table swaps rows on scroll, filter, and auto-refresh, so
     this runs under a MutationObserver like the rest of ORB. Every row is
     marked once, and the mark lives on the cell rather than a module-level
     set so a recycled row cannot inherit a stale button.
  ========================================================================= */
  /* Okta's own .link-button colour, measured rather than hard-coded.

     The log table styles anchors inside a cell (.cell-text a) to the muted
     grey the Actor and IP links use, and that rule beats the .link-button
     class our button borrows. So the button renders grey and only turns blue
     on hover, when Okta's hover rule takes over.

     An inline style beats both, but guessing a hex risks drifting from the
     blue every other ORB button uses. Instead: drop a probe anchor carrying
     the same class directly on body, OUTSIDE the table so the cell rule
     cannot reach it, and read back whatever colour Okta gives it. Measured
     once per page. Fixed inline colour also means no hover flicker, since
     inline wins over the hover rule too.
     ------------------------------------------------------------------- */
  let linkColor = null;

  function oktaLinkColor() {
    if (linkColor) return linkColor;
    const probe = document.createElement("a");
    probe.className = "link-button";
    probe.href = "#";
    probe.textContent = "probe";
    probe.style.cssText = "position:absolute;left:-9999px;top:0;";
    document.body.appendChild(probe);
    const measured = getComputedStyle(probe).color;
    probe.remove();
    // Transparent or empty means the class did not resolve, so fall back to
    // the admin console's link blue.
    linkColor =
      measured && measured !== "rgba(0, 0, 0, 0)" ? measured : "#1662dd";
    return linkColor;
  }

  /* The log table turns any click inside a row into a search filter, built
     from the clicked element's data-field and data-value. Our button carries
     neither, so the handler built `undefined eq "undefined"` and navigated,
     reloading the page out from under the popup.

     orbUI.createButton already calls preventDefault for anchor variants,
     which kills the href but not the bubble, and the table's handler is
     delegated above the cell. Stopping propagation at the button is what
     actually keeps the click ours. stopImmediatePropagation covers the case
     where Okta binds a second handler on the same node.
     ------------------------------------------------------------------- */
  function keepClick(e) {
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }

  function openTrace(ctx) {
    const popup = host.createPopup("Auth Trace");
    const container = popup.appendChild(document.createElement("div"));
    container.style.cssText = "min-width:760px;max-width:940px;";
    container.textContent = "Reading " + ctx.policy.name + "\u2026";

    buildTrace(ctx)
      .then(function (trace) {
        render(container, trace);
      })
      .catch(function (err) {
        container.textContent = "";
        container.appendChild(
          el("div", "color:#b00020;", "Auth Trace failed: " + (err && err.message))
        );
        console.error("[orb] auth-trace failed:", err);
      });
  }

  function tryInject() {
    document.querySelectorAll(DENY_SEL).forEach(function (denyLink) {
      const cell = denyLink.closest("div.cell-text");
      if (!cell || cell.querySelector("." + MARK)) return;

      const headerRow = denyLink.closest("tr.header-row");
      if (!headerRow) return;

      const typeLink = headerRow.querySelector(EVENT_TYPE_SEL);
      if (!typeLink || typeLink.dataset.value !== TRACED_EVENT_TYPE) return;

      const ctx = parseEvent(headerRow);
      if (!ctx) return; // no authentication policy behind this denial

      const btn = host.ui.createButton({
        label: "Auth Trace",
        title: "Show which policy rule denied this sign-on",
        variant: "toolbar",
        className: MARK,
        onClick: function (e) {
          keepClick(e);
          openTrace(ctx);
        },
      });
      host.ui.place(btn, { parent: cell, margin: "0 0 0 8px" });

      // Applied after place(), because place() is what puts the button in the
      // document and therefore under the cell's anchor rule.
      btn.style.color = oktaLinkColor();
      btn.style.textDecoration = "none";
    });
  }

  function inject(hostSurface) {
    host = hostSurface;
    tryInject();
    if (observer) return; // start() can run again on SPA navigation
    observer = new MutationObserver(tryInject);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (typeof window !== "undefined") {
    window.orbAuthTrace = { inject: inject, parseEvent: parseEvent };
  }
})();
