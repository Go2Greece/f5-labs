// Rule evaluator. Lab records in Atlas describe "done" as data; this turns that data into true/false.
//
// Rule shapes:
//   { all: [rule, ...] }                     every rule true
//   { any: [rule, ...] }                     at least one rule true
//   { not: rule }
//   { path: "a.b", equals: value }           value at path equals (strings compared trimmed, case-insensitive)
//   { path: "a.b", in: [v1, v2] }
//   { path: "a.b", includes: value }         array at path contains the value
//   { path: "a.b", some: { f: v, ... } }     array at path has an object matching every field
//   { path: "a.b", none: { f: v, ... } }     array at path has no object matching
//   { path: "a.b", truthy: true }

export function getPath(obj, path) {
  let cur = obj;
  for (const key of String(path).split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[key];
  }
  return cur;
}

// Values are compared as trimmed, case-insensitive text, so 100 and "100" are the same.
function norm(v) {
  if (v === null || v === undefined || typeof v === "object") return v;
  return String(v).trim().toLowerCase();
}

function same(a, b) {
  return norm(a) === norm(b);
}

function matches(item, pattern) {
  if (!item || typeof item !== "object") return false;
  return Object.keys(pattern).every((k) => same(item[k], pattern[k]));
}

export function evalRule(rule, state) {
  if (!rule || typeof rule !== "object") return false;
  if (Array.isArray(rule.all)) return rule.all.every((r) => evalRule(r, state));
  if (Array.isArray(rule.any)) return rule.any.some((r) => evalRule(r, state));
  if (rule.not) return !evalRule(rule.not, state);
  if (!rule.path) return false;
  const value = getPath(state, rule.path);
  if ("equals" in rule) return same(value, rule.equals);
  if (Array.isArray(rule.in)) return rule.in.some((v) => same(value, v));
  if ("includes" in rule) return Array.isArray(value) && value.some((v) => same(v, rule.includes));
  if (rule.some) return Array.isArray(value) && value.some((item) => matches(item, rule.some));
  if (rule.none) return !Array.isArray(value) || !value.some((item) => matches(item, rule.none));
  if (rule.truthy) return Boolean(value);
  return false;
}
