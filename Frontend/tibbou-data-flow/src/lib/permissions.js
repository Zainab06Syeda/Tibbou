// Single source of truth for role -> capability permissions, shared with the
// backend (see Backend/app/permissions.py). Frontend checks here are UX only
// -- every capability is re-enforced server-side.
import permissionMatrix from "../../../../Database/permissions.json";

export function hasPermission(role, capability) {
  const allowedRoles = permissionMatrix.capabilities[capability];
  if (!allowedRoles) {
    throw new Error(`Unknown permission capability: ${capability}`);
  }
  return allowedRoles.includes(role);
}

export function allowedRolesFor(capability) {
  const allowedRoles = permissionMatrix.capabilities[capability];
  if (!allowedRoles) {
    throw new Error(`Unknown permission capability: ${capability}`);
  }
  return allowedRoles;
}
