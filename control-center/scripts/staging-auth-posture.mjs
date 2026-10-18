// Manual, unauthenticated preflight of the existing Cloud Run/IAP topology.
// This never reads cookies, supplies a token, follows redirects or proves owner Safari.
// Run only with explicit service origins and no mutations or deployments.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const SCHEMA = "velvetos.portal.p0.anonymous-auth-posture.v1";
const DEADLINE_MS = 8000;
const STAGING = "velvetos-control-center-staging-3sz7smh74a-zf.a.run.app";
const API = "velvetos-control-api-3sz7smh74a-zf.a.run.app";

export function validateServiceOrigin(raw, role) {
  if (typeof raw !== "string" || raw.length > 220) throw new Error("invalid_service_origin");
  let parsed;
  try { parsed = new URL(raw); }
  catch { throw new Error("invalid_service_origin"); }
  const expectedHostname = role === "staging" ? STAGING : role === "api" ? API : null;
  if (!expectedHostname || parsed.protocol !== "https:" || parsed.port ||
      parsed.username || parsed.password || parsed.pathname !== "/" ||
      parsed.search || parsed.hash || parsed.hostname !== expectedHostname)
    throw new Error("untrusted_service_origin");
  return parsed.origin;
}

async function anonymousGet(url, fetchImpl) {
  const response = await fetchImpl(url, {
    method: "GET", redirect: "manual", cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(DEADLINE_MS),
  });
  // Examine only protocol metadata; never retain raw payload, cookies, or URLs.
  const status = response.status;
  let loginHost = null;
  if (status === 302) {
    try {
      const location = new URL(response.headers.get("location") || "");
      if (location.protocol === "https:" && !location.port)
        loginHost = location.hostname;
    } catch { /* untrusted redirect is not auth proof */ }
  }
  try { await response.body?.cancel(); } catch { /* irrelevant to gate result */ }
  return { status, loginHost };
}

export async function inspectAnonymousBoundary({ stagingUrl, apiUrl, fetchImpl = fetch }) {
  const staging = validateServiceOrigin(stagingUrl, "staging");
  const api = validateServiceOrigin(apiUrl, "api");
  let home, site, health, guarded;
  try {
    [home, site, health, guarded] = await Promise.all([
      anonymousGet(staging + "/", fetchImpl),
      anonymousGet(staging + "/health", fetchImpl),
      anonymousGet(api + "/health", fetchImpl),
      anonymousGet(api + "/v1/snapshot", fetchImpl),
    ]);
  } catch {
    return { schema: SCHEMA, status: "INDETERMINATE", releaseGate: "BLOCKED",
      reason: "network_or_response_unavailable", credentialsSent: false };
  }
  const siteLogin = site.status === 302 && site.loginHost === "accounts.google.com";
  // IAP/Cloud Run can deny a non-browser client with 401/403 rather than
  // issuing an interactive 302 login redirect; both are denial, NOT owner login.
  const homeLogin = home.status === 302 && home.loginHost === "accounts.google.com";
  const homeDenied = homeLogin || home.status === 401 || home.status === 403;
  const healthDenied = siteLogin || site.status === 401 || site.status === 403;
  const siteDenied = homeDenied && healthDenied;
  const guardedRead = guarded.status === 401 || guarded.status === 403;
  const status = siteDenied && health.status === 200 && guardedRead
    ? "PASS_ANONYMOUS_DENIAL_ONLY" : "FAIL_CLOSED_AUTH_BOUNDARY_UNVERIFIED";
  return {
    schema: SCHEMA, status,
    releaseGate: "BLOCKED_OWNER_SAFARI_AND_PRIVATE_BACKHAUL_UNVERIFIED",
    credentialsSent: false,
    redirectsFollowed: false,
    staging: { status: site.status, homepageStatus: home.status,
      anonymousRequestDenied: siteDenied, homepageRequestDenied: homeDenied,
      redirectToGoogleLogin: siteLogin, homepageRedirectToGoogleLogin: homeLogin },
    controlApi: { healthStatus: health.status, protectedReadStatus: guarded.status,
      unauthenticatedReadDenied: guardedRead },
    actualOwnerSafariSessionVerified: false,
    privateFleetTransportVerified: false,
  };
}

function parseCli(argv) {
  if (argv.length !== 5 || argv[0] !== "--live" ||
      argv[1] !== "--staging" || argv[3] !== "--api")
    throw new Error("required: --live --staging HTTPS_ORIGIN --api HTTPS_ORIGIN");
  return { stagingUrl: argv[2], apiUrl: argv[4] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = await inspectAnonymousBoundary(parseCli(process.argv.slice(2)));
    console.log(JSON.stringify(result));
    process.exitCode = result.status === "PASS_ANONYMOUS_DENIAL_ONLY" ? 0 : 2;
  } catch {
    console.log(JSON.stringify({schema: SCHEMA, status: "INVALID_OPERATOR_INPUT",
      releaseGate: "BLOCKED", credentialsSent: false}));
    process.exitCode = 2;
  }
}
