import type { IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";
import type { Authenticator } from "./types";

const normFp = (s: string) => s.replace(/:/g, "").toUpperCase();

/**
 * Client-certificate login. The TLS layer has already verified the chain against the configured CA (socket.authorized);
 * this only decides which verified certificates may administer: `allow` lists subject CNs or SHA-256 fingerprints.
 * An empty allowlist admits nobody (a valid cert alone is not authorisation).
 */
export function mtlsAuthenticator(allow: string[]): Authenticator {
  const names = new Set(allow.filter((a) => !/^[0-9a-fA-F:]{64,95}$/.test(a)));
  const fps = new Set(allow.filter((a) => /^[0-9a-fA-F:]{64,95}$/.test(a)).map(normFp));
  return {
    authenticate(req: IncomingMessage) {
      const sock = req.socket as TLSSocket;
      if (!sock.encrypted || !sock.authorized) return null;
      const cert = sock.getPeerCertificate();
      if (!cert || !cert.subject) return null;
      const cn = cert.subject.CN;
      const cnStr = Array.isArray(cn) ? cn[0] : cn;
      const fp = cert.fingerprint256 ? normFp(cert.fingerprint256) : "";
      if ((cnStr && names.has(cnStr)) || (fp && fps.has(fp))) return { name: cnStr ?? fp, method: "mtls" };
      return null;
    },
  };
}
