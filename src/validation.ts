const RESERVED_PROFILE_NAMES = new Set(['help', 'version']);
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_PROFILE_NAME_LENGTH = 64;

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateProfileName(name: string): ValidationResult {
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

  if (trimmedName.length > MAX_PROFILE_NAME_LENGTH) {
    return { valid: false, error: `Profile name cannot be longer than ${MAX_PROFILE_NAME_LENGTH} characters` };
  }

  // Check for path traversal and unsafe characters
  if (trimmedName.includes('..') || trimmedName.includes('/') || trimmedName.includes('\\')) {
    return { valid: false, error: 'Profile name cannot contain "..", "/", or "\\"' };
  }

  if (!PROFILE_NAME_PATTERN.test(trimmedName)) {
    return { valid: false, error: 'Profile name can only contain letters, numbers, hyphens, and underscores' };
  }

  return { valid: true };
}

export function assertValidProfileName(name: string, label = 'Profile name'): void {
  const result = validateProfileName(name);
  if (!result.valid) {
    throw new Error(label === 'Profile name' ? result.error : `${label}: ${result.error}`);
  }
}
