// cloudfront-function.js
function handler(event) {
  var req = event.request;
  var host = (req.headers.host && req.headers.host.value) || "";
  var uri = req.uri || "/";

  // leftmost label = folderId ("<uuid>.<base_domain>")
  var dot = host.indexOf(".");
  if (dot <= 0) return req;
  var folder = host.substring(0, dot);

  // normalize path, append index.html for "/" or trailing "/"
  var path = uri.startsWith("/") ? uri : "/" + uri;
  if (path === "/" || path === "") path = "/index.html";
  else if (path.endsWith("/")) path = path + "index.html";

  // final mapping: "/<uuid>/<path...>"
  req.uri = "/" + folder + path;
  return req;
}
