/**
 * Minimal path router. A dependency-free router keeps the Worker bundle small, which matters
 * directly: the free tier bounds CPU time per invocation.
 */

export type RouteParams = Record<string, string>;
export type Handler<Env, Ctx> = (
  request: Request,
  context: { env: Env; ctx: Ctx; params: RouteParams; url: URL },
) => Promise<Response> | Response;

interface Route<Env, Ctx> {
  method: string;
  segments: string[];
  handler: Handler<Env, Ctx>;
}

export class Router<Env, Ctx> {
  private readonly routes: Route<Env, Ctx>[] = [];

  add(method: string, pattern: string, handler: Handler<Env, Ctx>): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.split("/").filter((s) => s.length > 0),
      handler,
    });
    return this;
  }

  get(pattern: string, handler: Handler<Env, Ctx>): this {
    return this.add("GET", pattern, handler);
  }

  post(pattern: string, handler: Handler<Env, Ctx>): this {
    return this.add("POST", pattern, handler);
  }

  match(
    method: string,
    pathname: string,
  ): { handler: Handler<Env, Ctx>; params: RouteParams } | null {
    const pathSegments = pathname.split("/").filter((s) => s.length > 0);

    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      if (route.segments.length !== pathSegments.length) continue;

      const params: RouteParams = {};
      let matched = true;

      for (let i = 0; i < route.segments.length; i++) {
        const routeSegment = route.segments[i]!;
        const pathSegment = pathSegments[i]!;
        if (routeSegment.startsWith(":")) {
          params[routeSegment.slice(1)] = decodeURIComponent(pathSegment);
        } else if (routeSegment !== pathSegment) {
          matched = false;
          break;
        }
      }

      if (matched) return { handler: route.handler, params };
    }
    return null;
  }
}
