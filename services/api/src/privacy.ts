/** Spec §12: no IP addresses in any log. */

const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const IPV6 =
  /(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:)*[0-9a-f]{0,4}::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?(?:[0-9.]+)?/gi;
/** Remove anything that looks like an IP address (e.g. from a driver's connection error) before it is logged. */
export const scrubAddresses = (s: string) => s.replace(IPV6, "[addr]").replace(IPV4, "[addr]");
