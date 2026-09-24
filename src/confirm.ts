/** Text the operator must retype before a fabric is removed. */
export function fabricRemovalConfirmation(fabric: { fabricIndex: number; label: string }): string {
  return fabric.label.length > 0 ? fabric.label : String(fabric.fabricIndex);
}
