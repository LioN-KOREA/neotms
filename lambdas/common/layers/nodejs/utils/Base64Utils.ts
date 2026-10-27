/* Encode functions */
export function encodeObjectURLSafe(input: Record<string, any>): string {
  const jsonString = JSON.stringify(input);
  return encodeStringURLSafe(jsonString);
}

export function encodeStringURLSafe(str: string): string {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, ''); // Remove padding
}

/* Decode functions */
export function decodeStringURLSafe(base64String: string): string {
  let base64 = base64String.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '='; // Add paddings back if necessary
  }
  return Buffer.from(base64, 'base64').toString('utf8');
}

export function decodeObjectURLSafe(base64String: string): Record<string, any> {
  const jsonString = decodeStringURLSafe(base64String);
  return JSON.parse(jsonString) as Record<string, any>;
}