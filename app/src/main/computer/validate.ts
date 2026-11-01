/** Revalidate in the authority, even when the engine's own schema checker already ran. No coercion here. */
export function validateOperation(schema: any, value: any, at = 'arguments'): void {
  if (Array.isArray(schema.type)) {
    return validateOperation({ ...schema, type: undefined, anyOf: schema.type.map((type: string) => ({ ...schema, type })) }, value, at);
  }
  if (schema.anyOf) {
    if (!schema.anyOf.some((branch: any) => { try { validateOperation(branch, value, at); return true; } catch { return false; } })) throw new Error(`${at} has an invalid value`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${at} is not an allowed value`);
  if (schema.type === 'null') { if (value !== null) throw new Error(`${at} must be null`); return; }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${at} must be an object`);
    for (const key of schema.required || []) if (value[key] === undefined) throw new Error(`${at}.${key} is required`);
    for (const [key, child] of Object.entries(value)) {
      if (!schema.properties?.[key]) { if (schema.additionalProperties === false) throw new Error(`${at}.${key} is unknown`); }
      else validateOperation(schema.properties[key], child, `${at}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems || 0) || value.length > (schema.maxItems ?? 2000)) throw new Error(`${at} has an invalid array length`);
    for (const child of value) if (schema.items) validateOperation(schema.items, child, at);
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value)) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) throw new Error(`${at} has an invalid number`);
  } else if (schema.type && typeof value !== schema.type) throw new Error(`${at} must be ${schema.type}`);
  if (typeof value === 'string' && value.length > 16000) throw new Error(`${at} exceeds 16000 characters`);
}
