const RESERVED_PROFILE_NAMES = new Set(['help', 'version']);

export function validateProfileName(name: string): { valid: boolean; error?: string } {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return { valid: false, error: 'Profile name cannot be empty' };
  }

  if (name !== trimmedName) {
    return { valid: false, error: 'Profile name cannot contain leading or trailing spaces' };
  }

  if (RESERVED_PROFILE_NAMES.has(trimmedName.toLowerCase())) {
    return { valid: false, error: `Profile name "${trimmedName}" is reserved. Choose a different name.` };
  }

  // Check for path traversal and unsafe characters
  if (trimmedName.includes('..') || trimmedName.includes('/') || trimmedName.includes('\\')) {
    return { valid: false, error: 'Profile name cannot contain "..", "/", or "\\"' };
  }

  // Optional: restrict to safe characters
  if (!/^[A-Za-z0-9-_]+$/.test(trimmedName)) {
    return { valid: false, error: 'Profile name can only contain letters, numbers, hyphens, and underscores' };
  }

  return { valid: true };
}
