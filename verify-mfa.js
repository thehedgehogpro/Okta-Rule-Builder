/* ===========================================================================
   verify-mfa.js — "Verify MFA" for a user's profile page
   ---------------------------------------------------------------------------
   Adds a "Verify MFA" button to the toolbar on
       /admin/user/profile/view/<userId>
   directly after Okta's "Reset or Remove password" button, and drives an
   Okta Verify challenge from the popup behind it.

   Why this exists: a help-desk admin who is about to reset a password or an
   authenticator needs to know the caller is really the account owner. This
   asks the account's own enrolled Okta Verify factor and reports the answer.
   It grants nothing, changes nothing, and writes nothing to the user.

   Two flows, both hanging off the same endpoint:

     Okta Verify Push        POST .../verify returns factorResult WAITING plus
                             a poll link. We poll it every 4s and give up at
                             60s, per the feature spec.
     Okta Verify with OTP    POST .../verify with {passCode} answers in one
                             round trip.

   Only OKTA-provider push and token:software:totp factors in ACTIVE status
   are offered. Other enrolled factors (WebAuthn, Duo, SMS, security question)
   are deliberately left out: some cannot complete outside the end user's own
   browser, and the rest are out of scope for this feature.

   Modelled on the "verify factor" flow in gabrielsroka's rockstar, rewritten
   against the ORB host helpers with no jQuery.

   Contract, matching orb-rule-viewer.js and orb-group-export.js:
       window.orbVerifyMfa.inject({ getJSON, postJSON, createPopup, ui })

   Load order: this file must load BEFORE orb-plugin.js, which mounts it.
=========================================================================== */
(function () {
  "use strict";

  const MARK = "orb-verify-mfa";

  // Poll cadence and the hard client-side deadline for a push, in ms.
  const POLL_EVERY_MS = 4000;
  const PUSH_DEADLINE_MS = 60000;
  const TICK_MS = 1000; // one timer drives both the countdown and the polling

  const TOOLBAR_SEL = "#admin-user-profile-toolbar";
  const RESET_SEL = "#reset-password";
  const DROPDOWN_SEL = "#people-more-actions-dropdown";

  /* Okta gives #reset-password "margin: 12px 12px 0 0" and floats it left.
     The 12px top margin is what drops it from the toolbar's own top edge onto
     the row's baseline, so a button without it renders 12px high. We copy the
     value rather than the element, since the float comes from layoutFrom and
     the margin has to be passed to place() explicitly. */
  const TOOLBAR_MARGIN = "12px 12px 0 0";

  // /admin/user/profile/view/<userId>, with the id captured. Anchored, so the
  // People list and other /admin/user pages do not match.
  const USER_PATH = /^\/admin\/user\/profile\/view\/([^\/?#]+)/;

  // Exact strings the feature is specified to show. Kept in one place so the
  // push and OTP paths cannot drift apart.
  const MSG = {
    verified: "User's MFA Verified Successfully",
    pushFailed: "MFA Push Failed or Rejected",
    badCode: "Code not valid",
  };

  const COLOR = {
    ok: "#0a7c42",
    error: "#b00",
    warn: "#a35200",
    quiet: "#6e6e78",
  };

  /* How recently a factor was enrolled before we say something about it.
     The attack this guards against: someone enrols their own authenticator
     on an account they have partial access to, then calls the help desk to
     get a password reset. A push approved by a factor enrolled an hour ago
     proves the caller holds a device, not that the device belongs to the
     account owner. */
  const ENROLLED_ALERT_MS = 24 * 60 * 60 * 1000;
  const ENROLLED_NOTE_MS = 7 * 24 * 60 * 60 * 1000;

  /* Factors we offer, in the order they appear in the picker. Matched on
     provider AND factorType together, since GOOGLE also enrols
     token:software:totp and is not Okta Verify. */
  const OFFERED = [
    { provider: "OKTA", factorType: "push", label: "Okta Verify Push" },
    {
      provider: "OKTA",
      factorType: "token:software:totp",
      label: "Okta Verify with OTP",
    },
  ];

  let host = null;
  let observer = null;

  /* =========================================================================
     SMALL DOM HELPERS — everything user-supplied goes in as textContent, so a
     display name or an API error message can never inject markup into the
     admin console.
  ========================================================================= */
  function make(tag, css, text) {
    const el = document.createElement(tag);
    if (css) el.style.cssText = css;
    if (text != null) el.textContent = text;
    return el;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // In-popup buttons use Okta's own .button classes and carry no ORB badge.
  // The badge marks buttons we add to Okta's chrome; inside our own popup it
  // would just be noise. Same choice orb-plugin.js makes for "Apply to Okta
  // rule".
  function actionButton(label, primary) {
    const b = document.createElement("input");
    b.type = "button";
    b.className = primary ? "button button-primary" : "button";
    b.value = label;
    return b;
  }

  // A polite live region, so a result that arrives seconds after the click is
  // announced rather than silently swapped in.
  function statusLine(panel, text, color) {
    const line = make("div", "margin:4px 0;", text);
    if (color) line.style.color = color;
    line.setAttribute("role", "status");
    line.setAttribute("aria-live", "polite");
    panel.appendChild(line);
    return line;
  }

  // Always appends and returns the node, so a caller can create an empty line
  // now and fill it in later. That is what the push countdown needs.
  function quietLine(panel, text) {
    const d = make(
      "div",
      "margin:6px 0 0;font-size:12px;color:" + COLOR.quiet,
      text || ""
    );
    panel.appendChild(d);
    return d;
  }

  // For one-shot detail under a result, where an empty string means "nothing
  // worth saying" and should not leave a stray empty line behind.
  function detailLine(panel, text) {
    return text ? quietLine(panel, text) : null;
  }

  /* =========================================================================
     URL HELPERS
  ========================================================================= */
  function userIdFromPath() {
    const m = USER_PATH.exec(location.pathname);
    return m ? m[1] : null;
  }

  function verifyUrl(userId, factorId) {
    return (
      "/api/v1/users/" +
      encodeURIComponent(userId) +
      "/factors/" +
      encodeURIComponent(factorId) +
      "/verify"
    );
  }

  // The host's getJSON prefixes location.origin, but Okta returns _links as
  // absolute URLs. Reduce one to a path so the two agree.
  function pathOf(absoluteUrl) {
    try {
      const u = new URL(absoluteUrl);
      return u.pathname + u.search;
    } catch (e) {
      return null;
    }
  }

  function errText(err) {
    return (err && err.message) || "Unknown error";
  }

  /* =========================================================================
     FACTOR DETAIL — everything here is best-effort. Okta populates a push
     factor's profile with the device name, platform, and app version, but
     which fields arrive varies by enrolment path and Okta version, and a TOTP
     factor carries almost none of it. So every field is optional and a missing
     one drops out of the line rather than printing "undefined".
  ========================================================================= */
  const PLATFORM_NAMES = {
    IOS: "iOS",
    ANDROID: "Android",
    OSX: "macOS",
    MACOS: "macOS",
    WINDOWS: "Windows",
  };

  function platformName(p) {
    if (!p) return null;
    return PLATFORM_NAMES[String(p).toUpperCase()] || String(p);
  }

  // "SmartPhone_IPhone" -> "iPhone". Only used when there is no device name.
  function deviceTypeName(t) {
    if (!t) return null;
    const tail = String(t).split("_").pop();
    if (/^iphone$/i.test(tail)) return "iPhone";
    if (/^ipad$/i.test(tail)) return "iPad";
    if (/^android$/i.test(tail)) return "Android device";
    return tail.replace(/([a-z])([A-Z])/g, "$1 $2");
  }

  // "Lou's iPhone, iOS 17.2", or null when Okta gave us nothing to say.
  function deviceLabel(factor) {
    const p = (factor && factor.profile) || {};
    const bits = [];
    if (p.name) bits.push(p.name);
    const os = [platformName(p.platform), p.version].filter(Boolean).join(" ");
    if (os) bits.push(os);
    if (!bits.length) {
      const t = deviceTypeName(p.deviceType);
      if (t) bits.push(t);
    }
    return bits.length ? bits.join(", ") : null;
  }

  function msSince(iso) {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (isNaN(t)) return null;
    const age = Date.now() - t;
    return age < 0 ? 0 : age;
  }

  function relativeTime(iso) {
    const age = msSince(iso);
    if (age == null) return null;
    const mins = Math.floor(age / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + (mins === 1 ? " minute ago" : " minutes ago");
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
    const days = Math.floor(hours / 24);
    if (days < 31) return days + (days === 1 ? " day ago" : " days ago");
    const months = Math.floor(days / 30);
    if (months < 24) return months + (months === 1 ? " month ago" : " months ago");
    return Math.floor(days / 365) + " years ago";
  }

  /* The line under each factor: what device it is and when it last worked.
     "Last used" is the more useful half for a help-desk agent, since a factor
     the account owner uses every day is a stronger signal than the hardware
     model. */
  function factorSubtitle(factor) {
    const bits = [];
    if (factor.device) bits.push(factor.device);
    const used = relativeTime(factor.lastVerified);
    if (used) bits.push("last used " + used);
    else if (factor.lastVerified === null && factor.created) bits.push("never used");
    return bits.length ? bits.join(", ") : null;
  }

  /* Returns {level, text} or null. level "alert" is the case an agent must
     not miss, so it gets the warning colour in the picker and repeats on the
     success screen, where the decision actually gets made. */
  function enrolmentCaution(factor) {
    const age = msSince(factor.created);
    if (age == null) return null;
    const when = relativeTime(factor.created);
    if (age <= ENROLLED_ALERT_MS) {
      return {
        level: "alert",
        text:
          "Enrolled " +
          when +
          ". A newly enrolled authenticator shows the caller holds this device, not that the device belongs to this account. Confirm identity another way before changing anything.",
      };
    }
    if (age <= ENROLLED_NOTE_MS) {
      return { level: "note", text: "Enrolled " + when + "." };
    }
    return null;
  }

  /* =========================================================================
     BUTTON INJECTION — lands the button between "Reset or Remove password"
     and the "More Actions" dropdown.

     Two things about this toolbar are easy to get wrong:

     1. It is built in stages. An empty or half-built toolbar exists in the
        DOM before Okta's own buttons arrive, so injecting on first sight puts
        us ahead of buttons that do not exist yet. Because those buttons are
        floated, being first in the DOM means being leftmost on screen. We
        therefore wait for one of Okta's own controls to appear and anchor to
        it. The MutationObserver calls us again when it lands.

     2. Okta's buttons are float:left with a 12px top margin. A float:none
        button drops out of the float row entirely and reflows to the far end
        of the line, and a floated one without the top margin renders 12px
        high. layoutFrom copies the float; TOOLBAR_MARGIN supplies the rest.
  ========================================================================= */
  function tryInject() {
    const userId = userIdFromPath();
    if (!userId) return; // SPA navigated off a profile page

    const toolbar = document.querySelector(TOOLBAR_SEL);
    if (!toolbar) return; // toolbar not rendered yet; the observer re-runs us
    if (toolbar.querySelector("." + MARK)) return; // already added

    // Anchor to the reset button, or to the More Actions dropdown for an
    // admin role that cannot reset passwords. Neither present means the
    // toolbar is still being built, so wait rather than guess a position.
    const reset = toolbar.querySelector(RESET_SEL);
    const dropdown = toolbar.querySelector(DROPDOWN_SEL);
    const anchor = reset || dropdown;
    if (!anchor) return;

    const btn = host.ui.createButton({
      label: "Verify MFA",
      title: "Challenge this user's Okta Verify factor",
      variant: "toolbar",
      className: MARK,
      onClick: function () {
        openVerifyPopup(userId);
      },
    });

    host.ui.place(btn, {
      parent: toolbar,
      // After the reset button when we have one, otherwise ahead of the
      // dropdown. reset.nextSibling may be null if reset is the last child,
      // and place() falls back to appending, which is the same position.
      before: reset ? reset.nextSibling : dropdown,
      layoutFrom: anchor,
      margin: TOOLBAR_MARGIN,
    });
  }

  /* =========================================================================
     STEP 1 — load the user's factors and offer the supported ones
  ========================================================================= */
  function openVerifyPopup(userId) {
    const body = host.createPopup("Verify MFA");
    const panel = body.appendChild(
      make("div", "min-width:330px;max-width:430px;")
    );

    statusLine(panel, "Loading this user's factors...");

    // Fired now so the ticket record has names by the time it is asked for.
    prefetchIdentity(userId);

    host
      .getJSON("/api/v1/users/" + encodeURIComponent(userId) + "/factors")
      .then(function (factors) {
        if (!panel.isConnected) return; // popup closed while we waited
        const usable = offeredFactors(factors);
        if (!usable.length) {
          clear(panel);
          statusLine(
            panel,
            "This user has no active Okta Verify factor to challenge."
          );
          detailLine(
            panel,
            "Verify MFA supports Okta Verify Push and Okta Verify with OTP. Enrol one of those to use this feature."
          );
          return;
        }
        showPicker(panel, userId, usable);
      })
      .catch(function (err) {
        if (!panel.isConnected) return;
        clear(panel);
        statusLine(panel, "Could not load this user's factors.", COLOR.error);
        detailLine(panel, errText(err));
      });
  }

  // Keep only ACTIVE, OKTA-provider push and TOTP factors, in OFFERED order.
  function offeredFactors(factors) {
    const list = Array.isArray(factors) ? factors : [];
    const out = [];
    OFFERED.forEach(function (spec) {
      list.forEach(function (f) {
        if (
          f &&
          f.status === "ACTIVE" &&
          f.provider === spec.provider &&
          f.factorType === spec.factorType
        ) {
          out.push({
            id: f.id,
            factorType: f.factorType,
            label: spec.label,
            device: deviceLabel(f),
            created: f.created || null,
            // undefined means Okta omitted the field, null means enrolled but
            // never used. factorSubtitle tells those apart.
            lastVerified: f.lastVerified === undefined ? undefined : f.lastVerified,
          });
        }
      });
    });
    return out;
  }

  function showPicker(panel, userId, factors) {
    clear(panel);
    panel.appendChild(make("div", "margin-bottom:8px;", "Choose a factor to verify."));

    const group = panel.appendChild(make("div", "margin:0 0 12px;"));
    const radios = [];

    factors.forEach(function (factor, i) {
      const row = group.appendChild(
        make("label", "display:block;margin:10px 0;cursor:pointer;")
      );

      const head = row.appendChild(make("div", "display:flex;align-items:flex-start;"));
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = MARK + "-factor";
      radio.value = factor.id;
      radio.checked = i === 0; // first option preselected, so Next always works
      radio.style.cssText = "margin:3px 8px 0 0;flex:none";
      head.appendChild(radio);
      head.appendChild(make("span", null, factor.label));

      // Indented to the radio's text, so the detail reads as belonging to
      // this option rather than to the group.
      const detail = factorSubtitle(factor);
      if (detail) {
        row.appendChild(
          make(
            "div",
            "margin:2px 0 0 24px;font-size:12px;color:" + COLOR.quiet,
            detail
          )
        );
      }

      const caution = enrolmentCaution(factor);
      if (caution) {
        row.appendChild(
          make(
            "div",
            "margin:4px 0 0 24px;font-size:12px;color:" +
              (caution.level === "alert" ? COLOR.warn : COLOR.quiet),
            caution.text
          )
        );
      }

      radios.push({ radio: radio, factor: factor });
    });

    const next = actionButton("Next", true);
    next.addEventListener("click", function () {
      const chosen = radios.filter(function (r) {
        return r.radio.checked;
      })[0];
      if (!chosen) return;
      if (chosen.factor.factorType === "push") {
        startPush(panel, userId, chosen.factor);
      } else {
        showOtpForm(panel, userId, chosen.factor);
      }
    });
    panel.appendChild(next);

    if (radios.length) radios[0].radio.focus();
  }

  /* =========================================================================
     STEP 2a — PUSH

     POST the challenge, then poll the returned link. Results Okta can send
     back: WAITING (keep going), SUCCESS, REJECTED, TIMEOUT. Anything that is
     not SUCCESS, and the 60s deadline, both land on MSG.pushFailed, since the
     admin's next action is the same either way.

     The deadline is ours, not Okta's. The challenge stays live on the user's
     phone after we stop watching, so a late approval will not show here. The
     retry link starts a fresh challenge, which is the honest way to recover.
  ========================================================================= */
  function startPush(panel, userId, factor) {
    clear(panel);
    panel.appendChild(make("div", "margin-bottom:6px;", factor.label));
    const status = statusLine(panel, "Sending a push to the user's device...");
    const countdown = quietLine(panel, "");

    // data: {} rather than no body, so the POST always carries valid JSON to
    // match the Content-Type the host helper sets.
    host
      .postJSON({ url: verifyUrl(userId, factor.id), data: {} })
      .then(function (res) {
        if (!panel.isConnected) return;

        const result = res && res.factorResult;
        if (result === "SUCCESS") return succeed(panel, userId, factor);
        if (result && result !== "WAITING") return failPush(panel, userId, factor);

        const pollPath = pathOf(
          res && res._links && res._links.poll && res._links.poll.href
        );
        if (!pollPath) {
          // No poll link means we cannot learn the outcome, so say that
          // rather than reporting a failure the user did not cause.
          status.textContent =
            "Push sent, but Okta returned no way to check the result.";
          status.style.color = COLOR.error;
          countdown.textContent = "";
          offerRetry(panel, userId, factor);
          return;
        }

        status.textContent = "Waiting for the user to approve the push...";
        pollPush(panel, userId, factor, pollPath, status, countdown);
      })
      .catch(function (err) {
        if (!panel.isConnected) return;
        clear(panel);
        statusLine(panel, MSG.pushFailed, COLOR.error);
        detailLine(panel, errText(err));
        offerRetry(panel, userId, factor);
      });
  }

  function pollPush(panel, userId, factor, pollPath, status, countdown) {
    let elapsed = 0;
    let inFlight = false;

    const timer = setInterval(function () {
      // The close "X" removes the popup, so stop rather than polling on
      // behalf of a window nobody is looking at.
      if (!panel.isConnected) return stop();

      elapsed += TICK_MS;
      const left = Math.max(0, Math.ceil((PUSH_DEADLINE_MS - elapsed) / 1000));
      if (countdown) {
        countdown.textContent = left + "s remaining";
      }

      if (elapsed >= PUSH_DEADLINE_MS) {
        stop();
        return failPush(panel, userId, factor);
      }

      if (elapsed % POLL_EVERY_MS !== 0 || inFlight) return;

      inFlight = true;
      host
        .getJSON(pollPath)
        .then(function (poll) {
          inFlight = false;
          if (!panel.isConnected) return stop();
          const result = poll && poll.factorResult;
          if (result === "SUCCESS") {
            stop();
            succeed(panel, userId, factor);
          } else if (result && result !== "WAITING") {
            // REJECTED or TIMEOUT
            stop();
            failPush(panel, userId, factor);
          }
        })
        .catch(function (err) {
          inFlight = false;
          if (!panel.isConnected) return stop();
          stop();
          clear(panel);
          statusLine(panel, MSG.pushFailed, COLOR.error);
          detailLine(panel, errText(err));
          offerRetry(panel, userId, factor);
        });
    }, TICK_MS);

    function stop() {
      clearInterval(timer);
    }
  }

  function failPush(panel, userId, factor) {
    clear(panel);
    statusLine(panel, MSG.pushFailed, COLOR.error);
    detailLine(
      panel,
      "The user declined the push, or did not respond within 60 seconds."
    );
    offerRetry(panel, userId, factor);
    // A failed check is worth recording too, since it is often the reason a
    // ticket gets escalated rather than closed.
    recordBlock(panel, userId, factor, "Push failed or rejected");
  }

  /* =========================================================================
     STEP 2b — OTP

     One round trip. Okta answers a wrong code with 403 and an errorSummary,
     which the host's postJSON turns into a thrown Error, so both the rejected
     response and the thrown error land on MSG.badCode. Okta's own wording
     goes underneath in small text, since "Invalid Passcode/Answer" and "rate
     limit exceeded" call for different next steps from the admin.
  ========================================================================= */
  function showOtpForm(panel, userId, factor) {
    clear(panel);
    panel.appendChild(make("div", "margin-bottom:8px;", factor.label));

    const label = panel.appendChild(
      make("label", "display:block;margin-bottom:4px;", "One-time code")
    );
    label.htmlFor = MARK + "-code";

    const input = document.createElement("input");
    input.type = "text";
    input.id = MARK + "-code";
    input.autocomplete = "off";
    input.setAttribute("inputmode", "numeric");
    input.style.cssText = "width:160px;margin-bottom:10px;";
    panel.appendChild(input);
    panel.appendChild(make("div"));

    const submit = actionButton("Submit", true);
    panel.appendChild(submit);

    const error = panel.appendChild(make("div", "margin-top:10px;"));

    function send() {
      const code = input.value.trim();
      clear(error);
      if (!code) {
        error.appendChild(
          make("div", "color:" + COLOR.error, "Enter the code from Okta Verify.")
        );
        input.focus();
        return;
      }

      submit.disabled = true;
      input.disabled = true;
      error.appendChild(make("div", "color:" + COLOR.quiet, "Checking the code..."));

      host
        .postJSON({
          url: verifyUrl(userId, factor.id),
          data: { passCode: code },
        })
        .then(function (res) {
          if (!panel.isConnected) return;
          if (res && res.factorResult === "SUCCESS")
            return succeed(panel, userId, factor);
          rejectCode(res && res.factorResult);
        })
        .catch(function (err) {
          if (!panel.isConnected) return;
          rejectCode(errText(err));
        });

      function rejectCode(detail) {
        clear(error);
        error.appendChild(make("div", "color:" + COLOR.error, MSG.badCode));
        if (detail) {
          error.appendChild(
            make("div", "margin-top:4px;font-size:12px;color:" + COLOR.quiet, detail)
          );
        }
        submit.disabled = false;
        input.disabled = false;
        input.value = "";
        input.focus(); // straight back to a retry, no extra click
      }
    }

    submit.addEventListener("click", send);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault(); // Okta's page has forms around us; do not submit one
        send();
      }
    });

    input.focus();
  }

  /* =========================================================================
     TICKET RECORD — the agent's next action after verifying is to write what
     they did into a ticket, so hand them the text.

     The two names in the record (who was verified, who verified them) need
     two extra calls, so we fire them when the popup opens and read whatever
     landed by the time the button is clicked. Two reasons not to await them
     at click time: a verification takes seconds, so they are always back by
     then in practice, and awaiting inside the click handler can cost us the
     user-gesture context that navigator.clipboard requires. A field that did
     not arrive is left out rather than blocking the copy.
  ========================================================================= */
  const identity = { me: null, user: null };

  function prefetchIdentity(userId) {
    identity.user = null; // a different user's profile may be cached
    host
      .getJSON("/api/v1/users/" + encodeURIComponent(userId))
      .then(function (u) {
        identity.user = u;
      })
      .catch(function () {});

    if (identity.me) return; // the signed-in admin does not change mid-session
    host
      .getJSON("/api/v1/users/me")
      .then(function (u) {
        identity.me = u;
      })
      .catch(function () {});
  }

  function nameOf(user) {
    const p = (user && user.profile) || {};
    const full = [p.firstName, p.lastName].filter(Boolean).join(" ");
    if (full && p.login) return full + " (" + p.login + ")";
    return full || p.login || null;
  }

  function buildRecord(userId, factor, resultText) {
    const lines = ["Okta MFA verification"];

    const who = nameOf(identity.user);
    lines.push("User: " + (who || userId));
    if (who) lines.push("User ID: " + userId);

    lines.push("Factor: " + factor.label + (factor.device ? ", " + factor.device : ""));
    if (factor.created) {
      lines.push("Factor enrolled: " + factor.created + " (" + relativeTime(factor.created) + ")");
    }
    if (factor.lastVerified) {
      lines.push("Factor last used before this check: " + factor.lastVerified);
    }

    lines.push("Result: " + resultText);
    lines.push("Checked at: " + new Date().toISOString());

    const by = nameOf(identity.me);
    if (by) lines.push("Checked by: " + by);

    const caution = enrolmentCaution(factor);
    if (caution && caution.level === "alert") {
      lines.push("Caution: " + caution.text);
    }
    return lines.join("\n");
  }

  function recordBlock(panel, userId, factor, resultText) {
    const bar = panel.appendChild(make("div", "margin-top:14px;"));
    const copy = actionButton("Copy for ticket");
    const note = make("div", "margin-top:6px;font-size:12px;color:" + COLOR.quiet, "");

    // Shown only if the clipboard is unavailable, which happens when the
    // document is not focused or permission is denied. Better than a dead
    // button with no explanation.
    const box = make(
      "textarea",
      "display:none;width:100%;box-sizing:border-box;height:150px;margin-top:8px;" +
        "font:12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;"
    );
    box.readOnly = true;

    copy.addEventListener("click", function () {
      const text = buildRecord(userId, factor, resultText);
      box.value = text;

      function manual() {
        box.style.display = "block";
        note.textContent = "Copy the text below.";
        box.focus();
        if (box.select) box.select();
      }

      const clip = typeof navigator !== "undefined" && navigator.clipboard;
      if (clip && clip.writeText) {
        clip
          .writeText(text)
          .then(function () {
            note.textContent = "Copied.";
          })
          .catch(manual);
      } else {
        manual();
      }
    });

    bar.appendChild(copy);
    bar.appendChild(note);
    bar.appendChild(box);
  }

  /* =========================================================================
     RESULTS
  ========================================================================= */
  function succeed(panel, userId, factor) {
    clear(panel);
    statusLine(panel, MSG.verified, COLOR.ok);

    // Repeat a recent-enrolment alert here. The picker showed it before the
    // challenge, but this is the screen the agent is looking at when they
    // decide whether to act on the result.
    const caution = enrolmentCaution(factor);
    if (caution && caution.level === "alert") {
      panel.appendChild(
        make("div", "margin-top:8px;font-size:12px;color:" + COLOR.warn, caution.text)
      );
    }

    detailLine(panel, factor.device ? "Verified with " + factor.device : null);
    recordBlock(panel, userId, factor, "Verified successfully");
  }

  function offerRetry(panel, userId, factor) {
    const bar = panel.appendChild(make("div", "margin-top:12px;"));
    const again = actionButton("Try again");
    again.addEventListener("click", function () {
      if (factor.factorType === "push") startPush(panel, userId, factor);
      else showOtpForm(panel, userId, factor);
    });
    bar.appendChild(again);
  }

  /* =========================================================================
     MOUNT — the toolbar is rendered by the console after load, so watch for
     it the way orb-plugin.js watches for the group-rule modal. The observer
     is installed once and left in place, since tryInject() is a couple of
     cheap guarded lookups and the console swaps views without a reload.
  ========================================================================= */
  function inject(hostApi) {
    host = hostApi || {};
    if (!host.createPopup || !host.getJSON || !host.postJSON || !host.ui) {
      console.warn(
        "[orb] verify-mfa.js needs createPopup, getJSON, postJSON, and ui from the host, so the Verify MFA button was skipped."
      );
      return;
    }

    tryInject();
    if (observer) return;
    observer = new MutationObserver(tryInject);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (typeof window !== "undefined") {
    window.orbVerifyMfa = { inject: inject, MARK: MARK };
  }
})();
