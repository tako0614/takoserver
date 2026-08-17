/**
 * The console's Worker.
 *
 * The console is a static bundle, so this hands every request straight to the
 * asset layer. That is not a formality: the asset layer is what resolves an
 * unknown path to the entry document, and a console whose deep links 404 on
 * reload is a console people stop linking to.
 *
 * A script that declares assets is always given this binding, so nothing has
 * to be declared for it to be here.
 */
export default {
  fetch(request: Request, env: { ASSETS: { fetch(request: Request): Promise<Response> } }) {
    return env.ASSETS.fetch(request);
  },
};
