/* ===========================================================================
   Okta Group Rule Builder — packaged as a mountable module for the rockstar
   extension. Call createGroupRuleBuilder(containerEl) to render the UI into
   the given element (e.g. a rockstar popup body). Self-contained; no external
   deps, all styling inline.
   Exposes: window.createGroupRuleBuilder(containerEl)
=========================================================================== */
function createGroupRuleBuilder(_mountRoot) {
  if (!_mountRoot) throw new Error("createGroupRuleBuilder: a container element is required");
/* ===========================================================================
   Okta Expression Language – Group Rule Builder
   Fully self-contained. No frameworks, no external dependencies.
   - Build nested AND / OR logic
   - Each leaf targets a user-profile attribute OR group membership
   - Live-generates valid Okta Expression Language
   - Import an existing expression and edit it in the UI
=========================================================================== */

/* ---------------------------------------------------------------------------
   Tiny DOM helper (replaces React.createElement)
   h(tag, props, ...children) -> HTMLElement
   - props.style accepts an object (camelCase keys ok)
   - on* props (onClick, onChange, onInput) attach event listeners
   - children may be nodes, strings, numbers, arrays, or false/null (skipped)
--------------------------------------------------------------------------- */
function h(tag, props, ...children) {
  const el =
    tag === "svg" || SVG_TAGS.has(tag)
      ? document.createElementNS("http://www.w3.org/2000/svg", tag)
      : document.createElement(tag);

  if (props) {
    for (const key in props) {
      const val = props[key];
      if (val == null || val === false) continue;
      if (key === "style" && typeof val === "object") {
        applyStyle(el, val);
      } else if (key === "className") {
        el.setAttribute("class", val);
      } else if (key === "htmlFor") {
        el.setAttribute("for", val);
      } else if (/^on[A-Z]/.test(key)) {
        const evt = key.slice(2).toLowerCase();
        el.addEventListener(evt, val);
      } else if (key === "value") {
        // set as property so inputs/selects/textarea update reliably
        el.value = val;
      } else if (key === "checked" || key === "disabled" || key === "spellcheck") {
        el[key] = val;
      } else {
        el.setAttribute(camelToAttr(key), val);
      }
    }
  }

  appendChildren(el, children);
  return el;
}

const SVG_TAGS = new Set([
  "svg", "line", "rect", "path", "polyline", "polygon", "circle",
]);

function camelToAttr(k) {
  // strokeWidth -> stroke-width, viewBox stays viewBox for SVG
  if (k === "viewBox") return k;
  return k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}

function applyStyle(el, styleObj) {
  for (const prop in styleObj) {
    let v = styleObj[prop];
    // numbers become px for layout-ish props (mirrors React behavior)
    if (typeof v === "number" && !UNITLESS.has(prop)) v = v + "px";
    el.style[prop] = v;
  }
}

const UNITLESS = new Set([
  "opacity", "fontWeight", "lineHeight", "zIndex", "flex", "flexGrow",
  "flexShrink", "order", "letterSpacing", // letterSpacing handled below anyway
]);

function appendChildren(el, children) {
  for (const child of children) {
    if (child == null || child === false || child === true) continue;
    if (Array.isArray(child)) {
      appendChildren(el, child);
    } else if (child instanceof Node) {
      el.appendChild(child);
    } else {
      el.appendChild(document.createTextNode(String(child)));
    }
  }
}

// --- Inline icon set (SVG) ---
function icon(children, size = 16) {
  return h(
    "svg",
    {
      width: size, height: size, viewBox: "0 0 24 24", fill: "none",
      stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round",
      strokeLinejoin: "round",
    },
    children
  );
}
const IconPlus = (s) => icon([h("line",{x1:12,y1:5,x2:12,y2:19}), h("line",{x1:5,y1:12,x2:19,y2:12})], s);
const IconX = (s) => icon([h("line",{x1:18,y1:6,x2:6,y2:18}), h("line",{x1:6,y1:6,x2:18,y2:18})], s);
const IconCopy = (s) => icon([h("rect",{x:9,y:9,width:13,height:13,rx:2,ry:2}), h("path",{d:"M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"})], s);
const IconCheck = (s) => icon([h("polyline",{points:"20 6 9 17 4 12"})], s);
const IconFolderTree = (s) => icon([h("path",{d:"M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 14 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"}), h("path",{d:"M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H12a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"}), h("path",{d:"M3 5a2 2 0 0 0 2 2h3"}), h("path",{d:"M3 3v13a2 2 0 0 0 2 2h3"})], s);
const IconUser = (s) => icon([h("path",{d:"M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"}), h("circle",{cx:12,cy:7,r:4})], s);
const IconLayers = (s) => icon([h("polygon",{points:"12 2 2 7 12 12 22 7 12 2"}), h("polyline",{points:"2 17 12 22 22 17"}), h("polyline",{points:"2 12 12 17 22 12"})], s);

/* ===========================================================================
   DATA / LOGIC  (unchanged, framework-agnostic)
=========================================================================== */

// User profile attributes (base + common). Users can also type a custom one.
const PROFILE_ATTRS = [
  { value: "user.title", label: "Title" },
  { value: "user.department", label: "Department" },
  { value: "user.division", label: "Division" },
  { value: "user.organization", label: "Organization" },
  { value: "user.managerId", label: "Manager ID" },
  { value: "user.manager", label: "Manager" },
  { value: "user.countryCode", label: "Country Code" },
  { value: "user.city", label: "City" },
  { value: "user.state", label: "State / Region" },
  { value: "user.employeeNumber", label: "Employee Number" },
  { value: "user.userType", label: "User Type" },
  { value: "user.costCenter", label: "Cost Center" },
  { value: "user.email", label: "Email" },
  { value: "user.login", label: "Username / Login" },
  { value: "user.firstName", label: "First Name" },
  { value: "user.lastName", label: "Last Name" },
  { value: "__custom__", label: "Custom attribute…" },
];

// String operators map to Okta EL fragments. lhs = attribute, rhs = value.
// NOTE: "ends with" (String.endsWith) removed — not supported in Okta EL.
// Build the numeric argument list for String.substring from a leaf.
// - start only (end blank)  -> "4"        => substring(attr, 4)   [start .. end of string]
// - start and end           -> "4, 6"     => substring(attr, 4, 6) [indices 4,5]
// Falls back to 0 when start is missing/invalid.
function substrArgs(leaf) {
  const start = String(leaf && leaf.substrStart !== undefined ? leaf.substrStart : "0").trim();
  const end = String(leaf && leaf.substrEnd !== undefined ? leaf.substrEnd : "").trim();
  const s = start === "" ? "0" : start;
  return end === "" ? s : `${s}, ${end}`;
}

const STRING_OPS = [
  { value: "eq", label: "equals", tpl: (l, v) => `${l} == "${v}"` },
  { value: "neq", label: "does not equal", tpl: (l, v) => `${l} != "${v}"` },
  { value: "eq_ci", label: "equals (case-insensitive)", tpl: (l, v) => `String.toLowerCase(${l}) == "${v.toLowerCase()}"` },
  { value: "neq_ci", label: "does not equal (case-insensitive)", tpl: (l, v) => `String.toLowerCase(${l}) != "${v.toLowerCase()}"` },
  { value: "sw", label: "starts with", tpl: (l, v) => `String.startsWith(${l}, "${v}")` },
  { value: "contains", label: "contains", tpl: (l, v) => `String.stringContains(String.toLowerCase(${l}), "${v.toLowerCase()}")` },
  { value: "substr_eq", label: "substring at position equals", tpl: (l, v, leaf) => `String.substring(${l}, ${substrArgs(leaf)}) == "${v}"` },
  { value: "substr_neq", label: "substring at position does not equal", tpl: (l, v, leaf) => `String.substring(${l}, ${substrArgs(leaf)}) != "${v}"` },
  { value: "present", label: "is present", tpl: (l) => `String.stringContains(${l}, "") || ${l} != null` },
  { value: "empty", label: "is empty / null", tpl: (l) => `String.isNullOrEmpty(${l})` },
  // Boolean comparisons — unquoted true/false literal (e.g. user.peopleManager == true),
  // as opposed to the string equality ops above which quote the value
  // (e.g. user.peopleManager == "true"). Okta EL treats these very differently:
  // the unquoted form compares against the actual boolean, the quoted form
  // compares against the literal string "true". customOnly restricts these to
  // the "Custom attribute…" picker since none of the built-in PROFILE_ATTRS are booleans.
  { value: "istrue", label: "Is True (boolean)", tpl: (l) => `${l} == true`, customOnly: true },
  { value: "isfalse", label: "Is False (boolean)", tpl: (l) => `${l} == false`, customOnly: true },
];

const GROUP_OPS = [
  {
    value: "member",
    label: "is a member of",
    tpl: (id) => `isMemberOfGroupName("${id}")`,
  },
  {
    value: "notmember",
    label: "is NOT a member of",
    tpl: (id) => `!isMemberOfGroupName("${id}")`,
  },
  {
    value: "member_id",
    label: "is a member of (by Group ID)",
    tpl: (id) => `isMemberOfGroup("${id}")`,
  },
  {
    value: "notmember_id",
    label: "is NOT a member of (by Group ID)",
    tpl: (id) => `!isMemberOfGroup("${id}")`,
  },
  // NOTE: only "starts with" is supported here — Okta EL has no
  // isMemberOfGroupNameEndsWith, so an "ends with" op is intentionally omitted.
  {
    value: "startswith",
    label: "group name starts with",
    tpl: (id) => `isMemberOfGroupNameStartsWith("${id}")`,
  },
  {
    value: "notstartswith",
    label: "group name does NOT start with",
    tpl: (id) => `!isMemberOfGroupNameStartsWith("${id}")`,
  },
];

let _id = 0;
const uid = () => `n${_id++}`;

const newLeaf = () => ({
  id: uid(),
  kind: "leaf",
  type: "profile", // "profile" | "group"
  attr: "user.title",
  customAttr: "",
  op: "eq",
  value: "",
  substrStart: "0", // used only by substring operators
  substrEnd: "",     // used only by substring operators (blank => to end of string)
});

const newGroup = (join = "AND", children) => ({
  id: uid(),
  kind: "group",
  join,
  children: children || [newLeaf()],
});

// ---- Expression generation --------------------------------------------------
function leafToEL(leaf) {
  if (leaf._raw !== undefined) {
    const t = leaf._raw.trim();
    return t || null;
  }
  if (leaf.type === "group") {
    const op = GROUP_OPS.find((o) => o.value === leaf.op) || GROUP_OPS[0];
    const id = leaf.value.trim();
    if (!id) return null;
    return op.tpl(id);
  }
  const attr = leaf.attr === "__custom__" ? leaf.customAttr.trim() : leaf.attr;
  if (!attr) return null;
  const op = STRING_OPS.find((o) => o.value === leaf.op) || STRING_OPS[0];
  const needsValue = !["present", "empty", "istrue", "isfalse"].includes(op.value);
  if (needsValue && !leaf.value.trim()) return null;
  return op.tpl(attr, leaf.value.trim(), leaf);
}

function nodeToEL(node) {
  if (node.kind === "leaf") return leafToEL(node);
  const parts = node.children.map(nodeToEL).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  const joiner = node.join === "AND" ? " AND " : " OR ";
  return "(" + parts.join(joiner) + ")";
}

function generateEL(root) {
  const el = nodeToEL(root);
  return el || "";
}

// ---- Expression parsing (EL -> node tree) ----------------------------------
// Tokenizer: splits an Okta EL string into meaningful tokens while respecting
// quoted strings and parentheses.
function tokenizeEL(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (c === "(" || c === ")" || c === "," ) { toks.push({ t: c }); i++; continue; }
    if (c === '"' || c === "'") {
      const q = c; let j = i + 1; let s = "";
      while (j < n && src[j] !== q) { if (src[j] === "\\" && j + 1 < n) { s += src[j + 1]; j += 2; } else { s += src[j]; j++; } }
      j++; // closing quote
      toks.push({ t: "str", v: s }); i = j; continue;
    }
    // operators == != ! && || and words
    if (src.startsWith("==", i)) { toks.push({ t: "==" }); i += 2; continue; }
    if (src.startsWith("!=", i)) { toks.push({ t: "!=" }); i += 2; continue; }
    if (src.startsWith("&&", i)) { toks.push({ t: "AND" }); i += 2; continue; }
    if (src.startsWith("||", i)) { toks.push({ t: "OR" }); i += 2; continue; }
    if (c === "!") { toks.push({ t: "!" }); i++; continue; }
    // identifier / keyword / dotted path
    let j = i; let w = "";
    while (j < n && /[A-Za-z0-9_.]/.test(src[j])) { w += src[j]; j++; }
    if (w) {
      const up = w.toUpperCase();
      if (up === "AND" || up === "OR") toks.push({ t: up });
      else toks.push({ t: "id", v: w });
      i = j; continue;
    }
    // unknown char, skip
    i++;
  }
  return toks;
}

// Apply De Morgan's law to negate a parsed node:
//   !(A OR B)  -> (!A AND !B)
//   !(A AND B) -> (!A OR !B)
//   ==  <-> !=,  member <-> notmember,  eq_ci <-> neq_ci, etc.
// Returns a negated copy, or null if any leaf can't be cleanly inverted (in
// which case the caller preserves the original as raw EL).
function negateNode(node) {
  if (!node) return null;

  if (node.kind === "group") {
    const flipped = node.children.map(negateNode);
    if (flipped.some((c) => c === null)) return null; // bail if anything unflippable
    return {
      ...node,
      id: uid(),
      join: node.join === "AND" ? "OR" : "AND",
      children: flipped,
    };
  }

  // Raw leaves can't be inverted safely.
  if (node._raw !== undefined) return null;

  // Invertible operator pairs for each leaf type.
  const PROFILE_FLIP = {
    eq: "neq", neq: "eq",
    eq_ci: "neq_ci", neq_ci: "eq_ci",
    substr_eq: "substr_neq", substr_neq: "substr_eq",
    istrue: "isfalse", isfalse: "istrue",
  };
  const GROUP_FLIP = {
    member: "notmember", notmember: "member",
    member_id: "notmember_id", notmember_id: "member_id",
    startswith: "notstartswith", notstartswith: "startswith",
  };

  const table = node.type === "group" ? GROUP_FLIP : PROFILE_FLIP;
  const flippedOp = table[node.op];
  if (!flippedOp) return null; // e.g. sw / contains / present / empty have no clean negation

  return { ...node, id: uid(), op: flippedOp };
}

// Recursive-descent parser producing an AST of {op:'and'|'or', items:[...]} and
// leaf strings; then we translate leaves back into leaf nodes.
function parseELtoAST(toks) {
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];

  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().t === "OR") { next(); const right = parseAnd(); left = mergeJoin("OR", left, right); }
    return left;
  }
  function parseAnd() {
    let left = parseUnary();
    while (peek() && peek().t === "AND") { next(); const right = parseUnary(); left = mergeJoin("AND", left, right); }
    return left;
  }
  function mergeJoin(join, left, right) {
    if (left && left.kind === "group" && left.join === join && !left._sealed) {
      left.children.push(right); return left;
    }
    return { kind: "group", join, children: [left, right] };
  }
  function parseUnary() {
    if (peek() && peek().t === "!") {
      next();
      // negation applies to a following function call or parenthesised expr
      const inner = parsePrimary(true);
      return inner;
    }
    return parsePrimary(false);
  }
  function parsePrimary(negated) {
    const tk = peek();
    if (!tk) return null;
    if (tk.t === "(") {
      next();
      const node = parseOr();
      if (peek() && peek().t === ")") next();
      if (node && node.kind === "group") node._sealed = true;
      // A "!" negating a whole parenthesised group is distributed using
      // De Morgan's law so it maps to real UI controls (== <-> !=, AND <-> OR).
      if (negated && node) {
        const flipped = negateNode(node);
        if (flipped) {
          if (flipped.kind === "group") flipped._sealed = true;
          return flipped;
        }
        // Couldn't fully distribute (some leaf isn't cleanly invertible, e.g.
        // "starts with" / "contains") -> preserve verbatim as raw EL so nothing
        // is silently dropped or mis-mapped.
        const inner = generateEL(node) || "";
        const wrapped = inner.startsWith("(") && inner.endsWith(")") ? inner : "(" + inner + ")";
        return rawLeaf("!" + wrapped);
      }
      return node;
    }
    // function call or comparison starting with an id
    if (tk.t === "id") {
      // capture the whole primary expression's tokens up to a boundary
      return parseComparisonOrCall(negated);
    }
    // fallback: skip token
    next();
    return null;
  }

  // Parse either a function-call leaf (group membership / string ops) or a
  // comparison (attr == "val").
  function parseComparisonOrCall(negated) {
    const idTok = next(); // id
    const name = idTok.v;

    // function call form: Name.method( args )  OR  isMemberOfGroup( args )
    if (peek() && peek().t === "(") {
      const args = parseArgList();

      // A function call may itself be the left side of a comparison, e.g.
      //   String.toLowerCase(user.wd_org_v1) != "product"
      // Case-normalising wrappers (toLowerCase/toUpperCase) are transparent for
      // mapping purposes: unwrap to the inner attribute and treat as a normal
      // profile comparison.
      if (peek() && (peek().t === "==" || peek().t === "!=")) {
        const opTok = next();
        const valTok = peek();
        let val = "";
        if (valTok && (valTok.t === "str" || valTok.t === "id")) { next(); val = valTok.v; }

        const transform = /^String\.(toLowerCase|toUpperCase)$/.test(name);
        const attrTok = transform ? (args[0] || []).find((t) => t.t === "id") : null;

        if (transform && attrTok) {
          // Preserve the case-normalising wrapper by mapping to the dedicated
          // case-insensitive operators, so a round-trip keeps String.toLowerCase.
          const leaf = newLeaf();
          leaf.type = "profile";
          const isEq = opTok.t === "==";
          leaf.op = negated ? (isEq ? "neq_ci" : "eq_ci") : (isEq ? "eq_ci" : "neq_ci");
          applyAttr(leaf, attrTok.v);
          leaf.value = val;
          return leaf;
        }

        // String.substring(attr, start[, end]) == "val"  ->  substring operator.
        // args[0] is the attribute; args[1]/args[2] are the numeric indices.
        if (name === "String.substring") {
          const subAttrTok = (args[0] || []).find((t) => t.t === "id");
          const numFrom = (a) => {
            const tk = (a || []).find((t) => t.t === "id" && /^-?\d+$/.test(t.v));
            return tk ? tk.v : null;
          };
          const startVal = numFrom(args[1]);
          const endVal = numFrom(args[2]);
          if (subAttrTok && startVal !== null) {
            const leaf = newLeaf();
            leaf.type = "profile";
            const isEq = opTok.t === "==";
            leaf.op = negated ? (isEq ? "substr_neq" : "substr_eq") : (isEq ? "substr_eq" : "substr_neq");
            applyAttr(leaf, subAttrTok.v);
            leaf.substrStart = startVal;
            leaf.substrEnd = endVal !== null ? endVal : "";
            leaf.value = val;
            return leaf;
          }
        }

        // Not a recognised transform we can map to a control -> keep as raw EL
        // so nothing is silently dropped.
        const call = (negated ? "!" : "") + name + "(" + args.map(argStr).join(", ") + ")";
        return rawLeaf(call + " " + opTok.t + ' "' + val + '"');
      }

      const leaf = funcToLeaf(name, args, negated);
      return leaf || rawLeaf((negated ? "!" : "") + name + "(" + args.map(argStr).join(", ") + ")");
    }

    // comparison form: id ( == | != ) "value"
    if (peek() && (peek().t === "==" || peek().t === "!=")) {
      const opTok = next();
      const valTok = peek();

      // Unquoted true/false (e.g. user.peopleManager == true) is a boolean
      // comparison, distinct from a quoted "true"/"false" string comparison
      // (which falls through to the generic id/str branch below and keeps
      // its quotes via the eq/neq template).
      if (valTok && valTok.t === "id" && (valTok.v === "true" || valTok.v === "false")) {
        next();
        const literalTrue = valTok.v === "true";
        const isEq = opTok.t === "==";
        // e.g. "!= false" or a leading "!" each flip which boolean state we're matching.
        const matchesTrue = negated ? !(isEq ? literalTrue : !literalTrue) : (isEq ? literalTrue : !literalTrue);
        const leaf = newLeaf();
        leaf.type = "profile";
        leaf.op = matchesTrue ? "istrue" : "isfalse";
        applyAttr(leaf, name);
        leaf.value = "";
        return leaf;
      }

      let val = "";
      if (valTok && valTok.t === "str") { next(); val = valTok.v; }
      else if (valTok && valTok.t === "id") { next(); val = valTok.v; }
      const leaf = newLeaf();
      leaf.type = "profile";
      // A leading "!" negates the comparison, so flip equals <-> not-equals.
      const isEq = opTok.t === "==";
      leaf.op = negated ? (isEq ? "neq" : "eq") : (isEq ? "eq" : "neq");
      applyAttr(leaf, name);
      leaf.value = val;
      return leaf;
    }

    // bare id (e.g. "attr != null" style or unrecognised) -> raw
    // handle "id != null"
    return rawLeaf((negated ? "!" : "") + name);
  }

  function parseArgList() {
    next(); // consume "("
    const args = [];
    let depth = 1;
    let current = [];
    while (peek() && depth > 0) {
      const tk = peek();
      if (tk.t === "(") { depth++; current.push(next()); continue; }
      if (tk.t === ")") { depth--; if (depth === 0) { next(); break; } current.push(next()); continue; }
      if (tk.t === "," && depth === 1) { next(); args.push(current); current = []; continue; }
      current.push(next());
    }
    if (current.length) args.push(current);
    return args;
  }

  const ast = parseOr();
  return ast;
}

// Turn a captured arg token list into a readable string (for nested funcs).
function argStr(tokList) {
  return tokList.map((t) => {
    if (t.t === "str") return '"' + t.v + '"';
    if (t.t === "id") return t.v;
    return t.t;
  }).join(" ");
}

function rawLeaf(text) {
  const leaf = newLeaf();
  leaf.type = "profile";
  leaf._raw = text; // marker: unparsed expression
  return leaf;
}

function applyAttr(leaf, attr) {
  const known = PROFILE_ATTRS.find((a) => a.value === attr && a.value !== "__custom__");
  if (known) { leaf.attr = attr; leaf.customAttr = ""; }
  else { leaf.attr = "__custom__"; leaf.customAttr = attr; }
}

// Map a parsed function call back into a leaf node.
function funcToLeaf(name, args, negated) {
  const firstStr = (a) => {
    const tk = (a || []).find((t) => t.t === "str");
    return tk ? tk.v : "";
  };

  // isMemberOfAnyGroup("00g1", "00g2", ...) -> one member_id leaf, or an OR
  // group of member_id leaves when multiple IDs are supplied (logically equivalent).
  if (name === "isMemberOfAnyGroup") {
    const ids = args.map(firstStr).filter(Boolean);
    if (ids.length === 0) return null;
    const makeLeaf = (id) => {
      const l = newLeaf();
      l.type = "group";
      l.op = negated ? "notmember_id" : "member_id";
      l.value = id;
      return l;
    };
    if (ids.length === 1) return makeLeaf(ids[0]);
    // Multiple IDs: "any" == OR of memberships. A negated "any" means "none of",
    // i.e. NOT-member of each, joined by AND (De Morgan).
    return {
      id: uid(),
      kind: "group",
      join: negated ? "AND" : "OR",
      children: ids.map(makeLeaf),
      _sealed: true,
    };
  }

  // Group membership
  if (name === "isMemberOfGroupName") {
    const leaf = newLeaf();
    leaf.type = "group";
    leaf.op = negated ? "notmember" : "member";
    leaf.value = firstStr(args[0]);
    return leaf;
  }
  if (name === "isMemberOfGroup") {
    const leaf = newLeaf();
    leaf.type = "group";
    leaf.op = negated ? "notmember_id" : "member_id";
    leaf.value = firstStr(args[0]);
    return leaf;
  }
  if (name === "isMemberOfGroupNameStartsWith") {
    const leaf = newLeaf();
    leaf.type = "group";
    leaf.op = negated ? "notstartswith" : "startswith";
    leaf.value = firstStr(args[0]);
    return leaf;
  }

  // String.* helpers -> profile leaves
  if (name === "String.startsWith") {
    const attrTok = (args[0] || []).find((t) => t.t === "id");
    const leaf = newLeaf();
    leaf.type = "profile";
    leaf.op = "sw";
    applyAttr(leaf, attrTok ? attrTok.v : "");
    leaf.value = firstStr(args[1]);
    return leaf;
  }
  // String.endsWith is NOT supported in Okta EL. It no longer has a UI control,
  // so return null -> the caller preserves it as an editable "Raw EL" row and
  // surfaces it as a warning, rather than silently dropping it.
  if (name === "String.endsWith") {
    return null;
  }
  if (name === "String.stringContains") {
    // could be the "contains" pattern (with toLowerCase) or the "present" pattern.
    const inner0 = args[0] || [];
    const val = firstStr(args[1]);
    // "present" pattern generates: String.stringContains(attr, "") || attr != null
    // Here we only see the stringContains part; empty value => treat as contains "".
    // Detect toLowerCase wrapper to extract attr
    const idTok = inner0.find((t) => t.t === "id" && t.v !== "String.toLowerCase");
    const leaf = newLeaf();
    leaf.type = "profile";
    leaf.op = "contains";
    applyAttr(leaf, idTok ? idTok.v : "");
    leaf.value = val;
    return leaf;
  }
  if (name === "String.toLowerCase") {
    // shouldn't appear standalone; treat as raw
    return null;
  }
  if (name === "String.isNullOrEmpty") {
    const attrTok = (args[0] || []).find((t) => t.t === "id");
    const leaf = newLeaf();
    leaf.type = "profile";
    leaf.op = "empty";
    applyAttr(leaf, attrTok ? attrTok.v : "");
    return leaf;
  }
  return null;
}

// Clean helper flags off a parsed tree and ensure the root is a group.
function normalizeParsed(node) {
  if (!node) return null;
  // Groups built during parsing (mergeJoin, the parenthesis branch) are plain
  // object literals with no id. Without one, every such node shares id ===
  // undefined, so updateNode/removeNode match the first undefined-id node (the
  // root) instead of the intended one, wiping unrelated logic. Guarantee a
  // unique id on every parsed node here.
  if (node.id == null) node.id = uid();
  if (node.kind === "group") {
    delete node._sealed;
    node.children = node.children.map(normalizeParsed).filter(Boolean);
    return node;
  }
  return node;
}

// Replace human-friendly operator words with their EL symbols, but only outside
// of quoted strings (so a value like "equals" is never rewritten). Applied when
// the user clicks "Parse & preview".
function normalizeELText(src) {
  const replacements = [
    [/\bdoes\s+not\s+equal\b/gi, "!="],
    [/\bnot\s+equals?\b/gi, "!="],
    [/\bequals\b/gi, "=="],
    [/\bequal\b/gi, "=="],
    // Logical NOT written as a word before a function/identifier, e.g.
    // "AND not isMemberOfAnyGroup(...)" -> "AND !isMemberOfAnyGroup(...)".
    // Runs after the equality rules above so it never swallows "not equal".
    // The trailing lookahead ensures we only rewrite "not" that negates an
    // expression (followed by a letter/underscore or "("), not a bare word.
    [/\bnot\s+(?=[A-Za-z_(])/gi, "!"],
  ];
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'") {
      // copy the quoted string verbatim
      const q = c;
      let j = i + 1;
      out += c;
      while (j < n) {
        out += src[j];
        if (src[j] === "\\" && j + 1 < n) { out += src[j + 1]; j += 2; continue; }
        if (src[j] === q) { j++; break; }
        j++;
      }
      i = j;
    } else {
      // accumulate a run of non-quoted text, then apply replacements to it
      let j = i;
      while (j < n && src[j] !== '"' && src[j] !== "'") j++;
      let segment = src.slice(i, j);
      for (const [re, rep] of replacements) segment = segment.replace(re, rep);
      out += segment;
      i = j;
    }
  }
  return out;
}

// Top-level parse: EL string -> root group node. Returns {root, warnings}.
function parseEL(src) {
  const trimmed = normalizeELText((src || "").trim());
  if (!trimmed) return { root: null, error: "Expression is empty." };
  try {
    const toks = tokenizeEL(trimmed);
    let ast = parseELtoAST(toks);
    ast = normalizeParsed(ast);
    if (!ast) return { root: null, error: "Could not parse the expression." };
    // Ensure root is a group so the builder can render it.
    let root;
    if (ast.kind === "group") root = ast;
    else root = { id: uid(), kind: "group", join: "AND", children: [ast] };
    // Collect any raw (unrecognised) leaves as warnings.
    const raws = [];
    const scan = (nd) => {
      if (nd.kind === "group") nd.children.forEach(scan);
      else if (nd._raw) raws.push(nd._raw);
    };
    scan(root);
    return { root, warnings: raws };
  } catch (err) {
    return { root: null, error: "Parse error: " + (err && err.message ? err.message : String(err)) };
  }
}

/* ===========================================================================
   UI — theme + view builders (vanilla DOM)
=========================================================================== */

//Set Colors for the UI Theme
const C = {
  bg: "#ffffff",
  panel: "#ffffff",
  panel2: "#E4EDFA",
  border: "#000000",
  text: "#000000",
  dim: "#324548",
  and: "#0066FF",
  or: "#ff6f0f",
  red_accent: "#ffc4c4",
  accent: "#2EEDED",
  output: "#c1ecf9",
  outputtext: "#000000",
};

const selStyle = {
  background: C.panel2,
  color: C.text,
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  padding: "8px 10px",
  fontSize: 13,
  outline: "none",
};

/* ---- Application state -----------------------------------------------------
   A single mutable state object drives a full re-render on every change,
   mirroring the behavior of the original React version.
--------------------------------------------------------------------------- */
const state = {
  tab: "build", // "build" | "import"
  root: newGroup("AND", [
    Object.assign(newLeaf(), { attr: "user.department", value: "Engineering" }),
    Object.assign(newLeaf(), { type: "group", op: "member", value: "Contractors" }),
  ]),
  copied: false,
  import: {
    text: "",
    result: null, // {root, warnings} | {error}
  },
};

let _copyTimer = null;

function setState(patch) {
  Object.assign(state, patch);
  render();
}

/* ---- Immutable tree updates (so re-renders reflect changes) --------------- */
// Replace the node with a given id anywhere in the tree, using updater(node)->newNode.
function updateNode(root, id, updater) {
  if (root.id === id) return updater(root);
  if (root.kind === "group") {
    return { ...root, children: root.children.map((c) => updateNode(c, id, updater)) };
  }
  return root;
}
// Remove the node with a given id from its parent's children.
function removeNode(root, id) {
  if (root.kind !== "group") return root;
  return {
    ...root,
    children: root.children
      .filter((c) => c.id !== id)
      .map((c) => (c.kind === "group" ? removeNode(c, id) : c)),
  };
}

function patchNode(id, patch) {
  setState({ root: updateNode(state.root, id, (n) => ({ ...n, ...patch })) });
}
function deleteNode(id) {
  setState({ root: removeNode(state.root, id) });
}

/* ---- View: Join toggle (AND / OR) ----------------------------------------- */
function JoinToggle(node) {
  return h(
    "div",
    {
      style: {
        display: "inline-flex", borderRadius: 8, overflow: "hidden",
        border: `1px solid ${C.border}`, fontSize: 12, fontWeight: 700,
        letterSpacing: "0.5px",
      },
    },
    ["AND", "OR"].map((j) => {
      const active = node.join === j;
      const col = j === "AND" ? C.and : C.or;
      return h(
        "button",
        {
          onClick: () => patchNode(node.id, { join: j }),
          style: {
            padding: "5px 14px", border: "none", cursor: "pointer",
            background: active ? col : "transparent",
            color: active ? "#ffffff" : C.dim, transition: "all .15s",
          },
        },
        j
      );
    })
  );
}

/* ---- View: Leaf condition -------------------------------------------------- */
function Leaf(node, canRemove) {
  const hideValue =
    node.type === "profile" && ["present", "empty", "istrue", "isfalse"].includes(node.op);

  if (node._raw !== undefined) {
    return h(
      "div",
      {
        style: {
          display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
          background: C.panel, border: `1px solid #7a5a1e`, borderRadius: 10,
          padding: "10px 12px",
        },
      },
      h(
        "span",
        {
          title: "This fragment couldn't be mapped to a UI control. Edit it as raw Okta EL.",
          style: {
            fontSize: 10, fontWeight: 700, letterSpacing: "0.5px", color: "#e0b050",
            background: "#3a2f10", border: "1px solid #7a5a1e", borderRadius: 6,
            padding: "3px 7px", textTransform: "uppercase",
          },
        },
        "Raw EL"
      ),
      h("input", {
        value: node._raw,
        onInput: (e) => patchNodeNoRender(node.id, { _raw: e.target.value }),
        style: {
          ...selStyle, flex: 1, minWidth: 220,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        },
      }),
      canRemove &&
        h(
          "button",
          {
            onClick: () => deleteNode(node.id),
            title: "Remove condition",
            style: { background: "transparent", border: "none", cursor: "pointer", color: C.dim, display: "flex", padding: 4 },
          },
          IconX(16)
        )
    );
  }

  const typeSwitch = h(
    "div",
    { style: { display: "inline-flex", borderRadius: 8, overflow: "hidden", border: `1px solid ${C.border}` } },
    h(
      "button",
      {
        onClick: () => patchNode(node.id, { type: "profile", op: "eq" }),
        style: {
          display: "flex", alignItems: "center", gap: 5, padding: "7px 10px",
          border: "none", cursor: "pointer", fontSize: 12,
          background: node.type === "profile" ? C.accent : "transparent",
          color: node.type === "profile" ? "#04231b" : C.dim, fontWeight: 600,
        },
      },
      IconUser(13), " Profile"
    ),
    h(
      "button",
      {
        onClick: () => patchNode(node.id, { type: "group", op: "member" }),
        style: {
          display: "flex", alignItems: "center", gap: 5, padding: "7px 10px",
          border: "none", cursor: "pointer", fontSize: 12,
          background: node.type === "group" ? C.accent : "transparent",
          color: node.type === "group" ? "#04231b" : C.dim, fontWeight: 600,
        },
      },
      IconLayers(13), " Group"
    )
  );

  let controls;
  if (node.type === "profile") {
    const attrSelect = h(
      "select",
      {
        onChange: (e) => {
          const newAttr = e.target.value;
          const patch = { attr: newAttr };
          // The boolean ops only make sense for a custom attribute (none of the
          // built-in PROFILE_ATTRS are booleans) — fall back to "equals" so the
          // select doesn't silently keep a now-hidden option selected.
          if (newAttr !== "__custom__" && (node.op === "istrue" || node.op === "isfalse")) {
            patch.op = "eq";
          }
          patchNode(node.id, patch);
        },
        style: selStyle,
      },
      PROFILE_ATTRS.map((a) =>
        h("option", { value: a.value, selected: node.attr === a.value }, a.label)
      )
    );
    const opSelect = h(
      "select",
      { onChange: (e) => patchNode(node.id, { op: e.target.value }), style: selStyle },
      STRING_OPS.filter((o) => !o.customOnly || node.attr === "__custom__").map((o) =>
        h("option", { value: o.value, selected: node.op === o.value }, o.label)
      )
    );
    const isSubstr = node.op === "substr_eq" || node.op === "substr_neq";
    const substrControls = isSubstr
      ? h(
          "span",
          { style: { display: "inline-flex", alignItems: "center", gap: 6 } },
          h("span", { style: { fontSize: 12, color: C.dim } }, "from"),
          h("input", {
            type: "number",
            title: "Start index (0-based, inclusive)",
            placeholder: "start",
            value: node.substrStart,
            onInput: (e) => patchNodeNoRender(node.id, { substrStart: e.target.value }),
            style: { ...selStyle, width: 66 },
          }),
          h("span", { style: { fontSize: 12, color: C.dim } }, "to"),
          h("input", {
            type: "number",
            title: "End index (exclusive). Leave blank to read to the end of the string.",
            placeholder: "end",
            value: node.substrEnd,
            onInput: (e) => patchNodeNoRender(node.id, { substrEnd: e.target.value }),
            style: { ...selStyle, width: 66 },
          })
        )
      : null;

    controls = [
      attrSelect,
      node.attr === "__custom__" &&
        h("input", {
          placeholder: "user.customField",
          value: node.customAttr,
          onInput: (e) => patchNodeNoRender(node.id, { customAttr: e.target.value }),
          style: { ...selStyle, width: 150 },
        }),
      opSelect,
      substrControls,
      !hideValue &&
        h("input", {
          placeholder: "value",
          value: node.value,
          onInput: (e) => patchNodeNoRender(node.id, { value: e.target.value }),
          style: { ...selStyle, width: 150 },
        }),
    ];
  } else {
    const opSelect = h(
      "select",
      { onChange: (e) => patchNode(node.id, { op: e.target.value }), style: selStyle },
      GROUP_OPS.map((o) =>
        h("option", { value: o.value, selected: node.op === o.value }, o.label)
      )
    );
    controls = [
      opSelect,
      h("input", {
        placeholder:
          node.op === "member_id" || node.op === "notmember_id"
            ? "Group ID (00g…)"
            : node.op === "startswith" || node.op === "notstartswith"
            ? "Group name prefix"
            : "Group name",
        value: node.value,
        onInput: (e) => patchNodeNoRender(node.id, { value: e.target.value }),
        style: { ...selStyle, width: 190 },
      }),
    ];
  }

  return h(
    "div",
    {
      style: {
        display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
        background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10,
        padding: "10px 12px",
      },
    },
    typeSwitch,
    controls,
    h("div", { style: { flex: 1 } }),
    canRemove &&
      h(
        "button",
        {
          onClick: () => deleteNode(node.id),
          title: "Remove condition",
          style: { background: "transparent", border: "none", cursor: "pointer", color: C.dim, display: "flex", padding: 4 },
        },
        IconX(16)
      )
  );
}

/* ---- View: Group (recursive) ---------------------------------------------- */
function Group(node, depth, canRemove) {
  const barColor = node.join === "AND" ? C.and : C.or;

  const header = h(
    "div",
    { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 10 } },
    JoinToggle(node),
    h(
      "span",
      { style: { color: C.dim, fontSize: 12 } },
      "match " + (node.join === "AND" ? "all" : "any") + " of the following"
    ),
    h("div", { style: { flex: 1 } }),
    canRemove &&
      h(
        "button",
        {
          onClick: () => deleteNode(node.id),
          style: {
            background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6,
            cursor: "pointer", color: C.dim, fontSize: 11, padding: "4px 8px",
          },
        },
        "Remove Logic"
      )
  );

  const childList = h(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: 8 } },
    node.children.map((child) =>
      child.kind === "group"
        ? Group(child, depth + 1, true)
        : Leaf(child, node.children.length > 1 || depth > 0)
    )
  );

  const actions = h(
    "div",
    { style: { display: "flex", gap: 8, marginTop: 10 } },
    h(
      "button",
      {
        onClick: () =>
          patchNode(node.id, { children: [...node.children, newLeaf()] }),
        style: {
          display: "flex", alignItems: "center", gap: 6, background: C.panel2,
          color: C.text, border: `1px solid ${C.border}`, borderRadius: 8,
          cursor: "pointer", fontSize: 12, padding: "7px 12px",
        },
      },
      IconPlus(14), " Condition"
    ),
    h(
      "button",
      {
        onClick: () =>
          patchNode(node.id, {
            children: [...node.children, newGroup(node.join === "AND" ? "OR" : "AND")],
          }),
        style: {
          display: "flex", alignItems: "center", gap: 6, background: "transparent",
          color: C.dim, border: `1px dashed ${C.border}`, borderRadius: 8,
          cursor: "pointer", fontSize: 12, padding: "7px 12px",
        },
      },
      IconFolderTree(14), " Nested logic"
    )
  );

  return h(
    "div",
    {
      style: {
        borderLeft: depth > 0 ? `2px solid ${barColor}` : "none",
        paddingLeft: depth > 0 ? 14 : 0,
        marginTop: depth > 0 ? 4 : 0,
      },
    },
    header,
    childList,
    actions
  );
}

/* ---- View: Builder panel --------------------------------------------------- */
function BuilderPanel() {
  const expression = generateEL(state.root);

  const copy = () => {
    if (!expression) return;
    if (navigator.clipboard) navigator.clipboard.writeText(expression);
    setState({ copied: true });
    if (_copyTimer) clearTimeout(_copyTimer);
    _copyTimer = setTimeout(() => setState({ copied: false }), 1500);
  };

  return h(
    "div",
    null,
    h(
      "div",
      {
        style: {
          background: C.panel, border: `1px solid ${C.border}`,
          borderRadius: 14, padding: 18,
        },
      },
      Group(state.root, 0, false)
    ),
    h(
      "div",
      { style: { marginTop: 20 } },
      h(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 } },
        h(
          "span",
          { style: { fontSize: 12, textTransform: "uppercase", letterSpacing: "1px", color: C.dim, fontWeight: 600 } },
          "Okta Expression Language"
        ),
        h(
          "button",
          {
            onClick: copy,
            disabled: !expression,
            style: {
              display: "flex", alignItems: "center", gap: 6,
              background: state.copied ? C.accent : C.panel2,
              color: state.copied ? "#c6ebff" : C.text,
              border: `1px solid ${C.border}`, borderRadius: 8,
              cursor: expression ? "pointer" : "not-allowed",
              opacity: expression ? 1 : 0.5, fontSize: 12, padding: "7px 12px", fontWeight: 600,
            },
          },
          state.copied ? IconCheck(14) : IconCopy(14),
          state.copied ? "Copied" : "Copy"
        ),
      ),
      h(
        "p",
        { style: { color: C.dim, fontSize: 11, marginTop: 8, lineHeight: 1.5 } },
        "PLEASE NOTE: this is a Beta feature. Verify with the Okta Expression Language preview before activating."
      ),
      h(
        "pre",
        {
          style: {
            background: C.output, border: `1px solid ${C.border}`, borderRadius: 12,
            padding: 16, margin: 0, fontSize: 14, lineHeight: 1.6,
            color: expression ? C.outputtext : C.dim,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            whiteSpace: "pre-wrap", wordBreak: "break-word", minHeight: 24,
          },
        },
        expression || "// Complete the conditions to generate an expression"
      ),
      h(
        "p",
        { style: { color: C.dim, fontSize: 10, marginTop: 8, lineHeight: 1.5 } },
        "Okta Rule Builder tool contributed by Tim McWeeny"
      )
    )
  );
}

/* ---- View: Import panel ---------------------------------------------------- */
function ImportPanel() {
  const result = state.import.result;
  const ok = result && result.root;

  const preview = () => {
    setState({ import: { ...state.import, result: parseEL(state.import.text) } });
  };
  const load = () => {
    const r = result || parseEL(state.import.text);
    if (r && r.root) {
      setState({ root: r.root, tab: "build" });
    }
  };

  const children = [
    h(
      "div",
      {
        style: {
          background: C.panel, border: `1px solid ${C.border}`,
          borderRadius: 14, padding: 18,
        },
      },
      h(
        "label",
        {
          style: {
            display: "block", fontSize: 12, textTransform: "uppercase",
            letterSpacing: "1px", color: C.dim, fontWeight: 600, marginBottom: 8,
          },
        },
        "Paste an Okta Expression"
      ),
      h("textarea", {
        value: state.import.text,
        onInput: (e) => {
          // update text without full re-render (preserves focus/caret),
          // but clear any stale result marker in state silently
          state.import.text = e.target.value;
          state.import.result = null;
          syncImportButtons();
        },
        placeholder: 'e.g. (user.department == "Engineering" AND isMemberOfGroupName("Contractors"))',
        spellcheck: false,
        style: {
          width: "100%", boxSizing: "border-box", minHeight: 120,
          background: C.panel2, color: C.text, border: `1px solid ${C.border}`,
          borderRadius: 12, padding: 14, fontSize: 14, lineHeight: 1.6,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          outline: "none", resize: "vertical",
        },
      }),
      h(
        "div",
        { style: { display: "flex", gap: 8, marginTop: 12 } },
        h(
          "button",
          {
            id: "btn-preview",
            onClick: preview,
            disabled: !state.import.text.trim(),
            style: {
              display: "flex", alignItems: "center", gap: 6, background: C.and,
              color: "#ffffff", border: `1px solid ${C.border}`, borderRadius: 8,
              cursor: state.import.text.trim() ? "pointer" : "not-allowed",
              opacity: state.import.text.trim() ? 1 : 0.5, fontSize: 12,
              padding: "8px 14px", fontWeight: 600,
            },
          },
          "Parse & preview"
        ),
        h(
          "button",
          {
            id: "btn-load",
            onClick: load,
            disabled: !ok,
            style: {
              display: "flex", alignItems: "center", gap: 6,
              background: ok ? C.accent : C.panel2, color: ok ? "#000000" : C.dim,
              border: `1px solid ${C.border}`, borderRadius: 8,
              cursor: ok ? "pointer" : "not-allowed", opacity: ok ? 1 : 0.6,
              fontSize: 12, padding: "8px 14px", fontWeight: 700,
            },
          },
          IconCheck(14), " Load into builder"
        )
      )
    ),
  ];

  if (result && result.error) {
    children.push(
      h(
        "div",
        {
          style: {
            marginTop: 16, background: "#3a1414", border: "1px solid #7a2b2b",
            borderRadius: 12, padding: 14, color: "#f0a5a5", fontSize: 13,
          },
        },
        result.error
      )
    );
  }

  if (ok) {
    const block = [];
    if (result.warnings && result.warnings.length > 0) {
      block.push(
        h(
          "div",
          {
            style: {
              background: "#c03b3b", border: "1px solid #ff9d9d", borderRadius: 5,
              padding: 14, color: "#ffffff", fontSize: 14, lineHeight: 1.5, marginBottom: 12,
            },
          },
          result.warnings.length + " fragment" + (result.warnings.length > 1 ? "s" : "") +
            " couldn't be mapped to a UI control and will load as editable “Raw EL” rows. Everything else parsed cleanly."
        )
      );
    }
    block.push(
      h(
        "span",
        { style: { fontSize: 12, textTransform: "uppercase", letterSpacing: "1px", color: C.dim, fontWeight: 600 } },
        "Re-generated expression (round-trip check)"
      ),
      h(
        "pre",
        {
          style: {
            background: C.output, border: `1px solid ${C.border}`, borderRadius: 12,
            padding: 16, marginTop: 8, fontSize: 14, lineHeight: 1.6, color: C.outputtext,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            whiteSpace: "pre-wrap", wordBreak: "break-word",
          },
        },
        generateEL(result.root)
      ),
      h(
        "p",
        { style: { color: C.dim, fontSize: 11, marginTop: 8, lineHeight: 1.5 } },
        "Compare this against your original — formatting (spacing, redundant parentheses) may differ, but the logic should match. Click “Load into builder” to edit it on the Builder tab."
      )
    );
    children.push(h("div", { style: { marginTop: 16 } }, block));
  }

  return h("div", null, children);
}

/* ---- Focus-preserving helpers for text inputs -----------------------------
   Text inputs update state in place (no re-render) so the caret doesn't jump.
   The live expression preview is refreshed manually on each keystroke.
--------------------------------------------------------------------------- */
function patchNodeNoRender(id, patch) {
  state.root = updateNode(state.root, id, (n) => ({ ...n, ...patch }));
  refreshExpressionPreview();
}

function refreshExpressionPreview() {
  if (state.tab !== "build") return;
  const pre = _mountRoot.querySelector("#el-output");
  if (!pre) return;
  const expression = generateEL(state.root);
  pre.textContent = expression || "// Complete the conditions to generate an expression";
  pre.style.color = expression ? C.outputtext : C.dim;
  const copyBtn = _mountRoot.querySelector("#copy-btn");
  if (copyBtn) {
    copyBtn.disabled = !expression;
    copyBtn.style.cursor = expression ? "pointer" : "not-allowed";
    copyBtn.style.opacity = expression ? "1" : "0.5";
  }
}

function syncImportButtons() {
  const hasText = !!state.import.text.trim();
  const prev = _mountRoot.querySelector("#btn-preview");
  if (prev) {
    prev.disabled = !hasText;
    prev.style.cursor = hasText ? "pointer" : "not-allowed";
    prev.style.opacity = hasText ? "1" : "0.5";
  }
  const load = _mountRoot.querySelector("#btn-load");
  if (load) {
    load.disabled = true; // result was cleared on edit
    load.style.cursor = "not-allowed";
    load.style.opacity = "0.6";
    load.style.background = C.panel2;
    load.style.color = C.dim;
  }
}

/* ---- Root render ----------------------------------------------------------- */
function TabBtn(id, label) {
  const active = state.tab === id;
  return h(
    "button",
    {
      onClick: () => setState({ tab: id }),
      style: {
        padding: "9px 18px", border: "none", cursor: "pointer",
        background: active ? C.panel : "transparent",
        color: active ? C.text : C.dim,
        borderBottom: active ? `2px solid ${C.accent}` : "2px solid transparent",
        fontSize: 13, fontWeight: 600, letterSpacing: "0.3px",
      },
    },
    label
  );
}

function App() {
  return h(
    "div",
    {
      style: {
        fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
        background: C.bg, color: C.text, minHeight: "100%", padding: 24,
      },
    },
    h(
      "div",
      { style: { maxWidth: 880, margin: "0 auto" } },
      h(
        "div",
        { style: { marginBottom: 20 } },
        h("h1", { style: { fontSize: 22, margin: 0, fontWeight: 700 } }, "Okta Rule Builder (beta)"),
        h(
          "p",
          { style: { color: C.dim, fontSize: 13, margin: "4px 0 0" } },
          "Compose AND / OR conditions on user profile attributes and group membership, or import an existing expression to edit it."
        ),
      ),
      h(
        "div",
        { style: { display: "flex", gap: 4, borderBottom: `1px solid ${C.border}`, marginBottom: 20 } },
        TabBtn("build", "Builder"),
        TabBtn("import", "Import expression")
      ),
      state.tab === "build" ? BuilderPanel() : ImportPanel()
    )
  );
}

function render() {
  const rootEl = _mountRoot;
  if (!rootEl) return;
  rootEl.textContent = "";
  rootEl.appendChild(App());
  // tag the live-preview nodes so keystroke updates can find them
  if (state.tab === "build") {
    const pres = rootEl.querySelectorAll("pre");
    if (pres[0]) pres[0].id = "el-output";
    const copyBtns = rootEl.querySelectorAll("button");
    copyBtns.forEach((b) => {
      if (b.textContent.includes("Copy") || b.textContent.includes("Copied")) b.id = "copy-btn";
    });
  }
}

  // Initial mount into the provided container.
  render();

  // Return a handle the host (e.g. rockstar) can use to drive the builder as
  // an inline editor: seed it from an existing expression, read the current
  // expression back out, or re-render.
  return {
    render,
    get state() { return state; },
    // Current Okta Expression Language string for the built tree.
    getExpression() { return generateEL(state.root); },
    // Load an existing expression string into the builder UI.
    // Returns {ok, warnings, error}.
    loadExpression(src) {
      const r = parseEL(src || "");
      if (r && r.root) {
        setState({ root: r.root, tab: "build" });
        return { ok: true, warnings: r.warnings || [] };
      }
      return { ok: false, error: (r && r.error) || "Could not parse expression" };
    },
    // Drop a raw expression string into the "Import expression" tab's textarea,
    // switch to that tab, and immediately parse it so the preview and
    // "Load into builder" button are ready without a manual "Parse & preview"
    // click. Returns {ok, warnings, error} describing the parse outcome.
    importExpressionText(src) {
      const text = src || "";
      const result = text.trim() ? parseEL(text) : null;
      setState({
        tab: "import",
        import: { text, result },
      });
      if (result && result.root) return { ok: true, warnings: result.warnings || [] };
      if (result && result.error) return { ok: false, error: result.error };
      return { ok: true, warnings: [] };
    },
  };
} // end createGroupRuleBuilder

if (typeof window !== "undefined") window.createGroupRuleBuilder = createGroupRuleBuilder;
