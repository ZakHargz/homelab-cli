import { loadHomelab } from "../loader";
import { validateHomelab, formatValidationIssues } from "../validator";
import { canDecrypt } from "../secrets";

export interface ValidateOptions {
  root: string;
  appName?: string;
}

/** `homelab app validate [name]` — schema + cross-app checks, no side effects. */
export async function validate({ root, appName }: ValidateOptions): Promise<boolean> {
  const loaded = await loadHomelab(root); // throws with formatted message on schema errors
  const result = await validateHomelab(loaded, {
    onlyApp: appName,
    checkSecrets: (envFrom) => canDecrypt(root, envFrom),
  });

  console.log(formatValidationIssues(result));
  return result.ok;
}