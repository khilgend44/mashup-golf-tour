// Admin is served ONLY on the Access-gated pages.dev host. The custom domain
// (mashupgolf.com / www) is intentionally NOT in the Access application — a
// shared multi-hostname app canonicalized auth to the custom domain, which
// Zscaler blocks. So instead we bounce any /admin request on a non-pages.dev
// host to the gated pages.dev host. No admin content is served on the custom
// domain, and the pages.dev host is protected by Cloudflare Access + the
// in-code requireAccess check on /admin/api/*.
export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);
  // pages.dev hosts (production + preview deployments) serve normally.
  if (url.hostname.endsWith('.pages.dev')) return next();
  // Everything else (mashupgolf.com, www.mashupgolf.com, …) → gated pages.dev.
  return Response.redirect(`https://mashup-golf-tour.pages.dev${url.pathname}${url.search}`, 302);
}
