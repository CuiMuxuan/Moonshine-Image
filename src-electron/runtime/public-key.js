import { MANIFEST_KEY_ID } from "./manifest-verifier.js";
import {
  EMBEDDED_RELEASE_KEY_ID,
  EMBEDDED_RELEASE_PUBLIC_KEY_PEM,
} from "./release-public-key.generated.js";

/**
 * The release public key is injected at packaging time until the independent
 * production key is frozen. Never place a private key in the application.
 */
export function getRuntimeManifestPublicKeys(env = process.env) {
  const pem = String(
    env.MOONSHINE_MANIFEST_PUBLIC_KEY_PEM || EMBEDDED_RELEASE_PUBLIC_KEY_PEM || "",
  ).trim();
  const keyId = String(
    env.MOONSHINE_MANIFEST_KEY_ID || EMBEDDED_RELEASE_KEY_ID || MANIFEST_KEY_ID,
  ).trim();
  return pem && keyId === MANIFEST_KEY_ID ? { [keyId]: pem } : {};
}

export { MANIFEST_KEY_ID };
