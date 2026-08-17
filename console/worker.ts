/**
 * The console's Worker.
 *
 * The console is a static bundle, and the asset layer answers everything that
 * matches a file — including unknown paths, which it resolves to the entry
 * document so a deep link survives a cold load. A Worker still has to exist for
 * a script to be published, and this is it.
 *
 * It answers only what the assets did not, which in practice is nothing. Saying
 * so plainly beats an empty handler that would make a real misconfiguration
 * look like a blank page.
 */
export default {
  fetch(): Response {
    return new Response("not found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
