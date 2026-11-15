/** What om calls itself on the wire, so the registry's access log can tell om clients (and their OS) from anything else. Bump with each om release. */
export const OM_VERSION = "0.3.0-experimental.6";
const OS_TOKEN: Record<string, string> = { win32: "Windows NT 10.0", darwin: "Macintosh", linux: "Linux" };
export const userAgent = (platform: string = process.platform) => `om/${OM_VERSION} (${OS_TOKEN[platform] ?? platform})`;
