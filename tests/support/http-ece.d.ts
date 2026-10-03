/**
 * The one call the push tests make into http_ece, the library web-push
 * encrypts with: decrypting a message as the receiving device would.
 */
declare module "http_ece" {
  import type { ECDH } from "node:crypto";

  export function decrypt(
    buffer: Buffer,
    params: { version: "aes128gcm"; privateKey: ECDH; authSecret: string },
  ): Buffer;
}
