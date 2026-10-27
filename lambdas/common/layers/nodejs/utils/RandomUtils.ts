import { randomBytes } from "crypto";

const ALPHABET_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// Example output : 7FdEw8N2mP5sZ1xY6rT8bV3ak
export function generateRandomSecureString(length : number) {
  let result : string = '';  
  while (result.length < length) {
    // Extract a cryptographically safe random value in the range of 0-255
    const byte = randomBytes(1)[0];
    // A condition to remove Modulo Bias
    // If the value is under 248, pick a value that is the closest to 256
    // while being a multiple of 62 (the length of ALPHABET_CHARS)
    if (byte < 248) {
      result += ALPHABET_CHARS[byte % ALPHABET_CHARS.length];
    }
  }
  return result;
}