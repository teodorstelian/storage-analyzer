export const errorKeys = ['reallocatedSectors', 'pendingSectors', 'uncorrectableSectors', 'crcErrors'];
const valid = (v) => Number.isSafeInteger(v) && v >= 0;
export function compareErrors(current, previous) {
  const changes = {};
  for (const key of errorKeys) {
    const value = current?.[key], baseline = previous?.[key];
    if (!valid(value)) continue;
    changes[key] = !valid(baseline) ? { status: 'baseline', delta: null }
      : { status: value < baseline ? 'reset' : value > baseline ? 'increased' : 'unchanged', delta: value - baseline };
  }
  return changes;
}
