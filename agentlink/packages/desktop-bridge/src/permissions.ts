import type { Message } from "./ipc";

/** The device owner chose native Full Access for messages sent through Argus. */
export const sendingDefaults = { permissionMode: "full-access", approvalsReviewer: "user" } as const;
export const fullAccessThreadStart = { approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access" } as const;

// A named profile and sandboxPolicy are mutually exclusive in thread/settings/update.
export function fullAccessThreadSettings(): Message {
  return { approvalPolicy: "never", approvalsReviewer: "user", permissions: ":danger-full-access" };
}

export function permissionView(value: Message | null | undefined): Message | null {
  if (!value) return null;
  const profile = value.activePermissionProfile?.id ?? value.permissions ?? null;
  const sandbox = value.sandboxPolicy?.type ?? null;
  return { profile, sandbox, approvalPolicy: value.approvalPolicy ?? null, approvalsReviewer: value.approvalsReviewer ?? null,
    fullAccess: (profile === ":danger-full-access" || sandbox === "dangerFullAccess") && value.approvalPolicy === "never" };
}
