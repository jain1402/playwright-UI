function isEmptyFieldValue(field) {
  const value = field.currentValue;
  if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) return true;
  if ((field.role === 'radio' || field.role === 'checkbox') && value === false) return true;

  const normalizedValue = String(value).replace(/\s+/g, ' ').trim();
  const normalizedPlaceholder = String(field.placeholder || '').replace(/\s+/g, ' ').trim();
  if (normalizedPlaceholder && normalizedValue.toLowerCase() === normalizedPlaceholder.toLowerCase()) return true;
  if (/^(?:select|choose|please select|please choose|type to search|search)(?:\b|$)/i.test(normalizedValue)) return true;
  if ((field.label || '').trim().toLowerCase() === 'autocomplete') return true;
  return false;
}

function valuesMatch(actual, expected) {
  if (Array.isArray(actual)) return actual.length === 1 && String(actual[0]) === String(expected);
  return actual !== null && actual !== undefined && String(actual) === String(expected);
}

module.exports = { isEmptyFieldValue, valuesMatch };
