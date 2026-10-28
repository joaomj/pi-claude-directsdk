/**
 * Whether this model supports mid-conversation tool additions and removals.
 * The catalog sets the flag from Anthropic's published model list; nothing is
 * inferred from the model id, so unknown models keep the collapsed shape.
 */
export function supportsNativeToolChanges(compat?: unknown): boolean {
  const explicit = compat as { supportsMidConvoToolChanges?: unknown } | undefined;
  return explicit?.supportsMidConvoToolChanges === true;
}
