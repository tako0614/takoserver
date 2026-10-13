export default {
  async fetch() {
    return new Response("public-worker-bundle-v1\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
