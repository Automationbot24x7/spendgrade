// Minimal JSON-schema validator for the subset Spendgrade uses (object, array,
// string, number, integer, boolean, enum, required, additionalProperties,
// minimum/maximum, minItems/maxItems). Structured outputs are requested from SERV,
// and the result is validated again here at the application boundary.

export function validate(schema, value, path = '$') {
  const errors = [];
  check(schema, value, path, errors);
  return { ok: errors.length === 0, errors };
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function check(s, v, p, errors) {
  if (!s) return;
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : null;
  if (types) {
    const t = typeOf(v);
    const ok = types.some((want) => want === t || (want === 'number' && t === 'integer'));
    if (!ok) {
      errors.push(`${p}: expected ${types.join('|')}, got ${t}`);
      return;
    }
  }
  if (s.enum && !s.enum.includes(v)) errors.push(`${p}: ${JSON.stringify(v)} not in ${JSON.stringify(s.enum)}`);
  if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) errors.push(`${p}: ${v} < minimum ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) errors.push(`${p}: ${v} > maximum ${s.maximum}`);
  }
  if (typeof v === 'string' && s.minLength !== undefined && v.length < s.minLength) {
    errors.push(`${p}: shorter than ${s.minLength}`);
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${p}: fewer than ${s.minItems} items`);
    if (s.maxItems !== undefined && v.length > s.maxItems) errors.push(`${p}: more than ${s.maxItems} items`);
    if (s.items) v.forEach((item, i) => check(s.items, item, `${p}[${i}]`, errors));
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const key of s.required || []) {
      if (!(key in v)) errors.push(`${p}: missing required "${key}"`);
    }
    const props = s.properties || {};
    for (const [key, val] of Object.entries(v)) {
      if (props[key]) check(props[key], val, `${p}.${key}`, errors);
      else if (s.additionalProperties === false) errors.push(`${p}: unexpected property "${key}"`);
    }
  }
}
