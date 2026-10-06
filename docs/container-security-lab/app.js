const http = require("http");
const os = require("os");

const port = Number(process.env.PORT || 3000);

http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, {"Content-Type":"text/plain"});
    return res.end("OK\n");
  }

  if (req.url === "/") {
    const uid = typeof process.getuid === "function" ? process.getuid() : "n/a";
    res.writeHead(200, {"Content-Type":"text/plain"});
    return res.end([
      "Docker Container Security Lab",
      `Hostname: ${os.hostname()}`,
      `Effective UID: ${uid}`
    ].join("\n") + "\n");
  }

  res.writeHead(404);
  res.end("Not Found\n");
}).listen(port, "0.0.0.0", () => console.log(`Listening on ${port}`));
