import type { FastifyRequest } from 'fastify';

/**
 * The path a request counts as having, for every decision made by path.
 *
 * The router's answer, never the text of the URL. The router decodes a path before it
 * matches it, cuts it at `?` and `#`, and takes an absolute URL as well, so one route can
 * be written in many ways: anything that compares the URL with a path of its own misses
 * most of them. What reached no API route has no answer to take, and is read the way the
 * router reads it. A path that cannot be decoded never gets here: the router refuses it.
 */
export function requestPath(request: FastifyRequest): string {
  const route = request.routeOptions.url;
  if (route?.startsWith('/api/')) return route;

  return decodeURI(request.url.replace(/^https?:\/\/[^/]*/, '').split(/[?#]/, 1)[0]);
}

/** Whether a request is one to the API, under whichever spelling of its path. */
export function isApiRequest(request: FastifyRequest): boolean {
  return requestPath(request).startsWith('/api/');
}
