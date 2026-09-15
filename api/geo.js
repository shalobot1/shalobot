/**
 * WHERE THE VISITOR IS — one header, nothing else.
 *
 * Vercel stamps the requester's country on every request. The language layer
 * asks for it once per session, and only when the browser's own language did
 * not already decide, so an English-set browser in Brazil is offered
 * Portuguese. Nothing is stored; there is nothing here to store.
 */
module.exports = (req, res) => {
  const country = String(req.headers["x-vercel-ip-country"] || "").toUpperCase().slice(0, 2);
  res.setHeader("Cache-Control", "private, no-store");
  res.status(200).json({ country: /^[A-Z]{2}$/.test(country) ? country : "" });
};
