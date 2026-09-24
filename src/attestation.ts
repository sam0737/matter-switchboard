export interface AttestationFinding {
  level: "error" | "warning" | "info";
  type: string;
  message: string;
}

/** Accept info and warning findings. Only error findings stop commissioning. */
export function decideAttestation(
  findings: AttestationFinding[],
  allowBypass: boolean,
): true | string {
  if (allowBypass) return true;
  const blocking = findings.filter((finding) => finding.level === "error");
  if (blocking.length === 0) return true;
  return blocking.map((finding) => `${finding.type}: ${finding.message}`).join("; ");
}
