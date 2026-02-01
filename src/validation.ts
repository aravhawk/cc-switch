export function validateProfileName(name: string): { valid: boolean; error?: string } {
  if (!name || name.trim().length === 0) {
    return { valid: false, error: 'Profile name cannot be empty' };
  }

  // Check for path traversal and unsafe characters
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    return { valid: false, error: 'Profile name cannot contain "..", "/", or "\\"' };
  }

  // Optional: restrict to safe characters
  if (!/^[A-Za-z0-9-_]+$/.test(name)) {
    return { valid: false, error: 'Profile name can only contain letters, numbers, hyphens, and underscores' };
  }

  return { valid: true };
}
