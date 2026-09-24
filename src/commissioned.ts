/** The one commissioned node that is not yet in the inventory, if that is unambiguous. */
export function unregisteredCommissionedNode(
  commissionedNodeIds: string[],
  registeredNodeIds: Iterable<string>,
): string {
  const registered = new Set(registeredNodeIds);
  const missing = commissionedNodeIds.filter((id) => !registered.has(id));
  if (missing.length === 1) return missing[0]!;
  if (missing.length === 0) {
    throw new Error(
      "This device is already commissioned into this fabric, and the controller has no unregistered node to restore",
    );
  }
  throw new Error(
    `This device is already commissioned into this fabric, and ${missing.length} commissioned nodes are not in the inventory`,
  );
}
